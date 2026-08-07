// 全城市回测脚本：用旧项目（polymarket-weather-bot）积累的所有城市历史市场数据，
// 完整走一遍 weather-2 的决策流水线，验证双桶区间策略在跨城市/跨单位的稳定性。
//
// 与 simulate-paper-trading.ts（上海专用）的差异：
//   1. 城市不写死：遍历旧项目 data/markets/ 下所有 <city>_*.json
//   2. 单位自适应：ens.models / actual_temp / 桶边界 统一转摄氏度再喂引擎
//      （旧项目里部分城市是华氏市场，如 nyc/miami/dallas）
//   3. 桶结构动态构建：从 all_outcomes 的 range 推断，不用 config/shanghai.json
//   4. 价格历史用通用 bucket key（如 "31-31"、"82-83"）查询 price-history
//
// 运行方式（在 weather-bot 目录下）：
//   npx tsx scripts/simulate-all-cities.ts
//   可传城市过滤：npx tsx scripts/simulate-all-cities.ts shanghai nyc

import fs from 'node:fs';
import path from 'node:path';
import { loadAppConfig } from '../src/common/config-loader.js';
import { AdaptiveProbabilityEngine } from '../src/data/AdaptiveProbabilityEngine.js';
import { TradingDecisionEngine, type CandidateBucket } from '../src/strategies/TradingDecisionEngine.js';
import { createModuleLogger } from '../src/common/logger.js';
import type {
  ProbabilityDistribution,
  ForecastHorizon,
  CityId,
  TemperatureBucket,
  SpatialCorrectionResult,
} from '../src/common/types.js';

const logger = createModuleLogger('SimulateAllCities');

const OLD_DATA_DIR = path.resolve(
  process.cwd(),
  '..', '..', 'weather-bot', 'polymarket-weather-bot', 'data', 'markets',
);
const SOURCE_MAP: Record<string, string> = {
  ecmwf_ifs025: 'open-meteo-ecmwf',
  gfs_seamless: 'open-meteo-gfs',
  icon_seamless: 'open-meteo-icon',
};
const HORIZON_MAP: Record<string, ForecastHorizon> = {
  'D+3': 'd3', 'D+2': 'd2', 'D+1': 'd1', 'D+0': 'd0',
};

// ==================== 单位转换 ====================

const toC = (f: number): number => ((f - 32) * 5) / 9;

// 通用桶 key（与 fetch-price-history.ts 一致）。
function bucketKey(lo: number, hi: number): string {
  if (lo <= -900) return `<=${hi}`;
  if (hi >= 900) return `>=${lo}`;
  return `${lo}-${hi}`;
}

// 判断市场单位：排除开放桶（-999/999）后，正常桶的数值若超过 50 → 华氏
// （摄氏城市正常桶 ≤40，华氏城市 ≥71；不能直接看 -999，开放桶会误判）。
function isFahrenheit(outcomes: Array<{ range: [number, number] }>): boolean {
  let maxNormal = 0;
  for (const o of outcomes) {
    const [lo, hi] = o.range;
    if (lo > -900) maxNormal = Math.max(maxNormal, lo);
    if (hi < 900) maxNormal = Math.max(maxNormal, hi);
  }
  return maxNormal > 50;
}

// 构建摄氏桶数组（从 all_outcomes ranges）。
// 旧数据 range 是闭区间整数（如 16-16、82-83F），但引擎按半开区间 (min, max] 算概率，
// 直接取 [16,16] 会导致 CDF 差为 0。这里统一转成 ±0.5 边界：
//   16-16 → (15.5, 16.5]；华氏 82-83 → (81.5-32, 83.5-32)°C 转摄氏后仍相邻。
function buildBucketsC(outcomes: Array<{ range: [number, number] }>, fahrenheit: boolean): TemperatureBucket[] {
  const conv = (x: number): number => (fahrenheit ? toC(x) : x);
  return outcomes.map((o) => {
    const [lo, hi] = o.range;
    return {
      label: bucketKey(lo, hi),
      minTempC: lo <= -900 ? null : conv(lo - 0.5),
      maxTempC: hi >= 900 ? null : conv(hi + 0.5),
    };
  });
}

// ==================== 数据读取 ====================

interface PricePoint { t: number; p: number }
type PriceHistory = Map<string, Array<PricePoint>>;

function loadMarketPriceHistory(marketId: string): PriceHistory | null {
  const file = path.join(process.cwd(), 'data', 'price-history', `${marketId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { buckets: Record<string, Array<PricePoint>> };
    return new Map(Object.entries(raw.buckets));
  } catch {
    return null;
  }
}

function priceAt(series: Array<PricePoint>, ts: string): number | null {
  if (!series || series.length === 0) return null;
  const ms = new Date(ts).getTime();
  let best: number | null = null;
  for (const pt of series) {
    if (pt.t * 1000 <= ms) best = pt.p;
    else break;
  }
  if (best === null) best = series[0].p;
  return best;
}

interface OldMarketFile {
  city: string;
  date: string;
  status: string;
  event_end_date?: string; // 市场真实结算时间（ISO），resolveTargetHorizon 的数据源
  unit?: string; // "C" / "F"（旧项目按市场记录）
  actual_temp: number | null;
  forecast_snapshots: Array<{
    ts: string;
    horizon: string;
    hours_left?: number; // 快照时刻距结算小时数（旧项目 scan.ts 记录）
    best?: number; // ensemble mean（单位与市场一致）
    ecmwf?: number;
    hrrr?: number;
    ens?: { models?: Record<string, number> };
  }>;
  all_outcomes?: Array<{
    range: [number, number];
    bid: number;
    ask: number;
    price: number;
    volume: number;
  }>;
}

// ==================== per-city bias（复刻旧项目 bias.ts，LOO 防前视） ====================
//
// 旧项目机制：bias = mean(预报 - 实际)，按 城市|horizon|source 维护滚动表，
// 修正公式：预报' = 预报 - bias（减去系统高估）。参数复刻：
//   BIAS_FORGET_N=12（滚动窗口）、BIAS_MIN_N=2、BIAS_SHRINK_N=4、
//   BIAS_MAX_C=2.0（°C，华氏 ×1.8）。
// 回测里用 leave-one-out：只用该城市"结算日期 < 当前市场"的已结算样本，
// 避免把当前市场的结算结果提前泄露进偏差（生产环境是每日滚动刷新，同样只用历史）。

const BIAS_FORGET_N = 12;
const BIAS_MIN_N = 2;
const BIAS_SHRINK_N = 4;
const BIAS_MAX_C = 2.0;

// 旧项目只跟踪 best/ecmwf/hrrr 三个源的偏差；icon 无独立记录，用 ensemble mean（best）代理。
const BIAS_SOURCE_MAP: Record<string, 'best' | 'ecmwf' | 'hrrr'> = {
  ecmwf_ifs025: 'ecmwf',
  gfs_seamless: 'hrrr',
  icon_seamless: 'best',
};

// 双桶入场 edge 直过滤：模型区间置信 pPair 必须显著高于买入成本。
//   pPair - 买入成本 >= MIN_PAIR_EDGE 才允许开仓。
// 依据（2026-08-07 诊断）：引擎双桶路径只按 pPair 排序选桶，没有 edge 检查，
// tel-aviv 08-05 用 0.905 买入自己只信 67% 的桶对（市场 87-93% 反而更准）。
// 价格绝对值上限（0.5/0.85）已验证是负优化——edge 直过滤只拦"模型自己都不信的贵单"。
const MIN_PAIR_EDGE = 0.10;

// ==================== 真实市场目标日期入场窗（对齐 StrategyInstance.resolveTargetHorizon） ====================
//
// 新逻辑不再用快照 horizon 标签硬编码判断"是不是 D-3/D-2"，而是用市场真实的
// event_end_date 算距结算小时数，落在 [MIN_ENTRY_HOURS, MAX_ENTRY_HOURS] 内才允许入场
// （旧项目 scan.ts 同款：MIN_HOURS=2 / MAX_HOURS=80；市场上架约 h50-56，D-3 若上架在 h72-80）。
// 快照自带 hours_left（部分老快照可能缺失，用 event_end_date 兜底计算）。
const MIN_ENTRY_HOURS = 2;
const MAX_ENTRY_HOURS = 80;

// ==================== DEB 借鉴（2026-08-07）：MAD σ + 动态 MAE + 温度档 bias ====================
//
// 三项校准都只使用"结算日期 < 当前市场"的已结算样本（LOO 防前视），与
// per-city bias 同口径：
//   1. MAD 稳健 σ：max(1.4826 × 1.05 × median(|残差−median|), MIN_SIGMA)，
//      按 (unit, horizon) 全局聚合（用 snap.best 作多源融合预报代理）。
//      注入 AdaptiveProbabilityEngine 作为分布宽度下限。
//   2. 动态 MAE 权重：ecmwf/gfs 按 MAE 倒数缩放（icon 无历史快照，保持静态
//      占比 0.2），替代简单平均。
//   3. 温度档 bias：在 city|horizon|source 之上加预报温度档（≤32/33-36/≥37℃），
//      James-Stein 收缩 b_eff = (n/(n+5))×b_档 + (1−n/(n+5))×b_城市。

const MIN_SIGMA_C = 0.5;
const STRATUM_SHRINK_K = 5;
const MAE_MIN_N = 3;
const SIGMA_MIN_N = 3;

/** DEB 借鉴开关：BACKTEST_DEB 控制启用的校准项（逗号分隔），默认 bias,mae：
 *   - bias：温度档 bias（James-Stein 收缩）—— 回测最大赢家（PnL 翻倍）
 *   - mae：动态 MAE 权重 —— 正向（扩大市场覆盖 + PnL 提升）
 *   - sigma：MAD 稳健 σ —— 回测为负优化（该引擎旧 σ≈1-1.5°C 已紧，
 *     MAD σ 放大反而保守化砍机会；与旧项目 4.5°C 启发式 σ 不同），默认关闭
 *   传 'all' 三项全开，'0'/'none' 全关（baseline）。 */
const DEB_MODE = process.env.BACKTEST_DEB ?? 'bias,mae';
const DEB = DEB_MODE !== '0' && DEB_MODE !== 'none';
const DEB_SIGMA = DEB && (DEB_MODE === 'all' || DEB_MODE.includes('sigma'));
const DEB_BIAS = DEB && (DEB_MODE === 'all' || DEB_MODE.includes('bias'));
const DEB_MAE = DEB && (DEB_MODE === 'all' || DEB_MODE.includes('mae'));

/** 温度档划分（℃, 忠实 PolyWeather TEMP_BUCKET_KEYS）。 */
function tempStratumC(fc: number): string {
  if (fc <= 32) return '<=32';
  if (fc <= 36) return '33-36';
  return '>=37';
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** PolyWeather _robust_sigma：1.4826 × 1.05 × MAD。 */
function madRobustSigma(errors: number[]): number {
  const med = median([...errors].sort((a, b) => a - b));
  const devs = errors.map((e) => Math.abs(e - med)).sort((a, b) => a - b);
  return 1.4826 * 1.05 * median(devs);
}

/** 市场单位（文件级）：优先 raw.unit，退化按桶结构判定。 */
function marketUnit(m: OldMarketFile): string {
  return m.unit ?? (isFahrenheit(m.all_outcomes ?? []) ? 'F' : 'C');
}

/** 收集 (unit, horizon, source) 的历史残差（℃, LOO：只用 date < excludeDate 的市场）。 */
function collectResiduals(
  allFiles: Map<string, OldMarketFile[]>,
  excludeDate: string,
): Array<{ unit: string; horizon: string; source: string; errorC: number }> {
  const out: Array<{ unit: string; horizon: string; source: string; errorC: number }> = [];
  for (const [, list] of allFiles) {
    for (const m of list) {
      if (m.status !== 'resolved' || m.actual_temp == null || m.date >= excludeDate) continue;
      const unit = marketUnit(m);
      const toC = unit === 'F' ? (x: number) => (x * 5) / 9 : (x: number) => x;
      for (const snap of m.forecast_snapshots ?? []) {
        const horizon = snap.horizon ?? 'D+0';
        const cands: Array<[string, number | undefined]> = [
          ['best', snap.best],
          ['ecmwf', snap.ecmwf],
          ['hrrr', snap.hrrr],
        ];
        for (const [src, v] of cands) {
          if (v == null) continue;
          out.push({ unit, horizon, source: src, errorC: toC(v - m.actual_temp) });
        }
      }
    }
  }
  return out;
}

/**
 * MAD 稳健 σ（℃, per unit|horizon）：真实预测误差幅度。
 * 样本不足返回 null（调用方回退引擎现有 σ 逻辑）。
 */
function computeMADSigma(
  allFiles: Map<string, OldMarketFile[]>,
  excludeDate: string,
  unit: string,
  horizon: string,
): number | null {
  const errs = collectResiduals(allFiles, excludeDate)
    .filter((s) => s.unit === unit && s.horizon === horizon && s.source === 'best')
    .map((s) => s.errorC);
  if (errs.length < SIGMA_MIN_N) return null;
  const mad = madRobustSigma(errs);
  return Math.round(Math.max(mad, MIN_SIGMA_C) * 100) / 100;
}

/** 单源 MAE（℃, per unit|horizon|source）。样本不足返回 null。 */
function modelMae(
  allFiles: Map<string, OldMarketFile[]>,
  excludeDate: string,
  unit: string,
  horizon: string,
  source: string,
): number | null {
  const errs = collectResiduals(allFiles, excludeDate)
    .filter((s) => s.unit === unit && s.horizon === horizon && s.source === source)
    .map((s) => Math.abs(s.errorC));
  if (errs.length < MAE_MIN_N) return null;
  return errs.reduce((a, b) => a + b, 0) / errs.length;
}

/**
 * 动态 MAE 权重（sourceId → weight）。有 MAE 的源按 1/MAE 缩放，icon 无历史
 * 快照保持静态占比 0.2（与旧项目 forecasts.ts 一致）；无任何 MAE 时返回空
 * Map（引擎回退简单平均）。
 */
function dynamicSourceWeights(
  allFiles: Map<string, OldMarketFile[]>,
  excludeDate: string,
  unit: string,
  horizon: string,
): Map<string, number> {
  const maeE = modelMae(allFiles, excludeDate, unit, horizon, 'ecmwf');
  const maeG = modelMae(allFiles, excludeDate, unit, horizon, 'hrrr');
  const have = [maeE, maeG].filter((m): m is number => m != null);
  if (have.length === 0) return new Map();
  const best = Math.min(...have);
  const weights = new Map<string, number>([
    ['open-meteo-ecmwf', maeE != null ? 0.5 * (best / maeE) : 0],
    ['open-meteo-gfs', maeG != null ? 0.3 * (best / maeG) : 0],
    ['open-meteo-icon', 0.2],
  ]);
  const sum = Array.from(weights.values()).reduce((a, b) => a + b, 0);
  if (sum <= 0) return new Map();
  for (const [k, v] of weights) weights.set(k, Math.round((v / sum) * 1000) / 1000);
  return weights;
}

/**
 * 温度档 bias（James-Stein 收缩）：b_eff = (n/(n+5))×b_档 + (1−n/(n+5))×b_城市。
 * 档内样本不足时完全回退城市基准（行为与原来一致）。forecastC 用于分档。
 */
function computeBiasWithStratum(
  allFiles: Map<string, OldMarketFile[]>,
  city: string,
  excludeDate: string,
  unit: string,
  horizon: string,
  source: 'best' | 'ecmwf' | 'hrrr',
  forecastC: number,
): { bias: number; n: number } | null {
  const base = computeCityBias(allFiles, city, excludeDate, unit, horizon, source);
  if (!base) return null;
  const stratum = tempStratumC(forecastC);
  const s = computeCityBias(allFiles, city, excludeDate, unit, horizon, source, stratum);
  if (!s) return base;
  const shrink = s.n / (s.n + STRATUM_SHRINK_K);
  return {
    bias: Math.round((shrink * s.bias + (1 - shrink) * base.bias) * 1000) / 1000,
    n: s.n,
  };
}

function computeCityBias(
  allFiles: Map<string, OldMarketFile[]>,
  city: string,
  excludeDate: string,
  unit: string,
  horizon: string,
  source: 'best' | 'ecmwf' | 'hrrr',
  stratum?: string,
): { bias: number; n: number } | null {
  const markets = (allFiles.get(city) ?? [])
    .filter((m) => m.status === 'resolved' && m.actual_temp != null && m.date < excludeDate)
    .sort((a, b) => a.date.localeCompare(b.date));

  const series: number[] = [];
  for (const m of markets) {
    for (const snap of m.forecast_snapshots ?? []) {
      if (snap.horizon !== horizon) continue;
      const v = snap[source];
      if (v == null) continue;
      if (stratum) {
        const fc = unit === 'F' ? toC(v) : v;
        if (tempStratumC(fc) !== stratum) continue;
      }
      series.push(v - m.actual_temp!); // 同单位相减，bias 也在市场单位下
      if (series.length > BIAS_FORGET_N) series.shift();
    }
  }

  if (series.length < BIAS_MIN_N) return null;
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const shrink = Math.min(1, series.length / BIAS_SHRINK_N);
  const cap = unit === 'F' ? BIAS_MAX_C * 1.8 : BIAS_MAX_C;
  const capped = Math.max(-cap, Math.min(cap, mean));
  return { bias: Math.round(capped * shrink * 1000) / 1000, n: series.length };
}

interface MarketPrice {
  yesPrice: number;
  volumeUsd: number;
  imbalance: number;
  key: string;
}

// 构建决策时刻的市场价格表。
// 优先用 price-history 在 ts 时刻的真实价；没有则回退 all_outcomes
// （已结算市场的 all_outcomes 是结算价 0/1，会造成候选价格严重失真）。
function buildMarketPrices(
  raw: OldMarketFile,
  ts: string,
  history: PriceHistory | null,
): Map<string, MarketPrice> {
  const prices = new Map<string, MarketPrice>();
  for (const o of raw.all_outcomes ?? []) {
    const key = bucketKey(o.range[0], o.range[1]);
    const histPrice = history ? priceAt(history.get(key) ?? [], ts) : null;
    const yesPrice = histPrice ?? o.price;
    const spread = Math.max(o.ask - o.bid, 0.0001);
    const imbalance = Math.max(-1, Math.min(1, ((yesPrice - o.bid) / spread) * 2 - 1));
    prices.set(key, { yesPrice, volumeUsd: o.volume, imbalance, key });
  }
  return prices;
}

// ==================== 主流程 ====================

interface EntryRecord {
  marketId: string;
  city: string;
  bucketKeys: string[];
  entryPrice: number | null;
  entrySource: 'price-history' | 'all_outcomes' | null;
  entryTs: string | null;
  horizon: ForecastHorizon;
  actualTempC: number | null;
  hit: boolean | null;
  exitPrice: number | null;
  profit: number | null;
  // 本次入场实际应用的 per-city bias（℃）：sourceId → biasC（0 = 未应用）。
  biasApplied: Record<string, number>;
}

async function main(): Promise<void> {
  // 用 shanghai 配置拿 scoringWeights / risk（全城市共用同一套选桶权重）。
  const shanghaiConfig = loadAppConfig('shanghai').city;

  const cityFilter = new Set(process.argv.slice(2));
  const files = fs.readdirSync(OLD_DATA_DIR).filter(
    (f) => f.endsWith('.json') && (cityFilter.size === 0 || cityFilter.has(f.split('_')[0] ?? '')),
  );
  files.sort();

  const entries: EntryRecord[] = [];
  let skippedNoOutcomes = 0;
  let skippedNoSnapshots = 0;
  let skippedByEdge = 0;

  // 预加载全部市场文件：per-city bias 需要遍历同城市已结算样本（LOO）。
  const allFiles = new Map<string, OldMarketFile[]>();
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(OLD_DATA_DIR, file), 'utf8')) as OldMarketFile;
    const list = allFiles.get(raw.city) ?? [];
    list.push(raw);
    allFiles.set(raw.city, list);
  }

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(OLD_DATA_DIR, file), 'utf8')) as OldMarketFile;

    if (!raw.forecast_snapshots || raw.forecast_snapshots.length === 0) {
      skippedNoSnapshots += 1;
      continue;
    }
    if (!raw.all_outcomes || raw.all_outcomes.length === 0) {
      skippedNoOutcomes += 1;
      continue;
    }

    const marketId = `${raw.city}_${raw.date}`;
    const fahrenheit = isFahrenheit(raw.all_outcomes);
    const bucketsC = buildBucketsC(raw.all_outcomes, fahrenheit);

    const history = loadMarketPriceHistory(marketId);

    const probEngine = new AdaptiveProbabilityEngine(raw.city as CityId, raw.city, bucketsC);
    const decisionEngine = new TradingDecisionEngine(shanghaiConfig);

    // actual 温度转摄氏（供命中判定）。
    const actualTempC = raw.actual_temp == null ? null : fahrenheit ? toC(raw.actual_temp) : raw.actual_temp;

    let entry: EntryRecord | null = null;

    for (const snap of raw.forecast_snapshots) {
      const horizon = HORIZON_MAP[snap.horizon] ?? 'd2';
      // 真实市场目标日期入场窗（对齐 resolveTargetHorizon）：
      //   用市场真实结算时间算 hoursLeft，落在 [MIN_ENTRY_HOURS, MAX_ENTRY_HOURS]
      //   内才允许入场。快照按时间升序排列、hoursLeft 单调递减，因此
      //   hoursLeft < MIN 直接停（后续只会更小），hoursLeft > MAX 继续等（市场未上架）。
      const hoursLeft = snap.hours_left ?? computeHoursLeft(raw, snap.ts);
      if (hoursLeft != null) {
        if (hoursLeft < MIN_ENTRY_HOURS) break;
        if (hoursLeft > MAX_ENTRY_HOURS) continue;
      }
      // 开仓窗口只在 D-3/D-2（市场刚上线）：扫描窗口内全部快照，
      // 首个合格决策即入场（对应实盘"上线后每轮扫描，条件满足就买"）。
      // D-1/D-0 只平仓不开仓，扫描到此即停。
      if (horizon === 'd1' || horizon === 'd0') break;

      const models = snap.ens?.models;
      if (!models) continue;

      // 1a. 动态 MAE 权重（DEB，LOO）：替代简单平均。icon 无 MAE 保持静态占比。
      const unit = raw.unit ?? (fahrenheit ? 'F' : 'C');
      const sourceWeights = DEB_MAE
        ? dynamicSourceWeights(allFiles, raw.date, unit, snap.horizon)
        : new Map<string, number>();
      // 1b. MAD 稳健 σ（℃, DEB）：真实预测误差幅度，注入概率引擎作为宽度下限。
      const residualSigmaC = DEB_SIGMA ? computeMADSigma(allFiles, raw.date, unit, snap.horizon) : null;

      // 1. 多源 forecast（温度转摄氏，并按 per-city bias + 温度档 bias 修正）。
      //    bias = mean(预报 - 实际)（市场单位下，LOO 只含该城市更早结算的市场）；
      //    修正：预报' = 预报 - bias。华氏市场先把 bias 转成摄氏再减。
      const biasApplied: Record<string, number> = {};
      const corrections: SpatialCorrectionResult[] = [];
      for (const [oldKey, temp] of Object.entries(models)) {
        const sourceId = SOURCE_MAP[oldKey];
        if (!sourceId) continue;
        const tempC = fahrenheit ? toC(temp) : temp;
        const b = DEB_BIAS
          ? computeBiasWithStratum(
              allFiles,
              raw.city,
              raw.date,
              unit,
              snap.horizon,
              BIAS_SOURCE_MAP[oldKey] ?? 'best',
              tempC,
            )
          : computeCityBias(
              allFiles,
              raw.city,
              raw.date,
              unit,
              snap.horizon,
              BIAS_SOURCE_MAP[oldKey] ?? 'best',
            );
        const biasC = b && b.bias !== 0 ? (fahrenheit ? (b.bias * 5) / 9 : b.bias) : 0;
        const correctedC = biasC !== 0 ? Math.round((tempC - biasC) * 100) / 100 : tempC;
        if (biasC !== 0) biasApplied[sourceId] = biasC;
        corrections.push({
          city: raw.city as CityId,
          targetStation: raw.city,
          sourceId,
          rawForecastedMaxTemp: tempC,
          biasCorrectedMaxTemp: correctedC,
          spatialCorrectedMaxTemp: correctedC,
          spatialAdjustmentC: 0,
          confidence: 1.0,
          nearbyStationWeights: [],
          updatedAt: new Date(),
        });
      }
      if (corrections.length === 0) continue;

      // 2. 概率分布（摄氏基准）。
      const distribution: ProbabilityDistribution = probEngine.generateDistribution(
        corrections,
        sourceWeights,
        horizon,
        residualSigmaC ?? undefined,
      );

      // 3. 候选桶（key → bucket）。价格用决策时刻的真实历史价（buildMarketPrices），
      //    避免已结算市场 all_outcomes 的结算价（0/1）污染选桶。
      const marketPrices = buildMarketPrices(raw, snap.ts, history);
      const candidates: CandidateBucket[] = [];
      const yesOf = (key: string): number | undefined => marketPrices.get(key)?.yesPrice;
      for (const bp of distribution.buckets) {
        const market = marketPrices.get(bp.bucket.label);
        if (!market) continue;
        candidates.push({
          bucket: bp.bucket,
          modelProbability: bp.probability,
          yesPrice: market.yesPrice,
          noPrice: 1 - market.yesPrice,
          volumeUsd: market.volumeUsd,
          orderBookImbalance: market.imbalance,
          spatialConfidence: 0.2,
          neighborPrices: {
            lowerYesPrice: undefined,
            higherYesPrice: undefined,
          },
        });
      }
      if (candidates.length === 0) continue;

      // 4. 决策引擎选双桶。
      const decision = decisionEngine.decide({
        city: raw.city as CityId,
        horizon,
        distribution,
        candidates,
        tradingMode: 'paper',
      });
      if (!decision) continue;

      // 5. 入场 edge 直过滤：双桶 pPair 必须 >= 买入成本 + MIN_PAIR_EDGE 才开仓。
      //    只对双桶生效（单桶回退路径不适用）。不过关继续扫 D-2 窗口后续快照；
      //    窗口结束仍不过关则本市场不交易。
      const bucketKeys = decision.buckets.map((b) => b.label);
      const entryPrice = findEntryPrice(raw, bucketKeys, snap.ts, history);
      if (bucketKeys.length === 2 && entryPrice !== null && entryPrice.price != null) {
        const pPair = decision.buckets.reduce((sum, b) => {
          const bp = distribution.buckets.find((x) => x.bucket.label === b.label);
          return sum + (bp?.probability ?? 0);
        }, 0);
        if (pPair - entryPrice.price < MIN_PAIR_EDGE) {
          logger.info(
            `[edge约束] ${marketId} ${snap.horizon} 选桶 ${bucketKeys.join('+')} pPair=${pPair.toFixed(3)} 成本=$${entryPrice.price.toFixed(3)} edge=$${(pPair - entryPrice.price).toFixed(3)} < ${MIN_PAIR_EDGE}，不开仓，继续等`,
          );
          skippedByEdge += 1;
          continue;
        }
      }
      const hit = actualTempC === null ? null : bucketKeys.some((k) => bucketContainsC(bucketsC, k, actualTempC!));

      entry = {
        marketId,
        city: raw.city,
        bucketKeys,
        entryPrice: entryPrice?.price ?? null,
        entrySource: entryPrice?.source ?? null,
        entryTs: entryPrice?.ts ?? null,
        horizon,
        actualTempC,
        hit,
        exitPrice: null,
        profit: null,
        biasApplied,
      };

      if (entry.entryPrice !== null) {
        const exit = findExitPrice(bucketKeys, entry.entryTs, entry.hit, history);
        entry.exitPrice = exit.price;
        if (entry.exitPrice !== null) entry.profit = entry.exitPrice - entry.entryPrice;
      }
      break; // 首个决策即入场，不再看后续快照
    }

    if (entry) {
      entries.push(entry);
    }
  }

  // ==================== 汇总 ====================

  logger.info('========== 全城市模拟汇总 ==========');
  logger.info('样本覆盖', {
    markets: entries.length,
    skippedNoOutcomes: skippedNoOutcomes,
    skippedNoSnapshots: skippedNoSnapshots,
    skippedByEdge: skippedByEdge,
    cities: new Set(entries.map((e) => e.city)).size,
  });

  // 命中率（可验证 = 有 actual 温度）。
  const verifiable = entries.filter((e) => e.hit !== null);
  const hitCount = verifiable.filter((e) => e.hit).length;

  // 盈亏（有真实入场价 + 有退出价）。
  const withPrice = entries.filter((e) => e.entryPrice !== null);
  const settled = withPrice.filter((e) => e.profit !== null);
  const totalPnl = settled.reduce((s, e) => s + (e.profit ?? 0), 0);
  const profitable = settled.filter((e) => (e.profit ?? 0) > 0).length;

  logger.info('结果', {
    '双桶命中率': `${hitCount}/${verifiable.length}（${((hitCount / Math.max(verifiable.length, 1)) * 100).toFixed(1)}%）`,
    '有真实入场价': `${withPrice.length}/${entries.length}`,
    '已结算盈亏': `${profitable}/${settled.length} 笔盈利，合计 $${totalPnl.toFixed(3)}，均值 $${(totalPnl / Math.max(settled.length, 1)).toFixed(3)}`,
  });

  // 分城市明细。
  logger.info('分城市明细');
  const byCity = new Map<string, EntryRecord[]>();
  for (const e of entries) {
    const list = byCity.get(e.city) ?? [];
    list.push(e);
    byCity.set(e.city, list);
  }
  for (const [city, list] of [...byCity.entries()].sort()) {
    const v = list.filter((e) => e.hit !== null);
    const h = v.filter((e) => e.hit).length;
    const s = list.filter((e) => e.profit !== null);
    const pnl = s.reduce((a, e) => a + (e.profit ?? 0), 0);
    const src = list.map((e) => e.entrySource ?? '无').join(',');
    // 本城市入场实际应用的 bias（℃），按数据源平均。
    const biasBySrc = new Map<string, { sum: number; cnt: number }>();
    for (const e of list) {
      for (const [bSrc, biasC] of Object.entries(e.biasApplied)) {
        if (biasC === 0) continue;
        const cur = biasBySrc.get(bSrc) ?? { sum: 0, cnt: 0 };
        cur.sum += biasC;
        cur.cnt += 1;
        biasBySrc.set(bSrc, cur);
      }
    }
    const biasStr = [...biasBySrc.entries()]
      .map(([bSrc, b]) => `${bSrc.replace('open-meteo-', '')}:${(b.sum / b.cnt).toFixed(2)}`)
      .join(' ');
    logger.info(`  ${city}`, {
      markets: list.length,
      hit: `${h}/${v.length}`,
      pnl: s.length ? `$${pnl.toFixed(3)}（${s.length} 笔）` : '无',
      bias: biasStr || '无',
      src,
    });
  }
}

// ==================== 辅助函数 ====================

/** 快照时刻距市场结算的小时数：优先用快照自带 hours_left，缺失时用
 *  event_end_date 兜底计算（对齐 StrategyInstance.hoursToResolution）。 */
function computeHoursLeft(raw: OldMarketFile, ts: string): number | null {
  if (!raw.event_end_date) return null;
  const end = new Date(raw.event_end_date).getTime();
  const at = new Date(ts).getTime();
  if (Number.isNaN(end) || Number.isNaN(at)) return null;
  return (end - at) / (1000 * 60 * 60);
}

function findEntryPrice(
  raw: OldMarketFile,
  bucketKeys: string[],
  ts: string,
  history: PriceHistory | null,
): { price: number; source: 'price-history' | 'all_outcomes'; ts: string | null } | null {
  // 1. 逐桶价格历史。
  if (history) {
    const prices = bucketKeys.map((k) => priceAt(history.get(k) ?? [], ts));
    if (prices.every((p) => p !== null)) {
      return { price: (prices as number[]).reduce((a, b) => a + b, 0), source: 'price-history', ts };
    }
  }
  // 2. 兜底：未结算市场的 all_outcomes 是真实价格。
  if (raw.status !== 'resolved') {
    const keySet = new Set(bucketKeys);
    const price = (raw.all_outcomes ?? [])
      .filter((o) => keySet.has(bucketKey(o.range[0], o.range[1])))
      .reduce((sum, o) => sum + o.price, 0);
    if (price > 0) return { price, source: 'all_outcomes', ts: null };
  }
  return null;
}

function findExitPrice(
  bucketKeys: string[],
  entryTs: string | null,
  hit: boolean | null,
  history: PriceHistory | null,
): { price: number | null } {
  const entryMs = entryTs ? new Date(entryTs).getTime() : 0;

  if (bucketKeys.length === 2 && history) {
    const s1 = history.get(bucketKeys[0]!);
    const s2 = history.get(bucketKeys[1]!);
    if (s1 && s2 && s1.length > 0 && s2.length > 0) {
      const p1At = new Map(s1.map((p) => [p.t, p.p]));
      const p2At = new Map(s2.map((p) => [p.t, p.p]));
      const times = [...new Set<number>([...s1, ...s2].map((p) => p.t))].sort((a, b) => a - b);
      for (const t of times) {
        if (t * 1000 < entryMs) continue;
        const p1 = p1At.get(t);
        const p2 = p2At.get(t);
        if (p1 != null && p2 != null && p1 + p2 >= 0.85) {
          return { price: p1 + p2 };
        }
      }
    }
  }

  if (hit === null) return { price: null };
  return { price: hit ? 1.0 : 0.0 };
}

function bucketContainsC(buckets: TemperatureBucket[], key: string, tempC: number): boolean {
  const bucket = buckets.find((b) => b.label === key);
  if (!bucket) return false;
  if (bucket.minTempC !== null && tempC <= bucket.minTempC) return false;
  if (bucket.maxTempC !== null && tempC > bucket.maxTempC) return false;
  return true;
}

main().catch((error) => {
  logger.error('全城市模拟失败', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
