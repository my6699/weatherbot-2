// 前瞻凯利资金模拟：用最新的模型预测分布（Redis）+ 实时市场行情（Gamma），
// 按生产凯利资金配置（资金池 100U × f* × 1/4，单笔 ≤30U，f*≤0 不开、不足 5 股不开）
// 模拟"未来 D+3/D+2 可开仓机会"的资金分配，并与已有 open 持仓的凯利占用合并统计。
//
// 运行（必须在服务器上，需访问 Redis + Gamma API）：
//   npx tsx scripts/forward-kelly-sim.ts
//   BANKROLL_USD=100 npx tsx scripts/forward-kelly-sim.ts
//
// 输出：
//   1) 已有 open 持仓：按凯利重算的资金占用（reason 解析模型概率）
//   2) 未来市场：最新分布 + 实时行情跑决策引擎，凯利投入
//   3) 汇总：总占用 ≤ 资金池验证 + 剩余资金 + 拦截明细

import fs from 'node:fs';
import path from 'node:path';
import {
  createRedisClient,
  readWeatherData,
} from '../src/data/redis-config.js';
import {
  loadAllCityConfigs,
  loadCityConfig,
} from '../src/common/config-loader.js';
import { PolymarketClient } from '../src/utils/polymarket-client.js';
import { TradingDecisionEngine } from '../src/strategies/TradingDecisionEngine.js';
import type { CandidateBucket } from '../src/strategies/TradingDecisionEngine.js';
import { parseMarketQuestion, bucketProbability } from '../src/utils/market-buckets.js';
import { readTrades } from '../src/utils/trade-recorder.js';
import {
  getCityDate,
  formatISODate,
  hoursToResolution,
  calculateHorizon,
} from '../src/utils/time.js';
import type {
  CityId,
  ForecastHorizon,
  ProbabilityDistribution,
  TemperatureBucket,
} from '../src/common/types.js';

const BANKROLL_USD = Number(process.env.BANKROLL_USD ?? '100');
const KELLY_FRACTION = Number(process.env.KELLY_FRACTION ?? '0.25');
const MAX_POSITION_USD = 30; // 与 config/*.json maxPositionUsd 一致
const MIN_SHARES = 5; // CLOB 最小下单股数
const MIN_ENTRY_HOURS = 2;
const MAX_ENTRY_HOURS = 80;

// ==================== 纯函数：市场解析 / 候选构建（对齐 MultiCityStrategy） ====================

interface MarketPriceRow {
  bucket: TemperatureBucket;
  yesPrice: number;
  noPrice: number;
  bid: number;
  volumeUsd: number;
  isLow: boolean;
  isHigh: boolean;
}

function parseOutcomePrice(outcomePrices: unknown, index: number): number {
  try {
    const arr = JSON.parse(outcomePrices as string) as number[];
    return Number(arr[index]);
  } catch {
    return 0;
  }
}

function parseMarketPrices(markets: { question?: string; bestAsk?: string; outcomePrices?: string; bestBid?: string; volume?: string }[]): MarketPriceRow[] {
  const rows: MarketPriceRow[] = [];
  for (const m of markets) {
    const q = m.question ?? '';
    const parsed = parseMarketQuestion(q);
    if (!parsed) continue;
    const yesPrice = Number(m.bestAsk) || parseOutcomePrice(m.outcomePrices, 0);
    if (!(yesPrice > 0 && yesPrice < 1)) continue;
    rows.push({
      bucket: parsed.bucket,
      yesPrice,
      noPrice: Math.min(0.999, Math.max(0.001, 1 - yesPrice)),
      bid: Number(m.bestBid) || 0,
      volumeUsd: Number(m.volume) || 0,
      isLow: parsed.isLow,
      isHigh: parsed.isHigh,
    });
  }
  return rows;
}

function buildCandidates(distribution: ProbabilityDistribution, markets: { question?: string; bestAsk?: string; outcomePrices?: string; bestBid?: string; volume?: string }[]): CandidateBucket[] {
  const rows = parseMarketPrices(markets);
  const anchor = distribution.correctedAnchorTempC;
  const sigma = distribution.dispersionC;
  const candidates: CandidateBucket[] = [];
  for (const r of rows) {
    if (r.isLow || r.isHigh) continue;
    const p = bucketProbability(r.bucket, anchor, sigma);
    if (!(p > 0.15)) continue;
    candidates.push({
      bucket: r.bucket,
      modelProbability: p,
      yesPrice: r.yesPrice,
      noPrice: r.noPrice,
      volumeUsd: r.volumeUsd,
      orderBookImbalance: 0,
      spatialConfidence: 0.5,
    });
  }
  return candidates;
}

function rawKellyFraction(nBuckets: number, p: number, c: number): number {
  const denom = nBuckets - c;
  return denom > 0 ? (nBuckets * p - c) / denom : 0;
}

function kellySizeUsd(nBuckets: number, p: number, c: number, bankroll: number): number | null {
  const f = rawKellyFraction(nBuckets, p, c);
  if (f <= 0) return null;
  const size = Math.min(bankroll * f * KELLY_FRACTION, MAX_POSITION_USD);
  if (size < MIN_SHARES * c) return null; // 不足 5 股
  return size;
}

// ==================== 主流程 ====================

interface OpenRow {
  city: string;
  targetDate: string;
  buckets: string;
  entryPrice: number;
  p: number | null;
  f: number;
  kellyUsd: number | null; // null = 未投（f*≤0 或不足 5 股或 p 未解析）
  note: string;
}

interface FutureRow {
  city: string;
  targetDate: string;
  horizon: ForecastHorizon;
  buckets: string;
  entryPrice: number;
  p: number;
  edge: number;
  kellyUsd: number | null;
  remaining: number;
  note: string;
}

function parseProbFromReason(reason: string | undefined, nBuckets: number): number | null {
  const r = reason ?? '';
  const pair = /区间概率\s*(\d+)%/.exec(r);
  if (pair) return Number(pair[1]) / 100;
  const model = /模型\s*(\d+)%/.exec(r);
  if (model) return Number(model[1]) / 100;
  return null;
}

function fmtUsd(v: number | null): string {
  return v == null ? '不开' : `$${v.toFixed(1)}`;
}

async function main(): Promise<void> {
  const configs = loadAllCityConfigs();
  const redis = createRedisClient();
  await redis.connect();
  const pm = new PolymarketClient();
  const prefix = process.env.REDIS_KEY_PREFIX ?? 'weather';

  // ---------- 1. 已有 open 持仓的凯利占用（按 openedAt 重放，bankroll 递减） ----------
  let bankroll = BANKROLL_USD;
  const openRows: OpenRow[] = [];
  const opens: Array<{ city: string; targetDate: string; openedAt: string; buckets: string[]; entryPrice: number; reason?: string }> = [];
  for (const cfg of configs) {
    for (const t of readTrades(cfg.city)) {
      if (t.status !== 'open') continue;
      opens.push({
        city: t.city,
        targetDate: t.targetDate ?? '',
        openedAt: t.openedAt ?? '',
        buckets: t.buckets ?? [],
        entryPrice: t.entryPrice ?? 0,
        reason: t.reason,
      });
    }
  }
  opens.sort((a, b) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime());
  for (const t of opens) {
    const n = Math.max(t.buckets.length, 1);
    const p = parseProbFromReason(t.reason, n);
    if (p == null) {
      openRows.push({ city: t.city, targetDate: t.targetDate ?? '', buckets: t.buckets.join('+'), entryPrice: t.entryPrice, p: null, f: 0, kellyUsd: null, note: 'p未解析' });
      continue;
    }
    const f = rawKellyFraction(n, p, t.entryPrice);
    const size = kellySizeUsd(n, p, t.entryPrice, bankroll);
    openRows.push({
      city: t.city,
      targetDate: t.targetDate ?? '',
      buckets: t.buckets.join('+'),
      entryPrice: t.entryPrice,
      p,
      f,
      kellyUsd: size,
      note: size == null ? (f <= 0 ? 'f*≤0 负期望' : '不足5股') : '',
    });
    if (size != null) {
      bankroll -= size;
    }
  }

  // ---------- 2. 未来 D+3/D+2 市场：最新分布 + 实时行情跑凯利决策 ----------
  const futureRows: FutureRow[] = [];
  for (const cfg of configs) {
    const city = cfg.city;
    const engine = new TradingDecisionEngine(cfg);
    const cityDate = getCityDate(cfg.timezone);
    // 每个城市的目标日期（已有持仓的目标日期跳过新开）。
    const openDates = new Set(
      readTrades(city).filter((t) => t.status === 'open').map((t) => t.targetDate),
    );

    for (const dayOffset of [3, 2]) {
      const target = new Date(cityDate);
      target.setDate(target.getDate() + dayOffset);
      const targetDate = formatISODate(target);
      if (openDates.has(targetDate)) continue;
      const [y, m, d] = targetDate.split('-').map(Number);

      let event;
      try {
        event = await pm.findEventBySlug(city, y!, m!, d!);
      } catch {
        continue;
      }
      if (!event) continue;
      const endDate = event.endDate ?? '';
      const hoursLeft = endDate ? hoursToResolution(endDate) : 0;
      if (hoursLeft <= 0) continue;
      if (hoursLeft < MIN_ENTRY_HOURS || hoursLeft > MAX_ENTRY_HOURS) continue;
      const horizon = calculateHorizon(targetDate, cfg.timezone) as ForecastHorizon;

      const weather = await readWeatherData(redis, prefix, city, horizon);
      if (!weather) continue;
      const candidates = buildCandidates(weather.probability, event.markets ?? []);
      if (candidates.length === 0) continue;

      const decision = engine.decide({
        city,
        horizon,
        distribution: weather.probability,
        candidates,
        tradingMode: 'paper',
        bankrollUsd: Math.max(0, bankroll),
      });
      if (!decision) continue;

      const buckets = decision.buckets.map((b) => b.label).join('+');
      const p = decision.buckets.reduce((s, b) => {
        const c = candidates.find((x) => x.bucket.label === b.label);
        return s + (c?.modelProbability ?? 0);
      }, 0);
      const n = decision.buckets.length;
      const f = rawKellyFraction(n, p, decision.entryPrice);
      const size = kellySizeUsd(n, p, decision.entryPrice, Math.max(0, bankroll));
      futureRows.push({
        city,
        targetDate,
        horizon,
        buckets,
        entryPrice: decision.entryPrice,
        p,
        edge: p - decision.entryPrice,
        kellyUsd: size,
        remaining: bankroll,
        note: size == null ? (f <= 0 ? 'f*≤0 负期望' : '不足5股') : '',
      });
      if (size != null) bankroll -= size;
    }
  }
  await redis.quit();

  // ---------- 3. 输出 ----------
  console.log(`\n===== 前瞻凯利资金模拟（${BANKROLL_USD}U 资金池） =====`);
  console.log(`参数：资金池=${BANKROLL_USD}U, 凯利系数=${KELLY_FRACTION}, 单笔上限=${MAX_POSITION_USD}U, 最小=${MIN_SHARES}股\n`);

  console.log('--- 1) 已有 open 持仓（凯利重算占用） ---');
  const h1 = ['城市', '目标日', '桶', '成本', '模型p', 'f*', '凯利占用', '备注'];
  const d1 = openRows.map((r) => [r.city, r.targetDate.slice(5), r.buckets, r.entryPrice.toFixed(3), r.p != null ? `${(r.p * 100).toFixed(0)}%` : '?', r.p != null ? r.f.toFixed(3) : '—', fmtUsd(r.kellyUsd), r.note]);
  const w1 = h1.map((x, i) => Math.max(x.length, ...d1.map((r) => r[i]!.length)));
  const f1 = (cells: string[]) => cells.map((x, i) => x.padEnd(w1[i]!)).join(' | ');
  console.log(f1(h1));
  console.log('-'.repeat(w1.reduce((a, b) => a + b, 0) + (w1.length - 1) * 3));
  for (const r of d1) console.log(f1(r));

  console.log('\n--- 2) 未来 D+3/D+2 可开仓机会（凯利投入） ---');
  const h2 = ['城市', '目标日', '水平段', '桶', '成本', '模型p', 'edge', '凯利投入', '剩余资金', '备注'];
  const d2 = futureRows.map((r) => [r.city, r.targetDate.slice(5), r.horizon, r.buckets, r.entryPrice.toFixed(3), `${(r.p * 100).toFixed(0)}%`, `${(r.edge * 100).toFixed(1)}%`, fmtUsd(r.kellyUsd), `$${r.remaining.toFixed(1)}`, r.note]);
  const w2 = h2.map((x, i) => Math.max(x.length, ...d2.map((r) => r[i]!.length)));
  const f2 = (cells: string[]) => cells.map((x, i) => x.padEnd(w2[i]!)).join(' | ');
  console.log(f2(h2));
  console.log('-'.repeat(w2.reduce((a, b) => a + b, 0) + (w2.length - 1) * 3));
  for (const r of d2) console.log(f2(r));

  // ---------- 汇总 ----------
  const openUsed = openRows.reduce((s, r) => s + (r.kellyUsd ?? 0), 0);
  const futureUsed = futureRows.reduce((s, r) => s + (r.kellyUsd ?? 0), 0);
  const openBlocked = openRows.filter((r) => r.kellyUsd == null && r.p != null).length;
  const futureBlocked = futureRows.filter((r) => r.kellyUsd == null).length;
  const openOpened = openRows.filter((r) => r.kellyUsd != null).length;
  const futureOpened = futureRows.filter((r) => r.kellyUsd != null).length;

  console.log('\n===== 汇总 =====');
  console.log(`已有持仓：${openRows.length} 笔（开 ${openOpened} 笔，拦截/跳过 ${openBlocked} 笔），凯利占用 $${openUsed.toFixed(1)}`);
  console.log(`未来机会：${futureRows.length} 个（可开 ${futureOpened} 个，拦截/跳过 ${futureBlocked} 个），凯利投入 $${futureUsed.toFixed(1)}`);
  const totalUsed = openUsed + futureUsed;
  console.log(`总占用：$${totalUsed.toFixed(1)}，剩余 $${(BANKROLL_USD - totalUsed).toFixed(1)}`);
  console.log(`收敛：$${totalUsed.toFixed(1)} ${totalUsed <= BANKROLL_USD + 0.01 ? `≤ ${BANKROLL_USD}U ✅` : `> ${BANKROLL_USD}U ❌`}`);
}

main().catch((err) => {
  console.error('前瞻模拟失败：', err);
  process.exit(1);
});
