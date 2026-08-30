// 真实行情下验证"流动性过滤 + 滑点成本"的集成测试（paper 盘）。
//
// 背景：本机没有 Redis / DataHub 天气数据，无法跑完整策略进程。这里用真实
// Polymarket 市场数据 + 真实订单簿深度，复现 MultiCityStrategy.buildCandidates
// 与 TradingDecisionEngine.decide 的决策路径，重点验证：
//   1. fetchOrderBookDepth 能拿到真实 bid/ask 深度与估算滑点；
//   2. 候选桶的 liquidityUsd / slippage 是否合理；
//   3. 决策引擎在 live 语义下对薄盘（流动性不足/滑点过高）的过滤与成本吸收。
//
// 概率分布是合成的（anchor/dispersion 可改），但市场价格与订单簿是真实的。
// 运行：HTTPS_PROXY=http://127.0.0.1:10808 npx tsx scripts/test-liquidity-slippage.ts
//
// 说明：实际生产 paper 模式不应用流动性过滤（过滤只在 live 生效），
// 本脚本用 TRADING_MODE=live 语义调用 decide，以展示过滤/滑点效果。

import 'dotenv/config';
import { PolymarketClient } from '../src/utils/polymarket-client.js';
import { TradingDecisionEngine } from '../src/strategies/TradingDecisionEngine.js';
import { loadCityConfig } from '../src/common/config-loader.js';
import { parseMarketQuestion, bucketProbability } from '../src/utils/market-buckets.js';
import { getCityDate, formatISODate, calculateHorizon, hoursToResolution } from '../src/utils/time.js';
import type { ProbabilityDistribution, ForecastHorizon } from '../src/common/types.js';

// 生效最低流动性（$）与最大可接受滑点，与决策引擎默认一致。
const MIN_LIQUIDITY_USD = Number(process.env.MIN_LIQUIDITY_USD ?? '100');
const MAX_SLIPPAGE = Number(process.env.MAX_SLIPPAGE ?? '0.05');
const REFERENCE_SIZE = 500;

const CITY = process.env.TEST_CITY ?? 'shanghai';
const TRADING_MODE: 'paper' | 'live' = (process.env.TEST_MODE ?? 'live') as 'paper' | 'live';

interface Row {
  label: string;
  question: string;
  yesPrice: number;
  volumeUsd: number;
  yesTokenId?: string;
}

function parseYesTokenId(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const ids = JSON.parse(raw) as string[];
    return ids[0];
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const polymarket = new PolymarketClient();
  const cityConfig = loadCityConfig(CITY as never);
  const engine = new TradingDecisionEngine(cityConfig);

  // 1. 发现真实目标市场。生产只考虑 D-3/D-2 入场，但本机此刻 D-2/D-3 尚未上架，
  //    回退到 D-1/D-0 以便用真实订单簿验证流动性/滑点路径。
  const cityDate = getCityDate(cityConfig.timezone);
  let target: { targetDate: string; horizon: ForecastHorizon; hoursLeft: number } | null = null;
  let markets = [];
  for (const dayOffset of [3, 2, 1, 0]) {
    const d = new Date(cityDate);
    d.setDate(d.getDate() + dayOffset);
    const targetDate = formatISODate(d);
    const [y, m, day] = targetDate.split('-').map(Number);
    const event = await polymarket.findEventBySlug(cityConfig.city, y!, m!, day!);
    if (!event) continue;
    const endDate = event.endDate ?? '';
    const hoursLeft = endDate ? hoursToResolution(endDate) : 0;
    if (hoursLeft <= 0 || hoursLeft < 2 || hoursLeft > 80) continue;
    target = { targetDate, horizon: calculateHorizon(targetDate, cityConfig.timezone), hoursLeft };
    markets = event.markets ?? [];
    break;
  }

  if (!target) {
    console.log('未来 2-3 天未发现可入场的真实上海温度市场（可能不在上架窗口）。');
    return;
  }
  console.log(`发现目标市场 ${cityConfig.city} @ ${target.targetDate} (${target.horizon}, ${target.hoursLeft.toFixed(1)}h)，市场数=${markets.length}`);

  // 2. 解析市场桶行（与生产 parseMarketPrices 一致）。
  const rows: Row[] = [];
  for (const m of markets) {
    const q = m.question ?? '';
    const parsed = parseMarketQuestion(q);
    if (!parsed) continue;
    let yesPrice = Number(m.bestAsk) || 0;
    if (!yesPrice) {
      try { yesPrice = Number(JSON.parse(m.outcomePrices ?? '[]')[0]) || 0; } catch { yesPrice = 0; }
    }
    if (!(yesPrice > 0 && yesPrice < 1)) continue;
    const row: Row = { label: parsed.bucket.label, question: q, yesPrice, volumeUsd: Number(m.volume) || 0 };
    const tok = parseYesTokenId(m.clobTokenIds);
    if (tok) row.yesTokenId = tok;
    rows.push(row);
  }

  // 3. 构造合成分布（anchor 可调）。真实分布来自 Redis/DataHub，本机不具备。
  const anchor = Number(process.env.TEST_ANCHOR ?? '33.5');
  const dispersion = Number(process.env.TEST_DISPERSION ?? '2.0');
  const distribution: ProbabilityDistribution = {
    city: CITY as never,
    targetStation: cityConfig.settlementStation.stationId,
    horizon: target.horizon,
    correctedAnchorTempC: anchor,
    dispersionC: dispersion,
    consensusLevel: 0.8,
    buckets: [],
    sourceContributions: [],
  };

  // 4. 构建候选桶（与生产 buildCandidates 一致）：真实订单簿深度 + 滑点。
  //    排除开放桶；模型概率 > 0.15 才成为候选。
  const candidates = [];
  let skippedOpen = 0;
  for (const r of rows) {
    const parsed = parseMarketQuestion(r.question);
    if (!parsed) continue;
    if (parsed.isLow || parsed.isHigh) { skippedOpen += 1; continue; }
    const p = bucketProbability(parsed.bucket, anchor, dispersion);
    if (!(p > 0.15)) continue;
    let liquidityUsd = 0;
    let slippage = 0;
    if (r.yesTokenId) {
      const depth = await polymarket.fetchOrderBookDepth(r.yesTokenId, REFERENCE_SIZE);
      if (depth) {
        liquidityUsd = depth.liquidityUsd;
        slippage = depth.slippage;
      }
    }
    candidates.push({
      bucket: parsed.bucket,
      modelProbability: p,
      yesPrice: r.yesPrice,
      noPrice: Math.min(0.999, Math.max(0.001, 1 - r.yesPrice)),
      volumeUsd: r.volumeUsd,
      orderBookImbalance: 0,
      liquidityUsd,
      slippage,
      spatialConfidence: 0.6,
    });
  }

  console.log(`\n===== 候选桶明细（真实订单簿深度，mode=${TRADING_MODE}）=====`);
  console.log(`anchor=${anchor}C dispersion=${dispersion}C referenceSize=${REFERENCE_SIZE}$ minLiquidity=${MIN_LIQUIDITY_USD}$ maxSlippage=${(MAX_SLIPPAGE * 100).toFixed(0)}%`);
  console.log('bucket'.padEnd(10), 'modelP'.padEnd(8), 'yesPx'.padEnd(7), 'vol$'.padEnd(8), 'liquidity$'.padEnd(12), 'slippage'.padEnd(9), 'passLiquidity'.padEnd(13), 'passSlippage');
  for (const c of candidates) {
    const liq = c.liquidityUsd ?? 0;
    const slp = c.slippage ?? 0;
    const passLiq = TRADING_MODE === 'live' ? liq >= MIN_LIQUIDITY_USD : true;
    const passSlp = TRADING_MODE === 'live' ? slp <= MAX_SLIPPAGE : true;
    console.log(
      c.bucket.label.padEnd(10),
      c.modelProbability.toFixed(3).padEnd(8),
      c.yesPrice.toFixed(2).padEnd(7),
      c.volumeUsd.toFixed(0).padEnd(8),
      liq.toFixed(0).padEnd(12),
      (slp * 100).toFixed(1).concat('%').padEnd(9),
      (passLiq ? 'OK' : 'REJECT').padEnd(13),
      (passSlp ? 'OK' : 'REJECT'),
    );
  }

  if (candidates.length === 0) {
    console.log('\n没有通过候选构建的桶。');
    return;
  }

  // 5. 决策引擎（用 live 语义展示过滤/滑点）。
  const decision = engine.decide({
    city: CITY as never,
    horizon: target.horizon,
    distribution,
    candidates,
    tradingMode: TRADING_MODE,
    bankrollUsd: 1000,
  });

  console.log('\n===== 决策结果 =====');
  if (!decision) {
    console.log('决策引擎返回 null：未选出交易（可能被流动性/滑点/凯利/成本过滤拦截）。');
  } else {
    console.log(`选中桶: ${decision.buckets.map((b) => b.label).join(' + ')}`);
    console.log(`entryPrice: ${decision.entryPrice.toFixed(3)}`);
    console.log(`sizeUsd: ${decision.sizeUsd.toFixed(2)}`);
    console.log(`kellyFraction: ${decision.kellyFraction.toFixed(4)}`);
    console.log(`reason: ${decision.reason}`);
  }

  console.log('\n说明：概率分布为合成值（无 Redis/DataHub），仅市场价格与订单簿为真实数据。');
}

main().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});