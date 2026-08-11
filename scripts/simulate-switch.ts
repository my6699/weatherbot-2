// 换仓策略模拟器（2026-08-09，实验脚本，paper 判定不真下单）。
//
// 对当前所有未结算 paper 持仓，模拟"是否触发 D1 换仓"：
//   1. 读 Redis 中该持仓目标日期对应的最新预测分布（d1/d2/d3）；
//   2. 算旧桶对模型区间概率（pSum）；
//   3. 若 pSum ≤ SWITCH_THRESHOLD，拉 Polymarket 实时行情重建候选桶，
//      用生产决策引擎选新桶对；
//   4. 新桶对 ≠ 旧桶对 → 判定"会换仓"，并输出卖出/买入参考价。
//
// 用法：
//   npx tsx scripts/simulate-switch.ts                    （阈值 0.30）
//   SWITCH_THRESHOLD=0.3 npx tsx scripts/simulate-switch.ts

import { createRedisClient, readWeatherData } from '../src/data/redis-config.js';
import { TradingDecisionEngine } from '../src/strategies/TradingDecisionEngine.js';
import type { CandidateBucket } from '../src/strategies/TradingDecisionEngine.js';
import { PolymarketClient } from '../src/utils/polymarket-client.js';
import type { GammaMarket } from '../src/utils/polymarket-client.js';
import { readTrades } from '../src/utils/trade-recorder.js';
import { getCityDate, formatISODate } from '../src/utils/time.js';
import { loadEnv, loadAllCityConfigs } from '../src/common/config-loader.js';
import { createModuleLogger } from '../src/common/logger.js';
import type {
  ProbabilityDistribution,
  ForecastHorizon,
  TemperatureBucket,
  CityId,
} from '../src/common/types.js';

const logger = createModuleLogger('SimulateSwitch');

const SWITCH_THRESHOLD = Number(process.env.SWITCH_THRESHOLD ?? '0.30');

interface MarketPriceRow {
  tempC: number;
  yesPrice: number;
  noPrice: number;
  bid: number;
  volumeUsd: number;
  isLow: boolean; // "or below" 开放低桶
  isHigh: boolean; // "or higher" 开放高桶
}

function parseMarketPrices(markets: GammaMarket[]): MarketPriceRow[] {
  const rows: MarketPriceRow[] = [];
  for (const m of markets) {
    const q = m.question ?? '';
    const match = q.match(/(\d+)\s*°([CF])/);
    if (!match) continue;
    const temp = Number(match[1]);
    const tempC = match[2] === 'F' ? ((temp - 32) * 5) / 9 : temp;
    const yesPrice = Number(m.bestAsk) || parseOutcomePrice(m.outcomePrices, 0);
    if (!(yesPrice > 0 && yesPrice < 1)) continue;
    rows.push({
      tempC,
      yesPrice,
      noPrice: Math.min(0.999, Math.max(0.001, 1 - yesPrice)),
      bid: Number(m.bestBid) || 0,
      volumeUsd: Number(m.volume) || 0,
      isLow: /or below/i.test(q),
      isHigh: /or higher/i.test(q),
    });
  }
  return rows;
}

function parseOutcomePrice(outcomePrices: unknown, index: number): number {
  try {
    const arr = JSON.parse(outcomePrices as string) as number[];
    return Number(arr[index]);
  } catch {
    return 0;
  }
}

function marketPriceFor(bucket: TemperatureBucket, rows: MarketPriceRow[]): MarketPriceRow | null {
  if (bucket.minTempC === null) {
    return rows.find((r) => r.isLow) ?? null;
  }
  if (bucket.maxTempC === null) {
    return rows.find((r) => r.isHigh) ?? null;
  }
  const center = (bucket.minTempC + bucket.maxTempC) / 2;
  let best: MarketPriceRow | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    if (r.isLow || r.isHigh) continue;
    const d = Math.abs(r.tempC - center);
    if (d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  return best;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const cityConfigs = loadAllCityConfigs();
  const redis = createRedisClient();
  await redis.connect();
  const pm = new PolymarketClient();

  let totalOpen = 0;
  let checked = 0;
  let wouldSwitch = 0;
  const report: string[] = [];

  for (const city of cityConfigs) {
    const trades = readTrades(city.city);
    const open = trades.filter((t) => t.status === 'open');
    if (open.length === 0) continue;

    for (const t of open) {
      totalOpen += 1;
      const targetDate = t.targetDate ?? '';
      if (!targetDate) continue;

      // 目标日期相对今天（城市时区）的水平段：d1/d2/d3。
      const cityDate = formatISODate(getCityDate(city.timezone));
      const t0 = new Date(`${cityDate}T00:00:00Z`);
      const tg = new Date(`${targetDate}T00:00:00Z`);
      const dayDiff = Math.round((tg.getTime() - t0.getTime()) / 86400000);
      if (dayDiff < 1 || dayDiff > 3) {
        report.push(`  ${city.city} ${targetDate}：距结算 ${dayDiff}d，不在 d1-d3 检查窗口`);
        continue;
      }
      const horizon = `d${dayDiff}` as ForecastHorizon;

      const payload = await readWeatherData(redis, env.REDIS_KEY_PREFIX, city.city, horizon);
      if (!payload) {
        report.push(`  ${city.city} ${targetDate}（d${dayDiff}）：Redis 无分布数据`);
        continue;
      }
      const dist: ProbabilityDistribution = payload.probability;
      checked += 1;

      const oldKeys = t.buckets ?? [];
      const oldPSum = dist.buckets
        .filter((b) => oldKeys.includes(b.bucket.label))
        .reduce((s, b) => s + b.probability, 0);

      // 拉实时行情，重建候选 + 决策引擎选新桶。
      const [y, m, d] = targetDate.split('-').map(Number);
      const event = await pm.findEventBySlug(city.city, y!, m!, d!);
      if (!event) {
        report.push(`  ${city.city} ${targetDate}：Polymarket 无事件`);
        continue;
      }
      const rows = parseMarketPrices(event.markets ?? []);
      const candidates: CandidateBucket[] = dist.buckets
        .filter((b) => b.probability > 0.15)
        .map((b) => {
          const row = marketPriceFor(b.bucket, rows);
          return {
            bucket: b.bucket,
            modelProbability: b.probability,
            yesPrice: row?.yesPrice ?? 0.5,
            noPrice: row?.noPrice ?? 0.5,
            volumeUsd: row?.volumeUsd ?? 0,
            orderBookImbalance: 0,
            spatialConfidence: 0.5,
          };
        });
      const engine = new TradingDecisionEngine(city);
      const decision = engine.decide({
        city: city.city as CityId,
        horizon,
        distribution: dist,
        candidates,
        tradingMode: 'paper',
      });
      const newKeys = decision ? decision.buckets.map((b) => b.label) : null;
      const same =
        newKeys !== null &&
        newKeys.length === oldKeys.length &&
        newKeys.every((k, i) => k === oldKeys[i]);

      // 换仓参考价：旧桶卖价 / 新桶买价（当前 bestAsk 近似）。
      const sell = oldKeys
        .map((k) => rows.find((r) => r.isLow && k.startsWith('<=')) ?? marketPriceByLabel(k, rows))
        .filter((r): r is MarketPriceRow => r !== null && r !== undefined)
        .reduce((s, r) => s + r.yesPrice, 0);
      const buy = (newKeys ?? [])
        .map((k) => rows.find((r) => r.isLow && k.startsWith('<=')) ?? marketPriceByLabel(k, rows))
        .filter((r): r is MarketPriceRow => r !== null && r !== undefined)
        .reduce((s, r) => s + r.yesPrice, 0);

      if (newKeys && !same && oldPSum <= SWITCH_THRESHOLD) {
        wouldSwitch += 1;
        report.push(
          `  ✅ 会换仓 ${city.city} ${targetDate}（d${dayDiff}） ${oldKeys.join('+')}→${newKeys.join('+')}  pSum=${oldPSum.toFixed(3)}  卖旧≈$${sell.toFixed(3)} 买新≈$${buy.toFixed(3)}`,
        );
      } else {
        const reason = oldPSum > SWITCH_THRESHOLD ? `pSum 超阈值` : newKeys ? '新桶=旧桶' : '无新桶';
        report.push(
          `  ❌ 不换   ${city.city} ${targetDate}（d${dayDiff}） ${oldKeys.join('+')}  pSum=${oldPSum.toFixed(3)}  (${reason})`,
        );
      }
    }
  }

  await redis.quit();

  logger.info('========== 换仓模拟结果 ==========');
  logger.info('样本', { openPositions: totalOpen, checked, wouldSwitch, threshold: SWITCH_THRESHOLD });
  for (const line of report) {
    console.log(line);
  }
}

/** 按 label 匹配市场价格行（兼容 "27-27" 与 "27" 两种 label 写法）。 */
function marketPriceByLabel(label: string, rows: MarketPriceRow[]): MarketPriceRow | null {
  const n = label.replace(/[^\d.-]/g, '');
  if (!n) return null;
  const temp = Number(n);
  for (const r of rows) {
    if (Math.abs(r.tempC - temp) < 0.5 && !r.isLow && !r.isHigh) return r;
  }
  return null;
}

void main().catch((err) => {
  logger.error('模拟失败', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
