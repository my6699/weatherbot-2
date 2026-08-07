// 这个文件是本地 paper trading 模拟脚本（不连网络、不连 Redis、不真实下单）。
//
// 目的：用旧项目（polymarket-weather-bot）积累的上海历史市场数据，
// 完整走一遍 weather-2 的决策流水线，验证逻辑是否正确：
//
//   1. 从历史 JSON 恢复每个快照的多源预报（ecmwf / gfs / icon，对应旧数据的 ens.models）
//   2. 城市独立偏差（BiasCharacterizationLibrary，历史样本不足时返回 null 不做修正）
//   3. 温度桶概率分布（AdaptiveProbabilityEngine，直接用原始预报，空间修正已停用）
//   4. 双桶区间选桶（TradingDecisionEngine，选相邻两桶 + 交易量过滤）
//   5. paper 记录：首个命中选桶的快照作为模拟入场点
//   6. 命中验证：对比 actual_temp 是否落在选中区间内
//   7. 0.85 退出验证：用旧项目 market_snapshots 的 top2 数据判断是否达到退出目标
//   8. 真实入场价：用 market_snapshots 逐快照的 top1/top2 真实价格恢复入场成本
//      （已结算市场的 all_outcomes 是结算价，不能当入场成本）
//
// 运行方式（在 weather-bot 目录下）：
//   npx tsx scripts/simulate-paper-trading.ts
//
// 输出：每个快照一行诊断日志 + 每市场最终入场结果 + 汇总命中率与盈亏。
//
// 已知限制：已结算市场只有 top1/top2 的真实价格快照，若目标桶对从未成为 top1/top2，
// 无法恢复其真实早期价格（entryPrice = null）；未结算市场的 all_outcomes 是真实价格。

import fs from 'node:fs';
import path from 'node:path';
import type {
  StandardizedForecast,
  SpatialCorrectionResult,
  ProbabilityDistribution,
  ForecastHorizon,
  CityId,
} from '../src/common/types.js';
import { loadAppConfig } from '../src/common/config-loader.js';
import { BiasCharacterizationLibrary } from '../src/data/BiasCharacterizationLibrary.js';
import { AdaptiveProbabilityEngine } from '../src/data/AdaptiveProbabilityEngine.js';
import { TradingDecisionEngine, type CandidateBucket } from '../src/strategies/TradingDecisionEngine.js';
import { createModuleLogger } from '../src/common/logger.js';

const logger = createModuleLogger('SimulatePaperTrading');

// 旧项目的数据目录（相对于当前脚本运行目录）。
const OLD_DATA_DIR = path.resolve(
  process.cwd(),
  '..', '..', 'weather-bot', 'polymarket-weather-bot', 'data', 'markets',
);

// 旧数据源 id → weather-2 的 sourceId。
const SOURCE_MAP: Record<string, string> = {
  ecmwf_ifs025: 'open-meteo-ecmwf',
  gfs_seamless: 'open-meteo-gfs',
  icon_seamless: 'open-meteo-icon',
};

// 旧快照 horizon（D+2/D+1/D+0）→ weather-2 的 ForecastHorizon。
const HORIZON_MAP: Record<string, ForecastHorizon> = {
  'D+3': 'd3',
  'D+2': 'd2',
  'D+1': 'd1',
  'D+0': 'd0',
};

// 旧 all_outcomes 的桶（按范围 [lo, hi]）→ weather-2 的桶 label。
function mapOldRangeToBucketLabel(lo: number, hi: number): string | null {
  if (hi <= 30) return '<=30';
  if (lo >= 37) return '>=37';
  if (lo === hi && lo >= 31 && lo <= 36) return String(lo);
  return null; // 无法精确映射的跳过
}

// 旧 all_outcomes 的价格 → 市场价（加权到各桶）。
interface MarketPrice {
  yesPrice: number;
  volumeUsd: number;
  imbalance: number; // 用 bid/ask 距离近似订单簿失衡
}

interface OldMarketFile {
  city: string;
  date: string;
  status: string;
  actual_temp: number | null;
  forecast_snapshots: Array<{
    ts: string;
    horizon: string;
    metar?: number | null; // ZSPD 主站历史 METAR 实测（℃），旧项目已缓存
    ens?: {
      models?: Record<string, number>;
    };
  }>;
  // 旧项目的时间序列快照：记录相邻桶对（top2_bucket）的价格之和（top2_sum）。
  // 用于验证双桶区间策略的 0.85 退出条件是否会在 D0 前触发。
  market_snapshots?: Array<{
    ts: string;
    top_bucket?: string;
    top_price?: number;
    top2_bucket?: string;
    top2_price?: number;
    top2_sum?: number;
  }>;
  all_outcomes?: Array<{
    range: [number, number];
    bid: number;
    ask: number;
    price: number;
    volume: number;
  }>;
}

interface SimEntry {
  marketId: string; // city_date
  // 选中的桶（双桶区间策略时为相邻两个桶，回退单桶时为一个桶）。
  bucketLabels: string[];
  // 真实入场成本（$）：
  //   - 优先用 market_snapshots：双桶取"首次成为市场最热相邻对(top2)"时的
  //     top2_sum（两桶真实价格之和）；单桶取"首次成为最贵桶(top1)"时的 top_price。
  //     top2_sum >= 0.99 视为结算后污染，跳过。
  //   - 兜底用未结算市场（status != resolved）all_outcomes 的真实价格
  //   - null = 已结算市场且目标桶对从未成为 top1/top2，无真实早期价格可恢复
  entryPrice: number | null;
  entrySource: 'snapshot' | 'all_outcomes' | null;
  // 入场对应的市场快照时间（退出搜索从入场之后开始）；null = 来自 all_outcomes。
  entryTs: string | null;
  // 真实退出价（$）：双桶 = 入场后首次达成 top2_sum >= 0.85 时的快照价，
  // 否则按结算赔付（命中 1.0 / 未命中 0.0）；单桶 = 按结算赔付。
  exitPrice: number | null;
  // 估算盈亏 = exitPrice − entryPrice；任一缺失则 null。
  profit: number | null;
  horizon: ForecastHorizon;
  actualTemp: number | null;
  hit: boolean | null; // null = 无 actual_temp 无法验证
  // 双桶区间退出目标是否达成：两桶 bid 之和 >= 0.85（用旧项目 market_snapshots 验证）。
  exitReached: boolean | null;
  selector: 'factor7' | 'maxProb'; // 选桶方式：决策引擎 or 纯模型概率
}

async function main(): Promise<void> {
  const config = loadAppConfig('shanghai');
  const city = config.city;

  // 准备各模块实例（复用生产代码，验证真实逻辑）。
  const biasLibrary = new BiasCharacterizationLibrary(city.city as CityId, config.projectRoot);
  const probEngine = new AdaptiveProbabilityEngine(city.city as CityId, city.settlementStation.stationId, city.buckets);
  const decisionEngine = new TradingDecisionEngine(city);

  const sourceWeights = new Map<string, number>(); // 模拟：全 healthy = 1.0

  // 找到所有上海市场文件。
  const files = fs.readdirSync(OLD_DATA_DIR).filter((f) => f.startsWith('shanghai_') && f.endsWith('.json'));
  files.sort();

  logger.info('找到上海历史市场文件', { count: files.length, dir: OLD_DATA_DIR });

  const entries: SimEntry[] = [];

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(OLD_DATA_DIR, file), 'utf8')) as OldMarketFile;

    if (!raw.forecast_snapshots || raw.forecast_snapshots.length === 0) {
      logger.warn('跳过：无 forecast_snapshots', { file });
      continue;
    }

    const marketId = `${raw.city}_${raw.date}`;
    const actualTemp = raw.actual_temp ?? null;

    // 用历史 all_outcomes 构建市场价格表（label → price）。
    const marketPrices = buildMarketPrices(raw);
    if (marketPrices.size === 0) {
      logger.warn('跳过：无 all_outcomes 价格', { file });
      continue;
    }

    // 加载逐桶价格历史（fetch-price-history.ts 抓取产物），用于恢复真实入场/退出价。
    const history = loadMarketPriceHistory(marketId);

    // 上一快照的桶概率（用于 modelShock 因子）。
    let prevProbByBucket = new Map<string, number>();

    let entryFactor7: SimEntry | null = null;
    let entryMaxProb: SimEntry | null = null;

    // 每市场只取每个 horizon 的第一个快照，避免日志爆炸。
    // 这样每市场最多 3 个快照（D-2 / D-1 / D-0 各一个），
    // 既能验证全流程，又保持输出可读。
    const sampledHorizons = new Set<ForecastHorizon>();

    for (const snap of raw.forecast_snapshots) {
      const horizon = HORIZON_MAP[snap.horizon] ?? 'd2';
      if (sampledHorizons.has(horizon)) continue; // 每个 horizon 只取首个
      sampledHorizons.add(horizon);

      const models = snap.ens?.models;
      if (!models) continue; // 早期快照无 ENS 模型数据

      // 1. 从历史数据构建多源 StandardizedForecast。
      const forecasts = buildForecasts(models, snap.ts, city.settlementStation.stationId);

      // 2. 每个数据源：城市偏差（历史样本不足 → null）→ 构造修正结果。
      //    空间修正已停用（2026-08-07），直接用原始预报作为锚温度。
      const corrections = [];
      for (const f of forecasts) {
        corrections.push({
          city: city.city as CityId,
          targetStation: city.settlementStation.stationId,
          sourceId: f.sourceId,
          rawForecastedMaxTemp: f.forecastedMaxTemp,
          biasCorrectedMaxTemp: f.forecastedMaxTemp,
          spatialCorrectedMaxTemp: f.forecastedMaxTemp,
          spatialAdjustmentC: 0,
          confidence: 1.0,
          nearbyStationWeights: [],
          updatedAt: new Date(),
        } satisfies SpatialCorrectionResult);
      }

      // 3. 概率分布。
      const distribution = probEngine.generateDistribution(corrections, sourceWeights, horizon);

      // 4. 构建候选桶（含市场价、成交量、订单簿失衡、上一快照概率、相邻桶价格）。
      const candidates = buildCandidates(distribution, marketPrices, prevProbByBucket);

      // 5. 7 因子选桶。
      const decision = decisionEngine.decide({
        city: city.city as CityId,
        horizon,
        distribution,
        candidates,
        tradingMode: 'paper',
      });

      // 6. 诊断日志：锚温度 / 离散度 / 共识 / 最高概率桶。
      logSnapshot(snap.ts, horizon, distribution, decision, snap.metar != null);

      // 7. 记录入场（两种选桶方式对比，各自取首个决策）。
      const makeEntry = (
        selector: 'factor7' | 'maxProb',
        labels: string[],
        entry: { price: number; source: 'price-history' | 'snapshot' | 'all_outcomes'; ts: string | null } | null,
      ): SimEntry => ({
        marketId,
        bucketLabels: labels,
        entryPrice: entry?.price ?? null,
        entrySource: entry?.source ?? null,
        entryTs: entry?.ts ?? null,
        horizon,
        actualTemp,
        hit: null,
        exitPrice: null,
        profit: null,
        exitReached: null,
        selector,
      });

      // 方式 A：决策引擎选桶（双桶区间策略，选出相邻两个桶）。
      if (decision && !entryFactor7) {
        const labels = decision.buckets.map((b) => b.label);
        entryFactor7 = makeEntry('factor7', labels, findRealEntry(raw, labels, snap.ts, history));
      }

      // 方式 B：纯模型概率选桶（从候选里挑模型概率最高、且有市场价格的桶）。
      if (!entryMaxProb) {
        const topProb = [...distribution.buckets]
          .filter((b) => marketPrices.has(b.bucket.label))
          .sort((a, b) => b.probability - a.probability)[0];
        if (topProb) {
          entryMaxProb = makeEntry('maxProb', [topProb.bucket.label], findRealEntry(raw, [topProb.bucket.label], snap.ts, history));
        }
      }

      // 记录本快照概率，供下一快照计算 modelShock。
      prevProbByBucket = new Map(
        distribution.buckets.map((b) => [b.bucket.label, b.probability]),
      );
    }

    // 验证双桶区间退出目标：旧项目 market_snapshots 中是否出现过
    // "我们选中的相邻桶对"的 bid 之和 >= 0.85（到达即应平仓）。
    const exitReachedFor = (e: SimEntry | null): boolean | null => {
      if (!e) return null;
      // 只有双桶区间（2 个数字桶）才能验证 0.85 退出条件。
      if (e.bucketLabels.length !== 2) return null;
      const chosen = e.bucketLabels
        .map((label) => Number(label))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);
      if (chosen.length !== 2) return null;
      return (raw.market_snapshots ?? []).some(
        (snap) =>
          snap.top2_sum !== undefined &&
          snap.top2_sum >= 0.85 &&
          snap.top2_bucket !== undefined &&
          arraysEqual(parseSnapshotPair(snap.top2_bucket), chosen),
      );
    };

    // 验证命中：actual_temp 是否落在选中桶（区间）范围内。
    const finalizeEntry = (e: SimEntry | null): void => {
      if (!e) return;
      e.hit =
        e.actualTemp === null
          ? null
          : e.bucketLabels.some((label) => bucketContains(city.buckets, label, e.actualTemp!));
      e.exitReached = exitReachedFor(e);
      // 真实退出价与盈亏：有真实入场价才计算。
      if (e.entryPrice !== null) {
        const exit = findRealExit(raw, e.bucketLabels, e.entryTs, e.hit, history);
        e.exitPrice = exit.price;
        if (e.exitPrice !== null) e.profit = e.exitPrice - e.entryPrice;
      }
      entries.push(e);
    };
    finalizeEntry(entryFactor7);
    finalizeEntry(entryMaxProb);

    if (!entryFactor7 && !entryMaxProb) {
      logger.info('【结果】无入场', { marketId, actualTemp: actualTemp ?? '?' });
      continue;
    }

    for (const e of [entryFactor7, entryMaxProb]) {
      if (!e) continue;
      logger.info('【结果】入场', {
        marketId,
        selector: e.selector,
        bucket: e.bucketLabels.join('+'),
        entryPrice: e.entryPrice ?? '不可恢复',
        entrySource: e.entrySource,
        horizon: e.horizon,
        actualTemp: e.actualTemp ?? '?',
        hit: e.hit === null ? '未知' : e.hit ? '命中' : '未命中',
        exitPrice: e.exitPrice ?? '?',
        profit: e.profit ?? '?',
        exitTarget: e.exitReached === null ? '不适用' : e.exitReached ? '达成(>=0.85)' : '未达成',
      });
    }
  }

  // 汇总：按选桶方式分别统计命中率。
  const summarize = (selector: 'factor7' | 'maxProb'): string => {
    const group = entries.filter((e) => e.selector === selector);
    const verifiable = group.filter((e) => e.hit !== null);
    const hitCount = verifiable.filter((e) => e.hit).length;
    return verifiable.length > 0 ? `${hitCount}/${verifiable.length}（${((hitCount / verifiable.length) * 100).toFixed(1)}%）` : '无验证样本';
  };

  // 双桶区间 0.85 退出目标达成率（只看双桶决策）。
  const summarizeExit = (): string => {
    const dual = entries.filter((e) => e.selector === 'factor7' && e.exitReached !== null);
    if (dual.length === 0) return '无双桶样本';
    const reached = dual.filter((e) => e.exitReached).length;
    return `${reached}/${dual.length}（${((reached / dual.length) * 100).toFixed(1)}%）`;
  };

  // 盈亏汇总（只看有真实入场价的样本）：盈利笔数 / 已结算笔数、合计盈亏、平均盈亏。
  const summarizePnl = (selector: 'factor7' | 'maxProb'): string => {
    const withEntry = entries.filter((e) => e.selector === selector && e.entryPrice !== null);
    if (withEntry.length === 0) return '无真实入场价样本';
    const settled = withEntry.filter((e) => e.profit !== null);
    if (settled.length === 0) return `${withEntry.length} 笔有真实入场价（均未结算，暂无盈亏）`;
    const total = settled.reduce((s, e) => s + (e.profit ?? 0), 0);
    const profitable = settled.filter((e) => (e.profit ?? 0) > 0).length;
    return `${profitable}/${settled.length} 笔盈利（共 ${withEntry.length} 笔有价），合计 $${total.toFixed(3)}，均值 $${(total / settled.length).toFixed(3)}`;
  };

  logger.info('========== 模拟汇总 ==========', {
    '决策引擎选桶命中(双桶区间)': summarize('factor7'),
    '纯模型概率选桶命中(单桶)': summarize('maxProb'),
    '双桶0.85退出目标达成': summarizeExit(),
    '双桶真实入场价盈亏': summarizePnl('factor7'),
    '单桶真实入场价盈亏': summarizePnl('maxProb'),
    '覆盖市场数': new Set(entries.map((e) => e.marketId)).size,
  });
}

// ==================== 辅助函数 ====================

function buildForecasts(
  models: Record<string, number>,
  ts: string,
  targetStation: string,
): StandardizedForecast[] {
  const results: StandardizedForecast[] = [];
  for (const [oldKey, temp] of Object.entries(models)) {
    const sourceId = SOURCE_MAP[oldKey];
    if (!sourceId) continue;
    results.push({
      sourceId,
      issuanceTime: new Date(ts),
      forecastHour: 24, // 简化：固定 24h
      targetStation,
      forecastedMaxTemp: temp,
      metadata: { model: oldKey, sim: true },
    });
  }
  return results;
}

function buildMarketPrices(raw: OldMarketFile): Map<string, MarketPrice> {
  const prices = new Map<string, MarketPrice>();
  for (const outcome of raw.all_outcomes ?? []) {
    const [lo, hi] = outcome.range;
    const label = mapOldRangeToBucketLabel(lo, hi);
    if (!label) continue;
    // 订单簿失衡近似：价格越贴近 ask 说明买压越强（+1），越贴近 bid 说明卖压越强（-1）。
    const spread = Math.max(outcome.ask - outcome.bid, 0.0001);
    const imbalance = Math.max(-1, Math.min(1, (outcome.price - outcome.bid) / spread * 2 - 1));
    prices.set(label, {
      yesPrice: outcome.price,
      volumeUsd: outcome.volume,
      imbalance,
    });
  }
  return prices;
}

// ==================== 逐桶价格历史（fetch-price-history.ts 抓取产物） ====================

interface PricePoint {
  t: number; // Unix 秒
  p: number; // YES 价格
}
type PriceHistory = Map<string, Array<PricePoint>>;

/** 读取 data/price-history/<marketId>.json，返回 label → 价格曲线；无则 null。 */
function loadMarketPriceHistory(marketId: string): PriceHistory | null {
  const file = path.join(process.cwd(), 'data', 'price-history', `${marketId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      buckets: Record<string, Array<PricePoint>>;
    };
    return new Map(Object.entries(raw.buckets));
  } catch {
    return null;
  }
}

/** 取 ts 时刻（含）之前最近的价格点；若无则取最早的价格点（市场刚开盘）；完全无数据则 null。 */
function priceAt(series: Array<PricePoint>, ts: string): number | null {
  if (series.length === 0) return null;
  const ms = new Date(ts).getTime();
  let best: number | null = null;
  for (const pt of series) {
    if (pt.t * 1000 <= ms) best = pt.p;
    else break;
  }
  // 决策时刻早于价格曲线起点 → 取首个可用价格（市场刚开盘）。
  if (best === null) best = series[0].p;
  return best;
}

// 旧 label（31-36、<=30、>=37）→ 通用 price-history 桶 key 列表。
// fetch-price-history.ts 现在按 range 存 key（31-31、<=28、29-29...），
// 旧 label '<=30'/'>=37' 对应多个实际桶，这里全部列出供查询加总。
function labelToKeys(label: string): string[] {
  if (label === '<=30') return ['<=30', '<=28', '29-29', '30-30'];
  if (label === '>=37') return ['>=37', '37-37', '38-38', '>=39'];
  const n = Number(label);
  return Number.isFinite(n) ? [`${n}-${n}`] : [];
}

/** 从逐桶价格历史取某 label 在 ts 时刻的价格（存在任一对应桶的价格即加总）。 */
function historyPriceOf(history: PriceHistory | null, label: string, ts: string): number | null {
  if (!history) return null;
  const keys = [...new Set(labelToKeys(label))];
  const prices = keys.map((k) => priceAt(history.get(k) ?? [], ts));
  if (!prices.some((p) => p !== null)) return null;
  return prices.reduce((a, b) => a + (b ?? 0), 0);
}

/**
 * 用真实价格恢复入场成本（$）。
 *
 * 已结算市场的 all_outcomes 价格是结算价（赢家 0.9995 / 输家 0.0005），不能当入场成本。
 * 恢复优先级：
 *
 *   1. price-history：从 Polymarket API 拉取的逐桶价格曲线，取决策时刻每桶的真实价。
 *      任意桶都能精确恢复（不再受 top1/top2 限制）。
 *   2. snapshot：旧项目 market_snapshots 的 top1/top2 真实价（双桶=首次成为 top2 的
 *      top2_sum；单桶=首次成为 top1 的 top_price）。已接近结算价（>=0.99）的快照跳过。
 *   3. all_outcomes：仅未结算市场（status != resolved）是真实价。
 */
function findRealEntry(
  raw: OldMarketFile,
  labels: string[],
  decisionTs: string,
  history: PriceHistory | null,
): { price: number; source: 'price-history' | 'snapshot' | 'all_outcomes'; ts: string | null } | null {
  // 1. 逐桶价格历史：完整恢复。
  if (history) {
    const prices = labels.map((l) => historyPriceOf(history, l, decisionTs));
    if (prices.every((p) => p !== null)) {
      return {
        price: (prices as number[]).reduce((a, b) => a + b, 0),
        source: 'price-history',
        ts: decisionTs,
      };
    }
  }

  // 2. 旧项目 top1/top2 快照。
  const snaps = raw.market_snapshots ?? [];
  if (labels.length === 2) {
    const chosen = labels.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (chosen.length === 2) {
      for (const snap of snaps) {
        if (snap.top2_bucket == null || snap.top2_sum == null || snap.top2_sum >= 0.99) continue;
        const pair = parseSnapshotPair(snap.top2_bucket);
        if (pair && arraysEqual(pair, chosen)) {
          return { price: snap.top2_sum, source: 'snapshot', ts: snap.ts };
        }
      }
    }
  } else if (labels.length === 1) {
    const n = Number(labels[0]);
    if (Number.isFinite(n)) {
      for (const snap of snaps) {
        if (snap.top_bucket == null || snap.top_price == null || snap.top_price >= 0.99) continue;
        const pair = parseSnapshotPair(snap.top_bucket); // "33-33C" → [33,33]
        if (pair && pair.length === 2 && pair[0] === pair[1] && pair[0] === n) {
          return { price: snap.top_price, source: 'snapshot', ts: snap.ts };
        }
      }
    }
  }

  // 3. 兜底：未结算市场的 all_outcomes 是真实价格。
  if (raw.status !== 'resolved') {
    const price = labels.reduce((sum, label) => {
      const o = (raw.all_outcomes ?? []).find(
        (x) => mapOldRangeToBucketLabel(x.range[0], x.range[1]) === label,
      );
      return sum + (o?.price ?? 0);
    }, 0);
    if (price > 0) return { price, source: 'all_outcomes', ts: null };
  }
  return null;
}

/**
 * 用真实价格估算退出价（$）。
 *
 *   双桶：入场之后首个两桶价格之和 >= 0.85 的时刻平仓（优先用逐桶价格历史，
 *         否则用 top2_sum 快照）；否则按结算赔付（命中 1.0 / 未命中 0.0——
 *         相邻两桶只有一个会赢）。
 *   单桶：按结算赔付（纯"买入持有到结算"基线）。
 *   hit 未知（未结算市场无 actual_temp）→ 退出价 null。
 */
function findRealExit(
  raw: OldMarketFile,
  labels: string[],
  entryTs: string | null,
  hit: boolean | null,
  history: PriceHistory | null,
): { price: number | null; reached: boolean } {
  const entryMs = entryTs ? new Date(entryTs).getTime() : 0;

  if (labels.length === 2) {
    // 优先用逐桶价格历史：合并两个桶的时间戳，找首个 sum >= 0.85。
    if (history) {
      const s1 = history.get(labelToKeys(labels[0]!)[0]!);
      const s2 = history.get(labelToKeys(labels[1]!)[0]!);
      if (s1 && s2 && s1.length > 0 && s2.length > 0) {
        const p1At = new Map(s1.map((p) => [p.t, p.p]));
        const p2At = new Map(s2.map((p) => [p.t, p.p]));
        const times = [...new Set<number>([...s1, ...s2].map((p) => p.t))].sort((a, b) => a - b);
        for (const t of times) {
          if (t * 1000 < entryMs) continue;
          const p1 = p1At.get(t);
          const p2 = p2At.get(t);
          if (p1 != null && p2 != null) {
            const sum = p1 + p2;
            if (sum >= 0.85) return { price: sum, reached: true };
          }
        }
      }
    }

    // 退化为 top2 快照。
    const snaps = raw.market_snapshots ?? [];
    const chosen = labels.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (chosen.length === 2) {
      for (const snap of snaps) {
        if (entryTs != null && snap.ts <= entryTs) continue;
        if (snap.top2_bucket == null || snap.top2_sum == null || snap.top2_sum < 0.85) continue;
        const pair = parseSnapshotPair(snap.top2_bucket);
        if (pair && arraysEqual(pair, chosen)) {
          return { price: snap.top2_sum, reached: true };
        }
      }
    }
  }

  if (hit === null) return { price: null, reached: false };
  return { price: hit ? 1.0 : 0.0, reached: false };
}

function buildCandidates(
  distribution: ProbabilityDistribution,
  marketPrices: Map<string, MarketPrice>,
  prevProbByBucket: Map<string, number>,
): CandidateBucket[] {
  const candidates: CandidateBucket[] = [];
  const priceOf = (label: string): number | undefined => marketPrices.get(label)?.yesPrice;

  for (const bucketProb of distribution.buckets) {
    const label = bucketProb.bucket.label;
    const market = marketPrices.get(label);
    if (!market) continue; // 无市场价格的桶不参与选桶

    // 相邻桶价格（用于 relativeValue 因子）。
    const neighbors = adjacentLabels(label);
    const neighborPrices = {
      lowerYesPrice: neighbors.lower ? priceOf(neighbors.lower) : undefined,
      higherYesPrice: neighbors.higher ? priceOf(neighbors.higher) : undefined,
    };

    candidates.push({
      bucket: bucketProb.bucket,
      modelProbability: bucketProb.probability,
      yesPrice: market.yesPrice,
      noPrice: 1 - market.yesPrice,
      volumeUsd: market.volumeUsd,
      orderBookImbalance: market.imbalance,
      spatialConfidence: distribution.sourceContributions.length > 0
        ? Math.max(0.2, 1 - distribution.dispersionC / 5)
        : 0.2,
      previousProbability: prevProbByBucket.get(label),
      neighborPrices,
    });
  }
  return candidates;
}

// 计算相邻桶 label（上下各一个）。
function adjacentLabels(label: string): { lower?: string; higher?: string } {
  if (label === '<=30') return { higher: '31' };
  if (label === '>=37') return { lower: '36' };
  const n = Number(label);
  if (Number.isNaN(n)) return {};
  return {
    lower: n === 31 ? '<=30' : String(n - 1),
    higher: n === 36 ? '>=37' : String(n + 1),
  };
}

// 判断实际温度是否落在桶范围内。
function bucketContains(
  buckets: Array<{ label: string; minTempC: number | null; maxTempC: number | null }>,
  label: string,
  temp: number,
): boolean {
  const bucket = buckets.find((b) => b.label === label);
  if (!bucket) return false;
  if (bucket.minTempC !== null && temp <= bucket.minTempC) return false;
  if (bucket.maxTempC !== null && temp > bucket.maxTempC) return false;
  return true;
}

// 解析旧项目 market_snapshots 的 top2_bucket 格式（如 "33-34C"）为两个数字的排序对。
function parseSnapshotPair(bucketStr: string): number[] | null {
  const match = /(\d+)-(\d+)C/.exec(bucketStr);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])].sort((a, b) => a - b);
}

// 两个数字数组是否相等（长度相同且逐元素相等）。
function arraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function logSnapshot(
  ts: string,
  horizon: ForecastHorizon,
  distribution: ProbabilityDistribution,
  decision: ReturnType<TradingDecisionEngine['decide']>,
  anchorIsMetar: boolean,
): void {
  // 只打印顶部 3 个概率桶，控制日志量。
  const top = [...distribution.buckets].sort((a, b) => b.probability - a.probability).slice(0, 3);
  const topStr = top.map((b) => `${b.bucket.label}@${(b.probability * 100).toFixed(1)}%`).join(' ');

  logger.info('【快照】', {
    ts: new Date(ts).toISOString().slice(11, 16),
    horizon,
    anchor: `${distribution.correctedAnchorTempC.toFixed(1)}(${anchorIsMetar ? 'METAR' : 'ENS均值'})`,
    dispersion: distribution.dispersionC.toFixed(2),
    consensus: distribution.consensusLevel.toFixed(2),
    top: topStr,
    decision: decision
      ? `${decision.buckets.map((b) => b.label).join('+')}@${decision.entryPrice}`
      : '无',
  });
}

main().catch((error) => {
  logger.error('模拟脚本失败', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
