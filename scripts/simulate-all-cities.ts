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
import { loadAppConfig, loadCityConfig } from '../src/common/config-loader.js';
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

// 双桶入库成本上限：两个桶的 YES 价格之和 ≤ MAX_ENTRY_COST。
// 成本过高说明市场已高度确信，没有足够上行空间（与引擎 MAX_ENTRY_COST 对齐）。
// 用法：MAX_ENTRY_COST=0.70 npx tsx scripts/simulate-all-cities.ts（默认 0.65）
const MAX_ENTRY_COST = Number(process.env.MAX_ENTRY_COST ?? '0.65');

// ==================== 预测漂移离场（2026-08-09 实验开关） ====================
//
// 规则：入场后继续跟踪 ENS 成员落在选中桶组合的区间概率（物理概率），
//   一旦连续 DRIFT_MIN_STREAK 个快照跌破 DRIFT_THRESHOLD，说明模型预测
//   已大幅漂离持仓桶，按该时点的市场卖价提前平仓（避免持有到结算吃满亏损）。
// 用法：
//   DRIFT_EXIT=1 npx tsx scripts/simulate-all-cities.ts        （阈值 20%，连续 1 次）
//   DRIFT_EXIT=1 DRIFT_THRESHOLD=0.2 DRIFT_MIN_STREAK=2 ...    （连续 2 次确认，过滤单次噪音）
// 无 ENS 成员快照的市场（8/4 之前的老市场）不触发漂移，行为与 baseline 一致。
const DRIFT_EXIT = (process.env.DRIFT_EXIT ?? '0') === '1';
const DRIFT_THRESHOLD = Number(process.env.DRIFT_THRESHOLD ?? '0.2');
const DRIFT_MIN_STREAK = Number(process.env.DRIFT_MIN_STREAK ?? '1');

// ==================== 峰值前平仓（2026-08-09 实验开关） ====================
//
// 规则：不再持有到结算，而是在目标日期当天城市"最高温典型出现时间"前
//   EXIT_PEAK_HOURS_BEFORE 小时平仓（按城市时区换算 UTC，用该时点市场卖价）。
// 用法：EXIT_PEAK_HOURS_BEFORE=1 npx tsx scripts/simulate-all-cities.ts
// 与 DRIFT_EXIT 互斥：EXIT_PEAK_HOURS_BEFORE>0 时优先峰值平仓，忽略 DRIFT_EXIT。
// 城市 config 缺失或平仓时刻早于入场时刻时回退基线退出逻辑。
const EXIT_PEAK_HOURS_BEFORE = Number(process.env.EXIT_PEAK_HOURS_BEFORE ?? '0');

// ==================== 峰值前逢高平仓（EXIT_PEAK_HIGH，2026-08-11 实验开关） ====================
//
// 规则：入场后逐时跟踪双桶 bid 之和，在"该城 D0 典型峰值时间"之前，
//   一旦 sumBid >= 阈值（逢高）就按该时点 bid 之和平仓——不等 0.85 死等，
//   提前落袋避免峰值前冲高回落。峰值前未触及阈值 → 回退基线（持有到结算）。
// 用法：EXIT_PEAK_HIGH=0.75 npx tsx scripts/simulate-all-cities.ts
//   与 EXIT_PEAK_HOURS_BEFORE/STOP_LOSS 互斥，EXIT_PEAK_HIGH 优先（用户指定"只用这一个限制"）。
const EXIT_PEAK_HIGH = Number(process.env.EXIT_PEAK_HIGH ?? '0');

// ==================== 双桶止盈目标价（EXIT_SUM，2026-08-12 参数化） ====================
//
// 基线退出逻辑：双桶持仓逐时跟踪 bid 之和，一旦 sumBid >= EXIT_SUM 即平仓
// （生产 ExitStrategy INTERVAL_EXIT_SUM=0.85）。此参数化用于回测 0.85 是否最优。
// 用法：EXIT_SUM=0.80 npx tsx scripts/simulate-all-cities.ts（默认 0.85 对齐生产）
const EXIT_SUM = Number(process.env.EXIT_SUM ?? '0.85');

// ==================== 峰值回撤止盈（EXIT_PULLBACK，2026-08-14 实验开关） ====================
//
// 规则（用户方案）：关闭"峰值前 0.85 提前卖"，改为追踪持仓期间双桶 bid 之和的
//   历史最高点（前一个高点），一旦 sumBid <= 高点 × (1 - PULLBACK) 即按该时点
//   sumBid 平仓——把"预测对了但提前割肉/拿不到 1.0"的利润尽量锁住。
// 用法：EXIT_PULLBACK=0.05 npx tsx scripts/simulate-all-cities.ts
// 开启后忽略 EXIT_SUM（0.85 提前卖关闭），未触发回撤时持有到结算。
const EXIT_PULLBACK = Number(process.env.EXIT_PULLBACK ?? '0');

// ==================== D0 预测失配离场（2026-08-09 实验开关） ====================
//
// 规则：入场后取"最后一个 D+0 快照"（结算当天最新预测），若 ensemble mean
//   （best）温度已不在持仓桶组合内 → 按该时点市场卖价平仓；仍在桶内 →
//   维持原退出逻辑（双桶 0.85 目标价 / 持有到结算）。无 D+0 快照时回退基线。
// 用法：EXIT_D0_MISMATCH=1 npx tsx scripts/simulate-all-cities.ts
const EXIT_D0_MISMATCH = (process.env.EXIT_D0_MISMATCH ?? '0') === '1';

// ==================== 价格止损（2026-08-09 实验开关） ====================
//
// 规则：入场后遍历 price-history 逐时价格，若双桶价格和 ≤ 入场成本 × K
//   （STOP_LOSS_K）→ 提前止损平仓（市场真金白银的定价比模型噪声可靠）；
//   同时保留原 0.85 止盈目标（谁先出现先执行）。可选半仓减仓（STOP_LOSS_HALF=1）
//   只卖一半、剩一半持有到结算，降低尾部风险但不放弃上行。
// 用法：
//   STOP_LOSS_K=0.5 npx tsx scripts/simulate-all-cities.ts        （成本腰斩止损）
//   STOP_LOSS_K=0.33 npx tsx scripts/simulate-all-cities.ts       （跌到1/3止损）
//   STOP_LOSS_K=0.5 STOP_LOSS_HALF=1 npx tsx scripts/...          （半仓减仓）
// 无 price-history 的市场无法逐时跟踪价格，回退基线（持有到结算）。
const STOP_LOSS_K = Number(process.env.STOP_LOSS_K ?? '0');
const STOP_LOSS_HALF = (process.env.STOP_LOSS_HALF ?? '0') === '1';

// ==================== 多桶低价覆盖（2026-08-09 实验开关） ====================
//
// 规则：用 N 个相邻温度桶覆盖更宽区间（单桶概率摊薄→单价更低），
//   选"模型区间概率 − 买入成本"（edge）最大的窗口。命中判定 = 实际温度
//   落在窗口任一桶。ROI 口径与双桶一致（投入 = N 桶价和，命中返回 1.0）。
// 用法：
//   MULTI_BUCKET_N=3 npx tsx scripts/simulate-all-cities.ts      （3桶，成本上限 0.65）
//   MULTI_BUCKET_N=3 MULTI_MAX_COST=0.85 npx tsx scripts/...      （放宽成本上限）
//   MULTI_BUCKET_N=4 MULTI_MAX_COST=1.0 npx tsx scripts/...
// 默认 0 = 生产双桶逻辑（TradingDecisionEngine.decide）。
const MULTI_BUCKET_N = Number(process.env.MULTI_BUCKET_N ?? '0');
const MULTI_MAX_COST = Number(process.env.MULTI_MAX_COST ?? '0.65');
// 排除开放桶（<=x / >=x）：开放桶价格极低但模型尾部概率系统性高估，
// 会把 edge 选桶劫持到"长尾赌注"。=1 时只用闭合桶窗口。
const MULTI_EXCLUDE_OPEN = (process.env.MULTI_EXCLUDE_OPEN ?? '0') === '1';

// ==================== D1 换仓（2026-08-09 实验开关） ====================
//
// 规则：入场后找第一个 D+1 快照，若旧桶对的模型区间概率跌破 SWITCH_THRESHOLD
//   且该快照决策引擎选出了不同的新桶对 → 按当时市场价卖掉旧桶、买回新预测桶，
//   换仓后持有到结算。与"提前离场"不同：资金始终在场内，只是切换持仓标的。
// 用法：
//   SWITCH_D1=1 npx tsx scripts/simulate-all-cities.ts               （阈值 0.25）
//   SWITCH_D1=1 SWITCH_THRESHOLD=0.3 npx tsx scripts/...
const SWITCH_D1 = (process.env.SWITCH_D1 ?? '0') === '1';
const SWITCH_THRESHOLD = Number(process.env.SWITCH_THRESHOLD ?? '0.25');
// 换仓资金约束（方案 1，2026-08-10）：买新桶的钱只能来自卖旧回收。
// 若卖旧回收 < 买新成本，新桶仓位按回收/成本比例缩仓（买不起的部分不买）。
// 默认开启（更贴近真实资金约束）；SWITCH_CAPITAL=0 关闭回退"无限资金"口径。
const SWITCH_CAPITAL = (process.env.SWITCH_CAPITAL ?? '1') === '1';

// ==================== 双桶入场 edge 直过滤（MIN_PAIR_EDGE，2026-08-10 网格实验） ====================
//
// 规则：双桶决策后，若"模型区间概率 pPair − 买入成本 entryPrice" < MIN_PAIR_EDGE，
//   不开仓（模型自己都不信的"贵单"不碰）。只影响入场，不影响已入场持仓。
// 用法：MIN_PAIR_EDGE=0.10 npx tsx scripts/simulate-all-cities.ts
//   默认 0 = 关闭（维持当前生产行为：只有 MAX_ENTRY_COST 成本上限）。
const MIN_PAIR_EDGE = Number(process.env.MIN_PAIR_EDGE ?? '0');

// ==================== Edge/价格比过滤（MIN_PAIR_EDGE_RATIO，2026-08-11 网格实验） ====================
//
// 规则：双桶决策后，edge/价格比 = (pPair − 买入成本) / 买入成本 < 阈值 → 不开仓。
//   与 MIN_PAIR_EDGE（绝对 edge 阈值）正交：它过滤"贵信号"——成本高要求 edge 更高，
//   成本低允许小 edge。体育项目回测（polymarket-zero-cost-quant）ROI +60.9% → +99.7%。
// 用法：MIN_PAIR_EDGE_RATIO=0.12 npx tsx scripts/simulate-all-cities.ts
//   默认 0 = 关闭（维持当前生产行为）。
const MIN_PAIR_EDGE_RATIO = Number(process.env.MIN_PAIR_EDGE_RATIO ?? '0');

// ==================== Edge 比值过滤（EDGE_DIV_MIN，2026-08-12 实验开关） ====================
//
// 规则：edge 定义为比值 = pPair / 买入成本（每花 1 美元买到多少概率），
//   比值 < EDGE_DIV_MIN → 不开仓。与 5.5 绝对 edge / 5.6 减法比值互斥：
//   EDGE_DIV_MIN > 0 时优先替代两者（用户指定"用这个测算"）。
// 换算参考：EDGE_DIV_MIN = 1 + MIN_PAIR_EDGE_RATIO（如 1.30 ≈ 原 0.30）。
// 用法：EDGE_DIV_MIN=1.30 npx tsx scripts/simulate-all-cities.ts
//   默认 0 = 关闭。
const EDGE_DIV_MIN = Number(process.env.EDGE_DIV_MIN ?? '0');

// ==================== 最优单桶 edge 过滤（FILTER_BEST_SINGLE，2026-08-12 实验开关） ====================
//
// 规则：买入仍用最优双桶对，但过滤门槛改用"该对中最优单桶"的 edge
//   （modelProbability − yesPrice 最大的桶），替代双桶区间 edge（pPair − 成本）。
//   目的：第二优桶的市场价噪音（定价偏贵/偏贱）不应否决整个持仓——
//   只要最优单桶自身有足够 edge，双桶区间覆盖仍有价值。
// 用法：FILTER_BEST_SINGLE=1 MIN_PAIR_EDGE=0.10 npx tsx scripts/simulate-all-cities.ts
//   （阈值复用 MIN_PAIR_EDGE；默认 0 = 关闭，维持双桶区间 edge 过滤。）
const FILTER_BEST_SINGLE = (process.env.FILTER_BEST_SINGLE ?? '0') === '1';

// ==================== 模型-市场分歧保护（FILTER_MARKET_GAP，2026-08-14） ====================
//
// 规则：持仓桶市场价相对模型概率严重低估（yesPrice < 模型概率 × 0.4）→ 不开仓。
//   市场比模型更了解实时天气，模型高概率 + 市场极低价 = 预测大概率偏了
//   （wellington 08-13 循环案例：模型 67% vs 市场 0.19，止损→重开 11 次单日 -$8.89）。
// 用法：FILTER_MARKET_GAP=1 npx tsx scripts/simulate-all-cities.ts（阈值 MARKET_GAP_RATIO，默认 0.4）
const FILTER_MARKET_GAP = (process.env.FILTER_MARKET_GAP ?? '0') === '1';
const MARKET_GAP_RATIO = Number(process.env.MARKET_GAP_RATIO ?? '0.4');

// ==================== 只看最近 N 天市场（SINCE_DAYS，2026-08-11） ====================
//
// 用法：SINCE_DAYS=7 npx tsx scripts/simulate-all-cities.ts
//   只回测目标日期在最近 N 天内的市场（已结算的计入盈亏，未结算的空跑决策不计盈亏）。
const SINCE_DAYS = Number(process.env.SINCE_DAYS ?? '0');

// ==================== 精确起始日期（SINCE_DATE，2026-08-14） ====================
//
// 用法：SINCE_DATE=2026-08-04 npx tsx scripts/simulate-all-cities.ts
//   只回测目标日期 >= 该日期的市场（字符串比较，YYYY-MM-DD）。
//   优先级高于 SINCE_DAYS：两者都设时以 SINCE_DATE 为准。
const SINCE_DATE = process.env.SINCE_DATE ?? '';

// ==================== 强制单桶买入（SINGLE_BUCKET_ONLY，2026-08-12 实验开关） ====================
//
// 规则：跳过双桶选对，直接在候选桶里选"低价高赔率"单桶：
//   候选 = 有成交量的 YES 桶，价格 <= SINGLE_MAX_PRICE（低价），
//   edge = modelProbability − yesPrice > 0；按 edge 降序选最优桶。
//   与 MIN_PAIR_EDGE_RATIO 配合：加 edge/价格比过滤（用户方案：
//   "选择低价高赔率市场，虽然命中率会降低"）。
// 用法：
//   SINGLE_BUCKET_ONLY=1 MIN_PAIR_EDGE_RATIO=0.8 npx tsx scripts/simulate-all-cities.ts
const SINGLE_BUCKET_ONLY = (process.env.SINGLE_BUCKET_ONLY ?? '0') === '1';
const SINGLE_MAX_PRICE = Number(process.env.SINGLE_MAX_PRICE ?? '0.30');

// ==================== D1 加仓（SWITCH_ADD，2026-08-09 实验开关） ====================
//
// 规则：触发条件与 SWITCH_D1 完全相同（D+1 旧桶模型概率跌破阈值且引擎选出不同新桶），
//   但不停掉旧桶——保留原持仓，同时按当时市场价直接买入新桶（加仓覆盖）。
//   结算时旧桶、新桶各自独立结算（命中 1.0 / 未中 0），任一命中都算命中。
//   与"换仓"的区别：换仓是资金切换（卖旧买新），加仓是资金翻倍（旧仓不动+新仓）。
// 用法：SWITCH_ADD=1 npx tsx scripts/simulate-all-cities.ts
//   与 SWITCH_D1 互斥，SWITCH_ADD 优先。
const SWITCH_ADD = (process.env.SWITCH_ADD ?? '0') === '1';

/** 城市峰值时间缓存：cityId → { tz, hh, mm }（typical）。 */
const peakCache = new Map<string, { tz: string; hh: number; mm: number } | null>();

function peakTimeFor(city: string): { tz: string; hh: number; mm: number } | null {
  if (peakCache.has(city)) return peakCache.get(city) ?? null;
  try {
    const cfg = loadCityConfig(city as CityId);
    const [hh, mm] = cfg.peakTimeLocal.typical.split(':').map(Number);
    const v = { tz: cfg.timezone, hh: hh ?? 14, mm: mm ?? 0 };
    peakCache.set(city, v);
    return v;
  } catch {
    peakCache.set(city, null);
    return null;
  }
}

/** IANA 时区在 tsMs 时刻相对 UTC 的偏移（毫秒）。 */
function tzOffsetMs(tsMs: number, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(tsMs))) parts[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  return asUTC - tsMs;
}

/** 目标日期（本地时区）典型峰值时刻 - hoursBefore 小时的 UTC 毫秒。
 *  tzOffsetMs 返回的是"该 UTC 墙钟时刻在 tz 显示的绝对时刻"相对输入的偏移，
 *  本地墙钟 → UTC 需减去偏移（utc = local - offset）。 */
function peakExitMs(targetDate: string, peak: { tz: string; hh: number; mm: number }, hoursBefore: number): number {
  const [y, m, d] = targetDate.split('-').map(Number);
  const localNaiveMs = Date.UTC(y!, m! - 1, d!, peak.hh, peak.mm, 0);
  return localNaiveMs - tzOffsetMs(localNaiveMs, peak.tz) - hoursBefore * 3600_000;
}

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

/**
 * 多桶低价覆盖选桶（MULTI_BUCKET_N）：
 *   把有市场价格的分布桶按温度升序排列，滑过所有相邻 N 桶窗口，
 *   过滤"成本 ≤ MULTI_MAX_COST"后，选 edge = 模型区间概率 − 买入成本 最大的窗口。
 */
function selectMultiBucket(
  distribution: ProbabilityDistribution,
  marketPrices: Map<string, MarketPrice>,
  n: number,
  maxCost: number,
): { keys: string[]; cost: number; pSum: number } | null {
  const parseLo = (label: string): number => {
    const m = label.match(/-?\d+\.?\d*/);
    return m ? Number(m[0]) : 0;
  };
  const rows = distribution.buckets
    .map((b) => ({
      label: b.bucket.label,
      p: b.probability,
      yes: marketPrices.get(b.bucket.label)?.yesPrice,
    }))
    .filter((r): r is { label: string; p: number; yes: number } => r.yes !== undefined)
    .filter((r) => !MULTI_EXCLUDE_OPEN || (!r.label.startsWith('<=') && !r.label.startsWith('>=')))
    .sort((a, b) => parseLo(a.label) - parseLo(b.label));

  let best: { keys: string[]; cost: number; pSum: number; edge: number } | null = null;
  for (let i = 0; i + n <= rows.length; i += 1) {
    const win = rows.slice(i, i + n);
    const cost = win.reduce((s, r) => s + r.yes, 0);
    const pSum = win.reduce((s, r) => s + r.p, 0);
    if (cost > maxCost) continue;
    const edge = pSum - cost;
    if (best === null || edge > best.edge) {
      best = { keys: win.map((r) => r.label), cost, pSum, edge };
    }
  }
  return best ? { keys: best.keys, cost: best.cost, pSum: best.pSum } : null;
}

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
  // 预测漂移离场（DRIFT_EXIT）：是否因 ENS 区间概率跌破阈值提前平仓。
  driftExit?: boolean;
  driftThreshold?: number;
  // 峰值前平仓（EXIT_PEAK_HOURS_BEFORE）：平仓时刻（UTC ISO）。
  peakExitTs?: string;
  // 峰值前逢高平仓（EXIT_PEAK_HIGH）：峰值前 sumBid 触及阈值提前落袋。
  peakHighExit?: boolean;
  peakHighTarget?: number;
  // D0 预测失配离场（EXIT_D0_MISMATCH）：D0 最新预测不在桶内提前平仓。
  d0MismatchExit?: boolean;
  // 价格止损（STOP_LOSS_K）：双桶市场价跌破入场成本×K 提前平仓（或半仓减仓）。
  stopLossExit?: boolean;
  // 峰值回撤止盈（EXIT_PULLBACK）：从持仓期间高点回撤 >= PULLBACK 平仓。
  pullbackExit?: boolean;
  // D1 换仓（SWITCH_D1）：入场后 D+1 预测漂移，卖旧桶买新桶。
  switched?: boolean;
  switchKeys?: string[];
  switchSell?: number;
  switchBuy?: number;
  switchTs?: string;
  // D1 加仓（SWITCH_ADD）：不卖旧桶，额外买入新桶的成本（旧桶成本仍在 entryPrice）。
  addCost?: number;
}

async function main(): Promise<void> {
  // 加载所有城市配置（用于每个城市独立的 TradingDecisionEngine，如 dispersionPenalty 权重）。
  const cityConfigs = new Map<string, CityConfig>();
  for (const city of ['shanghai', 'nyc', 'london', 'paris', 'munich', 'tokyo', 'seoul', 'singapore', 'tel-aviv', 'ankara', 'lucknow', 'wellington', 'miami', 'dallas', 'chicago', 'denver', 'phoenix', 'la', 'sf', 'dc', 'seattle']) {
    try { cityConfigs.set(city, loadAppConfig(city).city); } catch { /* 跳过配置缺失的城市 */ }
  }
  // 回退：用 shanghai 配置拿 scoringWeights / risk（旧行为）。
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

    // SINCE_DAYS：只看目标日期在最近 N 天内的市场（YYYY-MM-DD 可直接字符串比较）。
    // SINCE_DATE 优先：目标日期 < 指定日期直接跳过。
    if (SINCE_DATE) {
      if (raw.date < SINCE_DATE) continue;
    } else if (SINCE_DAYS > 0) {
      const sinceDate = new Date(Date.now() - SINCE_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10);
      if (raw.date < sinceDate) continue;
    }

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
	    const cityCfg = cityConfigs.get(raw.city) ?? shanghaiConfig;
	    const decisionEngine = new TradingDecisionEngine(cityCfg);

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

      // 4. 选桶：多桶模式（MULTI_BUCKET_N≥3）用相邻 N 桶窗口 + edge 最大；
      //    默认双桶走生产引擎 TradingDecisionEngine.decide。
      let bucketKeys: string[] = [];
      let pairEdge: number | null = null; // 双桶模型区间概率 − 买入成本（MIN_PAIR_EDGE 过滤用）
      if (MULTI_BUCKET_N >= 3) {
        const sel = selectMultiBucket(distribution, marketPrices, MULTI_BUCKET_N, MULTI_MAX_COST);
        if (!sel) continue;
        bucketKeys = sel.keys;
        logger.info(`[MULTI] ${marketId} ${snap.horizon} 选 ${MULTI_BUCKET_N} 桶 ${sel.keys.join('+')} 成本=$${sel.cost.toFixed(3)} pSum=${sel.pSum.toFixed(3)} edge=${(sel.pSum - sel.cost).toFixed(3)}`);
      } else if (SINGLE_BUCKET_ONLY) {
        // 强制单桶：低价高赔率路径（跳过双桶选对）。
        // 候选 = 有成交量的 YES 桶，价格 ≤ SINGLE_MAX_PRICE，edge = 模型概率 − 价格 > 0；
        // 按 edge 降序选最优（价格由 SINGLE_MAX_PRICE 锁"低价"，ratio 由 MIN_PAIR_EDGE_RATIO 过滤）。
        const singles = candidates.filter(
          (c) =>
            c.yesPrice > 0 &&
            c.yesPrice <= SINGLE_MAX_PRICE &&
            c.volumeUsd > 0 &&
            c.modelProbability - c.yesPrice > 0,
        );
        if (singles.length === 0) continue;
        singles.sort(
          (a, b) => (b.modelProbability - b.yesPrice) - (a.modelProbability - a.yesPrice),
        );
        const best = singles[0]!;
        bucketKeys = [best.bucket.label];
        pairEdge = best.modelProbability - best.yesPrice;
        logger.info(`[SINGLE] ${marketId} ${snap.horizon} 选桶 ${best.bucket.label} price=$${best.yesPrice.toFixed(3)} p=${best.modelProbability.toFixed(3)} edge=${pairEdge.toFixed(3)} ratio=${(pairEdge / best.yesPrice).toFixed(3)}`);
      } else {
        const decision = decisionEngine.decide({
          city: raw.city as CityId,
          horizon,
          distribution,
          candidates,
          tradingMode: 'paper',
        });
        if (!decision) continue;
        bucketKeys = decision.buckets.map((b) => b.label);
        // 区间概率 pPair = 选中两桶的模型概率之和（从 candidates 取回概率）。
        const pPair = decision.buckets.reduce((sum, b) => {
          const c = candidates.find((x) => x.bucket.label === b.label);
          return sum + (c?.modelProbability ?? 0);
        }, 0);
        pairEdge = pPair - decision.entryPrice;
      }

      // 5. 成本过滤：双桶 YES 价格之和必须 ≤ MAX_ENTRY_COST。
      //    引擎 decide() 已选"模型和市场最一致"的桶对并做成本过滤，
      //    这里再兜底校验一次（与引擎 MAX_ENTRY_COST 对齐，防止成本过高）。
      const entryPrice = findEntryPrice(raw, bucketKeys, snap.ts, history);
      const costLimit = MULTI_BUCKET_N >= 3 ? MULTI_MAX_COST : MAX_ENTRY_COST;
      if (bucketKeys.length >= 2 && entryPrice !== null && entryPrice.price != null) {
        if (entryPrice.price > costLimit) {
          logger.info(
            `[成本约束] ${marketId} ${snap.horizon} 选桶 ${bucketKeys.join('+')} 成本=$${entryPrice.price.toFixed(3)} > ${costLimit}，不开仓，继续等`,
          );
          skippedByEdge += 1;
          continue;
        }
      }

      // 5.54 最优单桶 edge（FILTER_BEST_SINGLE 用）：该桶对中 modelProbability − yesPrice 最大的桶。
      //    买入仍是双桶对，但过滤只看最优单桶自身 edge，屏蔽第二优桶的市场价噪音。
      const bestSingleEdge = (() => {
        let m = -Infinity;
        for (const k of bucketKeys) {
          const c = candidates.find((x) => x.bucket.label === k);
          if (c && c.yesPrice > 0) m = Math.max(m, c.modelProbability - c.yesPrice);
        }
        return m === -Infinity ? null : m;
      })();

      // 5.56 模型-市场分歧保护（FILTER_MARKET_GAP，2026-08-14）：
      //    只看"最优单桶"（edge 最大的桶）的市场价/模型比值——辅助桶市场价低是
      //    市场对次要桶的定价，不应连坐主桶（wellington 08-07 案例：辅助桶 11°C=0.025
      //    触发拦截，主桶 12°C 实际命中，连坐误杀了赢单）。最优单桶被市场严重低估
      //    （yesPrice < 模型概率 × 0.4）说明整个持仓的核心逻辑站不住 → 不开仓。
      if (FILTER_MARKET_GAP && bucketKeys.length >= 1) {
        let bestGap: { key: string; modelProbability: number; yesPrice: number } | null = null;
        for (const k of bucketKeys) {
          const c = candidates.find((x) => x.bucket.label === k);
          if (!c || c.yesPrice <= 0) continue;
          if (
            bestGap === null ||
            c.modelProbability - c.yesPrice >
              bestGap.modelProbability - bestGap.yesPrice
          ) {
            bestGap = {
              key: k,
              modelProbability: c.modelProbability,
              yesPrice: c.yesPrice,
            };
          }
        }
        if (bestGap && bestGap.yesPrice < bestGap.modelProbability * MARKET_GAP_RATIO) {
          logger.info(
            `[MARKET GAP] ${marketId} ${snap.horizon} 选桶 ${bucketKeys.join('+')} 最优单桶 ${bestGap.key}=$${bestGap.yesPrice.toFixed(3)} vs 模型${bestGap.modelProbability.toFixed(3)}×${MARKET_GAP_RATIO}，市场价相对模型概率严重低估，不开仓，继续等`,
          );
          skippedByEdge += 1;
          continue;
        }
      }

      // 5.55 Edge 比值过滤（EDGE_DIV_MIN）：edge = pPair / 买入成本 ≥ 阈值才开仓。
      //    每花 1 美元买到多少概率。优先于 5.5 绝对 edge 与 5.6 减法比值（用户指定"用这个测算"）。
      if (EDGE_DIV_MIN > 0 && entryPrice?.price != null && entryPrice.price > 0) {
        const pPair2 = (pairEdge ?? 0) + entryPrice.price; // pPair = edge + 成本
        const div = pPair2 / entryPrice.price;
        if (div < EDGE_DIV_MIN) {
          logger.info(
            `[EDGE DIV] ${marketId} ${snap.horizon} 选桶 ${bucketKeys.join('+')} pPair/成本=${div.toFixed(3)} < ${EDGE_DIV_MIN}，不开仓，继续等`,
          );
          skippedByEdge += 1;
          continue;
        }
      } else if (FILTER_BEST_SINGLE && bestSingleEdge !== null && bestSingleEdge < MIN_PAIR_EDGE) {
        // 5.54 最优单桶 edge 过滤：最优单桶 edge < MIN_PAIR_EDGE 不开仓。
        //    桶对中最优的那个桶都没有足够 edge，整个持仓就不值得（第二优桶不背锅）。
        logger.info(
          `[BEST SINGLE] ${marketId} ${snap.horizon} 选桶 ${bucketKeys.join('+')} 最优单桶edge=${bestSingleEdge.toFixed(3)} < MIN_PAIR_EDGE=${MIN_PAIR_EDGE}，不开仓，继续等`,
        );
        skippedByEdge += 1;
        continue;
      } else if (MIN_PAIR_EDGE > 0 && pairEdge !== null && pairEdge < MIN_PAIR_EDGE) {
        logger.info(
          `[EDGE] ${marketId} ${snap.horizon} 选桶 ${bucketKeys.join('+')} pPair-edge=$${pairEdge.toFixed(3)} < MIN_PAIR_EDGE=${MIN_PAIR_EDGE}，不开仓，继续等`,
        );
        skippedByEdge += 1;
        continue;
      } else if (
        MIN_PAIR_EDGE_RATIO > 0 &&
        pairEdge !== null &&
        entryPrice?.price != null &&
        entryPrice.price > 0
      ) {
        const ratio = pairEdge / entryPrice.price;
        if (ratio < MIN_PAIR_EDGE_RATIO) {
          logger.info(
            `[EDGE RATIO] ${marketId} ${snap.horizon} 选桶 ${bucketKeys.join('+')} edge/成本=${ratio.toFixed(3)} < ${MIN_PAIR_EDGE_RATIO}，不开仓，继续等`,
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
        const entryMs = entry.entryTs ? new Date(entry.entryTs).getTime() : 0;

        // 加仓（SWITCH_ADD）：触发条件同 SWITCH_D1，但不停旧桶——保留原持仓，
        // 同时按当时市场价直接买入新桶。结算时旧桶、新桶各自独立结算，任一命中即命中。
        if (SWITCH_ADD) {
          const sw = findD1Switch(raw, bucketKeys, entryMs, history, bucketsC, SWITCH_THRESHOLD, allFiles);
          if (sw) {
            const oldKeys = bucketKeys;
            entry.switched = true;
            entry.switchKeys = sw.newKeys;
            entry.switchBuy = sw.buy;
            entry.switchTs = sw.ts;
            entry.addCost = sw.buy;
            const hitOld =
              actualTempC === null
                ? null
                : oldKeys.some((k) => bucketContainsC(bucketsC, k, actualTempC!));
            const hitNew =
              actualTempC === null
                ? null
                : sw.newKeys.some((k) => bucketContainsC(bucketsC, k, actualTempC!));
            entry.hit = hitOld === null ? null : hitOld || hitNew;
            if (entry.hit === null) {
              // 未结算市场（无实际温度）：不记盈亏，只标记加仓发生。
              entry.switched = true;
            } else {
              const settleOld = hitOld ? 1.0 : 0.0;
              const settleNew = hitNew ? 1.0 : 0.0;
              entry.exitPrice = settleOld + settleNew;
              // 盈亏 = 旧桶段（结算-入场成本）+ 新桶段（结算-加仓成本）。
              entry.profit = settleOld - entry.entryPrice + settleNew - sw.buy;
              logger.info(`[SWITCH_ADD] ${marketId} 入场${entry.entryTs} 旧桶${oldKeys.join('+')}+新桶${sw.newKeys.join('+')} pSum≤${SWITCH_THRESHOLD} 旧@$${entry.entryPrice.toFixed(3)} 加买新@$${sw.buy.toFixed(3)} → 结算旧${hitOld ? '命中' : '未中'}新${hitNew ? '命中' : '未中'} profit=$${entry.profit.toFixed(3)}`);
            }
          }
        } else if (SWITCH_D1) {
          const sw = findD1Switch(raw, bucketKeys, entryMs, history, bucketsC, SWITCH_THRESHOLD, allFiles);
          if (sw) {
            const oldKeys = bucketKeys;
            entry.switched = true;
            entry.switchKeys = sw.newKeys;
            entry.switchSell = sw.sell;
            entry.switchBuy = sw.buy;
            entry.switchTs = sw.ts;
            bucketKeys = sw.newKeys;
            entry.hit = actualTempC === null ? null : sw.newKeys.some((k) => bucketContainsC(bucketsC, k, actualTempC!));
            if (entry.hit === null) {
              // 未结算市场（无实际温度）：不记盈亏，只标记换仓发生。
              entry.switched = true;
            } else {
              const settle = entry.hit ? 1.0 : 0.0;
              entry.exitPrice = settle;
              if (SWITCH_CAPITAL && sw.sell < sw.buy) {
                // 资金约束：新桶仓位 = 卖旧回收 / 买新成本（买得起多少买多少）。
                const scale = sw.buy > 0 ? sw.sell / sw.buy : 0;
                entry.capitalShort = sw.buy - sw.sell;
                entry.capitalScale = scale;
                entry.profit = sw.sell - entry.entryPrice + (settle - sw.buy) * scale;
              } else {
                // 无限资金口径（原公式）：卖出价和买入价都按每股 1 份算。
                entry.profit = (sw.sell - entry.entryPrice) + (settle - sw.buy);
              }
              logger.info(`[SWITCH] ${marketId} 入场${entry.entryTs} 旧桶${oldKeys.join('+')}→新桶${sw.newKeys.join('+')} pSum≤${SWITCH_THRESHOLD} 卖旧@$${sw.sell.toFixed(3)} 买新@$${sw.buy.toFixed(3)} ${entry.capitalShort ? `[资金缺口 ${entry.capitalShort.toFixed(3)} scale ${entry.capitalScale!.toFixed(2)}] ` : ''}→ 结算${entry.hit ? '命中' : '未中'} profit=$${entry.profit.toFixed(3)}`);
            }
          }
        }

        // 退出逻辑优先级：峰值回撤模式（EXIT_PULLBACK，内部先止损再回撤，关闭 0.85）
        // > 价格止损（STOP_LOSS_K）> 峰值前逢高（EXIT_PEAK_HIGH）
        // > 峰值前平仓（EXIT_PEAK_HOURS_BEFORE）> D0 预测失配（EXIT_D0_MISMATCH）
        // > 预测漂移离场（DRIFT_EXIT）> 基线。
        let exit: { price: number | null; driftExit: boolean };
        if (entry.switched) {
          exit = { price: entry.exitPrice, driftExit: false };
        } else if (EXIT_PULLBACK > 0) {
          // 峰值回撤模式：关闭 0.85 提前卖。
          //   1) 先查价格止损（noSumExit=true：只做止损、不做 0.85 止盈）；
          //   2) 止损未触发则查"从持仓高点回撤 PULLBACK"→ 平仓；
          //   3) 都不触发 → 持有到结算。
          let pbPrice: number | null = null;
          if (STOP_LOSS_K > 0) {
            const sl = findStopLossExit(
              bucketKeys,
              entry.entryTs,
              entry.hit,
              history,
              entry.entryPrice,
              STOP_LOSS_K,
              STOP_LOSS_HALF,
              true,
            );
            if (sl.stopLoss) {
              pbPrice = sl.price;
              entry.stopLossExit = true;
            }
          }
          if (pbPrice === null) {
            const pb = findPullbackExit(bucketKeys, entry.entryTs, history, EXIT_PULLBACK);
            pbPrice = pb.price;
            if (pb.price !== null) entry.pullbackExit = true;
          }
          exit = { price: pbPrice, driftExit: false };
        } else if (EXIT_PEAK_HIGH > 0) {
          // 峰值前逢高：只在该城 D0 典型峰值时刻之前有效。
          const peak = peakTimeFor(raw.city);
          const peakMs = peak ? peakExitMs(raw.date, peak, 0) : 0;
          const hi = findPeakHighExit(bucketKeys, entry.entryTs, entry.hit, history, peakMs, EXIT_PEAK_HIGH);
          exit = { price: hi.price, driftExit: false };
          if (hi.price !== null) {
            entry.peakHighExit = true;
            entry.peakHighTarget = EXIT_PEAK_HIGH;
          }
        } else if (STOP_LOSS_K > 0) {
          // 价格止损：双桶市场价跌破入场成本×K 提前平仓（0.85 止盈优先）。
          const sl = findStopLossExit(
            bucketKeys,
            entry.entryTs,
            entry.hit,
            history,
            entry.entryPrice,
            STOP_LOSS_K,
            STOP_LOSS_HALF,
            false,
          );
          exit = { price: sl.price, driftExit: false };
          if (sl.stopLoss) entry.stopLossExit = true;
        } else if (EXIT_PEAK_HOURS_BEFORE > 0) {
          const peak = peakTimeFor(raw.city);
          const peakMs = peak ? peakExitMs(raw.date, peak, EXIT_PEAK_HOURS_BEFORE) : 0;
          if (peak && peakMs > entryMs) {
            const sell = findPriceAt(raw, bucketKeys, new Date(peakMs).toISOString(), history);
            if (sell !== null) {
              exit = { price: sell, driftExit: false };
              entry.peakExitTs = new Date(peakMs).toISOString();
            } else {
              exit = { price: null, driftExit: false };
            }
          } else {
            exit = { price: null, driftExit: false };
          }
        } else if (EXIT_D0_MISMATCH) {
          const d0 = findD0MismatchExit(raw, bucketKeys, entryMs, entry.hit, history, bucketsC);
          exit = { price: d0.price, driftExit: false };
          if (d0.d0Mismatch) entry.d0MismatchExit = true;
        } else if (DRIFT_EXIT) {
          exit = findDriftExit(
            raw,
            bucketKeys,
            entryMs,
            entry.hit,
            history,
            DRIFT_THRESHOLD,
            bucketsC,
            DRIFT_MIN_STREAK,
          );
        } else {
          exit = { price: null, driftExit: false };
        }
        if (exit.price === null) {
          if (EXIT_PULLBACK > 0) {
            // 峰值回撤模式：关闭 0.85 提前卖，未触发回撤则持有到结算。
            exit.price = entry.hit === null ? null : (entry.hit ? 1.0 : 0.0);
          } else {
            const base = findExitPrice(bucketKeys, entry.entryTs, entry.hit, history);
            exit.price = base.price;
          }
        }
        entry.exitPrice = exit.price;
        // 换仓笔的盈亏已在换仓时按"旧桶段+新桶段"算好，不能再按结算价覆盖。
        if (exit.price !== null && !entry.switched) entry.profit = exit.price - entry.entryPrice;
        if (exit.driftExit) {
          entry.driftExit = true;
          entry.driftThreshold = DRIFT_THRESHOLD;
        }
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
  const totalEntryUsd = settled.reduce((s, e) => s + (e.entryPrice ?? 0) + (e.addCost ?? 0), 0);
  const profitable = settled.filter((e) => (e.profit ?? 0) > 0).length;

  logger.info('结果', {
    '双桶命中率': `${hitCount}/${verifiable.length}（${((hitCount / Math.max(verifiable.length, 1)) * 100).toFixed(1)}%）`,
    '有真实入场价': `${withPrice.length}/${entries.length}`,
    '已结算盈亏': `${profitable}/${settled.length} 笔盈利，合计 $${totalPnl.toFixed(3)}，均值 $${(totalPnl / Math.max(settled.length, 1)).toFixed(3)}`,
    'ROI(投入1美元收益)': `${((totalPnl / Math.max(totalEntryUsd, 0.0001)) * 100).toFixed(1)}%`,
    '模式': MULTI_BUCKET_N >= 3 ? `${MULTI_BUCKET_N}桶(cost≤${MULTI_MAX_COST})` : '双桶',
  });

  if (DRIFT_EXIT) {
    const driftN = entries.filter((e) => e.driftExit).length;
    const driftPnl = settled.filter((e) => e.driftExit).reduce((s, e) => s + (e.profit ?? 0), 0);
    logger.info('预测漂移离场（DRIFT_EXIT）', {
      阈值: DRIFT_THRESHOLD,
      触发笔数: driftN,
      触发后盈亏合计: `$${driftPnl.toFixed(3)}`,
    });
  }

  if (EXIT_PEAK_HOURS_BEFORE > 0) {
    const peakN = entries.filter((e) => e.peakExitTs).length;
    const peakPnl = settled.filter((e) => e.peakExitTs).reduce((s, e) => s + (e.profit ?? 0), 0);
    logger.info('峰值前平仓（EXIT_PEAK_HOURS_BEFORE）', {
      提前小时数: EXIT_PEAK_HOURS_BEFORE,
      触发笔数: peakN,
      触发后盈亏合计: `$${peakPnl.toFixed(3)}`,
    });
  }

  if (EXIT_PEAK_HIGH > 0) {
    const highN = entries.filter((e) => e.peakHighExit).length;
    const highPnl = settled.filter((e) => e.peakHighExit).reduce((s, e) => s + (e.profit ?? 0), 0);
    logger.info('峰值前逢高平仓（EXIT_PEAK_HIGH）', {
      逢高阈值: EXIT_PEAK_HIGH,
      触发笔数: highN,
      触发后盈亏合计: `$${highPnl.toFixed(3)}`,
    });
  }

  if (EXIT_D0_MISMATCH) {
    const d0N = entries.filter((e) => e.d0MismatchExit).length;
    const d0Pnl = settled.filter((e) => e.d0MismatchExit).reduce((s, e) => s + (e.profit ?? 0), 0);
    logger.info('D0 预测失配离场（EXIT_D0_MISMATCH）', {
      触发笔数: d0N,
      触发后盈亏合计: `$${d0Pnl.toFixed(3)}`,
    });
  }

  if (STOP_LOSS_K > 0) {
    const slN = entries.filter((e) => e.stopLossExit).length;
    const slPnl = settled.filter((e) => e.stopLossExit).reduce((s, e) => s + (e.profit ?? 0), 0);
    logger.info('价格止损（STOP_LOSS_K）', {
      系数: STOP_LOSS_K,
      半仓: STOP_LOSS_HALF,
      触发笔数: slN,
      触发后盈亏合计: `$${slPnl.toFixed(3)}`,
    });
  }

  if (EXIT_PULLBACK > 0) {
    const pbN = entries.filter((e) => e.pullbackExit).length;
    const pbPnl = settled.filter((e) => e.pullbackExit).reduce((s, e) => s + (e.profit ?? 0), 0);
    logger.info('峰值回撤止盈（EXIT_PULLBACK）', {
      回撤阈值: EXIT_PULLBACK,
      触发笔数: pbN,
      触发后盈亏合计: `$${pbPnl.toFixed(3)}`,
    });
  }

  if (SWITCH_ADD) {
    const swN = entries.filter((e) => e.switched).length;
    const swPnl = settled.filter((e) => e.switched).reduce((s, e) => s + (e.profit ?? 0), 0);
    logger.info('D1 加仓（SWITCH_ADD，不卖旧桶直接买新）', {
      阈值: SWITCH_THRESHOLD,
      触发笔数: swN,
      加仓后盈亏合计: `$${swPnl.toFixed(3)}`,
    });
  }

  if (SWITCH_D1) {
    const swN = entries.filter((e) => e.switched).length;
    const swPnl = settled.filter((e) => e.switched).reduce((s, e) => s + (e.profit ?? 0), 0);
    const shortN = settled.filter((e) => e.capitalShort !== undefined && e.capitalShort > 0).length;
    const shortSum = settled.filter((e) => e.capitalShort !== undefined).reduce((s, e) => s + e.capitalShort!, 0);
    const scaleAvg =
      shortN > 0
        ? settled.filter((e) => e.capitalScale !== undefined).reduce((s, e) => s + e.capitalScale!, 0) /
          settled.filter((e) => e.capitalScale !== undefined).length
        : 1;
    logger.info('D1 换仓（SWITCH_D1）', {
      阈值: SWITCH_THRESHOLD,
      资金约束: SWITCH_CAPITAL ? '开' : '关',
      触发笔数: swN,
      换仓后盈亏合计: `$${swPnl.toFixed(3)}`,
      资金缺口笔数: shortN,
      缺口合计: `$${shortSum.toFixed(3)}`,
      平均缩仓比例: `${(scaleAvg * 100).toFixed(1)}%`,
    });
  }

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

  // 导出 CSV：交易明细 + 汇总。
  exportCsv(entries);
}

// ==================== CSV 导出 ====================

/** 转义 CSV 字段：包引号、内部双引号翻倍。 */
function csvField(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 每笔交易导出一行。 */
function csvRow(e: EntryRecord): string {
  const biasE = e.biasApplied['open-meteo-ecmwf'];
  const biasG = e.biasApplied['open-meteo-gfs'];
  const biasI = e.biasApplied['open-meteo-icon'];
  return [
    csvField(e.marketId),
    csvField(e.city),
    csvField(e.marketId.split('_')[1] ?? ''),
    csvField(e.bucketKeys.join('+')),
    csvField(e.entryPrice),
    csvField(e.entrySource),
    csvField(e.entryTs),
    csvField(e.horizon),
    csvField(e.actualTempC),
    csvField(e.hit === null ? '' : e.hit ? '命中' : '未中'),
    csvField(e.exitPrice),
    csvField(e.profit),
    csvField(e.driftExit ? '是' : e.driftExit === undefined ? '' : '否'),
    csvField(e.driftThreshold ?? ''),
    csvField(e.peakExitTs ?? ''),
    csvField(e.d0MismatchExit ? '是' : ''),
    csvField(e.stopLossExit ? '是' : ''),
    csvField(biasE == null ? '' : biasE),
    csvField(biasG == null ? '' : biasG),
    csvField(biasI == null ? '' : biasI),
  ].join(',');
}

/** 导出交易明细 + 汇总两份 CSV 到 data/backtest/。返回导出的文件路径。 */
function exportCsv(entries: EntryRecord[]): { detailPath: string; summaryPath: string } {
  const outDir = path.join(process.cwd(), 'data', 'backtest');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const detailPath = path.join(outDir, `backtest-detail_${stamp}.csv`);
  const summaryPath = path.join(outDir, `backtest-summary_${stamp}.csv`);

  // 明细表头（中文）。
  const header = [
    '市场ID', '城市', '日期', '桶组合', '入场价', '价格来源', '入场时间',
    '入场水平', '实际温度C', '结算结果', '退出价', '盈亏',
    '漂移离场', '漂移阈值', '峰值离场时间', 'D0失配离场', '价格止损',
    'ECMWF偏差C', 'GFS偏差C', 'ICON偏差C',
  ].join(',');
  const detailLines = [header, ...entries.map(csvRow)];
  fs.writeFileSync(detailPath, `${detailLines.join('\n')}\n`, 'utf8');

  // 汇总：总体 + 分城市。
  const summaryRows: string[] = [];
  summaryRows.push('维度,指标,数值');

  const verifiable = entries.filter((e) => e.hit !== null);
  const hitCount = verifiable.filter((e) => e.hit).length;
  const settled = entries.filter((e) => e.profit !== null);
  const totalPnl = settled.reduce((s, e) => s + (e.profit ?? 0), 0);
  const totalEntryUsd = settled.reduce((s, e) => s + (e.entryPrice ?? 0) + (e.addCost ?? 0), 0);
  const profitable = settled.filter((e) => (e.profit ?? 0) > 0).length;

  summaryRows.push('总体,市场数', csvField(entries.length));
  summaryRows.push('总体,城市数', csvField(new Set(entries.map((e) => e.city)).size));
  summaryRows.push('总体,命中率', csvField(`${hitCount}/${verifiable.length}`));
  summaryRows.push('总体,总盈亏', csvField(totalPnl));
  summaryRows.push('总体,单笔均值', csvField(settled.length ? totalPnl / settled.length : 0));
  summaryRows.push('总体,ROI', csvField(totalEntryUsd ? (totalPnl / totalEntryUsd) * 100 : 0));
  summaryRows.push('总体,盈利笔数', csvField(`${profitable}/${settled.length}`));
  if (DRIFT_EXIT) {
    const driftN = entries.filter((e) => e.driftExit).length;
    const driftPnl = settled.filter((e) => e.driftExit).reduce((s, e) => s + (e.profit ?? 0), 0);
    summaryRows.push('总体,漂移离场阈值', csvField(DRIFT_THRESHOLD));
    summaryRows.push('总体,漂移离场笔数', csvField(driftN));
    summaryRows.push('总体,漂移离场盈亏', csvField(driftPnl));
  }

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
    summaryRows.push(`城市:${city},市场数`, csvField(list.length));
    summaryRows.push(`城市:${city},命中率`, csvField(`${h}/${v.length}`));
    summaryRows.push(`城市:${city},盈亏`, csvField(pnl));
    summaryRows.push(`城市:${city},已结算笔数`, csvField(s.length));
  }

  fs.writeFileSync(summaryPath, `${summaryRows.join('\n')}\n`, 'utf8');
  logger.info('CSV 已导出', { detailPath, summaryPath });
  return { detailPath, summaryPath };
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
        if (p1 != null && p2 != null && p1 + p2 >= EXIT_SUM) {
          return { price: p1 + p2 };
        }
      }
    }
  }

  if (hit === null) return { price: null };
  return { price: hit ? 1.0 : 0.0 };
}

/**
 * 价格止损（STOP_LOSS_K）：
 *   入场后按时间顺序遍历两桶价格和，先出现"≤ 入场成本×K"→ 止损平仓；
 *   先出现"≥0.85"→ 原止盈目标。半仓模式（half）止损时卖一半、留一半持有到结算。
 *   无 price-history（无法逐时跟踪）或未触发 → 回退基线持有到结算。
 */
function findStopLossExit(
  bucketKeys: string[],
  entryTs: string | null,
  hit: boolean | null,
  history: PriceHistory | null,
  entryPrice: number,
  stopK: number,
  half: boolean,
  noSumExit = false,
): { price: number | null; stopLoss: boolean } {
  const entryMs = entryTs ? new Date(entryTs).getTime() : 0;

  if (history) {
    const s1 = history.get(bucketKeys[0]!);
    const s2 = bucketKeys.length >= 2 ? history.get(bucketKeys[1]!) : null;
    if (s1 && s1.length > 0 && (bucketKeys.length === 1 || (s2 && s2.length > 0))) {
      const p1At = new Map(s1.map((p) => [p.t, p.p]));
      const p2At = s2 ? new Map(s2.map((p) => [p.t, p.p])) : null;
      const times = [...new Set<number>([...s1, ...(s2 ?? [])].map((p) => p.t))].sort((a, b) => a - b);
      const stopLevel = entryPrice * stopK;
      for (const t of times) {
        if (t * 1000 < entryMs) continue;
        const p1 = p1At.get(t);
        const p2 = p2At ? p2At.get(t) : null;
        if (p1 == null || (bucketKeys.length >= 2 && p2 == null)) continue;
        const sum = p1 + (p2 ?? 0);
        if (sum <= stopLevel) {
          if (half && hit !== null) {
            return { price: 0.5 * sum + 0.5 * (hit ? 1.0 : 0.0), stopLoss: true };
          }
          return { price: sum, stopLoss: true };
        }
        // 0.85 止盈目标优先。峰值回撤模式（noSumExit=true）下关闭。
        if (!noSumExit && sum >= 0.85) {
          return { price: sum, stopLoss: false }; // 原止盈目标优先
        }
      }
    }
  }

  if (hit === null) return { price: null, stopLoss: false };
  return { price: hit ? 1.0 : 0.0, stopLoss: false };
}

/**
 * 峰值回撤止盈（EXIT_PULLBACK）：
 * 入场后逐时遍历双桶 bid 之和，跟踪持仓期间的历史最高点（前一个高点），
 * 一旦 sumBid <= 高点 × (1 - PULLBACK) 即按该时点 sumBid 平仓。
 * 关闭 0.85 提前卖；未触发 → 返回 null，调用方回退持有到结算。
 * 无 price-history → 返回 null。
 */
function findPullbackExit(
  bucketKeys: string[],
  entryTs: string | null,
  history: PriceHistory | null,
  pullback: number,
): { price: number | null } {
  const entryMs = entryTs ? new Date(entryTs).getTime() : 0;
  if (!history) return { price: null };
  const s1 = history.get(bucketKeys[0]!);
  const s2 = bucketKeys.length >= 2 ? history.get(bucketKeys[1]!) : null;
  if (!s1 || s1.length === 0 || (bucketKeys.length >= 2 && (!s2 || s2.length === 0))) {
    return { price: null };
  }
  const p1At = new Map(s1.map((p) => [p.t, p.p]));
  const p2At = s2 ? new Map(s2.map((p) => [p.t, p.p])) : null;
  const times = [...new Set<number>([...s1, ...(s2 ?? [])].map((p) => p.t))].sort((a, b) => a - b);
  let peak = 0;
  for (const t of times) {
    if (t * 1000 < entryMs) continue;
    const p1 = p1At.get(t);
    const p2 = p2At ? p2At.get(t) : null;
    if (p1 == null || (bucketKeys.length >= 2 && p2 == null)) continue;
    const sum = p1 + (p2 ?? 0);
    if (sum > peak) {
      peak = sum; // 更新前一个高点
    } else if (peak > 0 && sum <= peak * (1 - pullback)) {
      return { price: sum }; // 从高点回撤 >= PULLBACK → 平仓
    }
  }
  return { price: null };
}

/**
 * 峰值前逢高平仓（EXIT_PEAK_HIGH）：
 * 入场后逐时遍历 price-history，仅在该城 D0 典型峰值时刻（peakMs）之前，
 * 一旦双桶 bid 之和 >= highTarget 就按该时点 bid 之和平仓（提前落袋）。
 * 峰值前未触及阈值 → 返回 null，调用方回退基线（持有到结算）。
 * 无 price-history 或城市无峰值配置 → 同样回退。
 */
function findPeakHighExit(
  bucketKeys: string[],
  entryTs: string | null,
  hit: boolean | null,
  history: PriceHistory | null,
  peakMs: number,
  highTarget: number,
): { price: number | null } {
  const entryMs = entryTs ? new Date(entryTs).getTime() : 0;

  if (history && peakMs > 0) {
    const s1 = history.get(bucketKeys[0]!);
    const s2 = bucketKeys.length >= 2 ? history.get(bucketKeys[1]!) : null;
    if (s1 && s1.length > 0 && (bucketKeys.length === 1 || (s2 && s2.length > 0))) {
      const p1At = new Map(s1.map((p) => [p.t, p.p]));
      const p2At = s2 ? new Map(s2.map((p) => [p.t, p.p])) : null;
      const times = [...new Set<number>([...s1, ...(s2 ?? [])].map((p) => p.t))].sort((a, b) => a - b);
      for (const t of times) {
        const tsMs = t * 1000;
        if (tsMs < entryMs) continue;
        if (tsMs > peakMs) break; // 峰值后不再"逢高"（阶段二之外）
        const p1 = p1At.get(t);
        const p2 = p2At ? p2At.get(t) : null;
        if (p1 == null || (bucketKeys.length >= 2 && p2 == null)) continue;
        const sum = p1 + (p2 ?? 0);
        if (sum >= highTarget) {
          return { price: sum };
        }
      }
    }
  }

  return { price: null };
}

/**
 * 在指定快照上重建概率分布（与主循环 1a-2 相同的 bias/MAE/sigma 流程）。
 * 供 D1 换仓使用；返回 null 表示该快照无模型数据或修正为空。
 */
function buildSnapDistribution(
  raw: OldMarketFile,
  snap: OldMarketFile['forecast_snapshots'][number],
  fahrenheit: boolean,
  allFiles: OldMarketFile[],
  bucketsC: TemperatureBucket[],
): ProbabilityDistribution | null {
  const horizon = HORIZON_MAP[snap.horizon] ?? 'd2';
  const unit = raw.unit ?? (fahrenheit ? 'F' : 'C');
  const models = snap.ens?.models;
  if (!models) return null;

  const sourceWeights = DEB_MAE
    ? dynamicSourceWeights(allFiles, raw.date, unit, snap.horizon)
    : new Map<string, number>();
  const residualSigmaC = DEB_SIGMA ? computeMADSigma(allFiles, raw.date, unit, snap.horizon) : null;

  const corrections: SpatialCorrectionResult[] = [];
  for (const [oldKey, temp] of Object.entries(models)) {
    const sourceId = SOURCE_MAP[oldKey];
    if (!sourceId) continue;
    const tempC = fahrenheit ? toC(temp) : temp;
    const b = DEB_BIAS
      ? computeBiasWithStratum(allFiles, raw.city, raw.date, unit, snap.horizon, BIAS_SOURCE_MAP[oldKey] ?? 'best', tempC)
      : computeCityBias(allFiles, raw.city, raw.date, unit, snap.horizon, BIAS_SOURCE_MAP[oldKey] ?? 'best');
    const biasC = b && b.bias !== 0 ? (fahrenheit ? (b.bias * 5) / 9 : b.bias) : 0;
    const correctedC = biasC !== 0 ? Math.round((tempC - biasC) * 100) / 100 : tempC;
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
  if (corrections.length === 0) return null;

  const probEngine = new AdaptiveProbabilityEngine(raw.city as CityId, raw.city, bucketsC);
  return probEngine.generateDistribution(corrections, sourceWeights, horizon, residualSigmaC ?? undefined);
}

/**
 * 在指定分布上跑决策引擎，返回选中的桶对（生产双桶逻辑）。
 */
function decideOn(
  dist: ProbabilityDistribution,
  marketPrices: Map<string, MarketPrice>,
  horizon: ForecastHorizon,
): string[] | null {
  const candidates: CandidateBucket[] = [];
  for (const bp of dist.buckets) {
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
      neighborPrices: { lowerYesPrice: undefined, higherYesPrice: undefined },
    });
  }
  if (candidates.length === 0) return null;
  const engine = new TradingDecisionEngine(loadAppConfig('shanghai').city);
  const decision = engine.decide({
    city: dist.city as CityId,
    horizon,
    distribution: dist,
    candidates,
    tradingMode: 'paper',
  });
  if (!decision) return null;
  return decision.buckets.map((b) => b.label);
}

/**
 * D1 换仓（SWITCH_D1）：
 *   入场后找第一个 D+1 快照，若旧桶对在该快照的模型区间概率 ≤ threshold，
 *   且决策引擎选出了不同的新桶对 → 按当时市场价卖旧买新。返回换仓信息；
 *   否则返回 null（保持原持仓）。
 */
function findD1Switch(
  raw: OldMarketFile,
  bucketKeys: string[],
  entryMs: number,
  history: PriceHistory | null,
  bucketsC: TemperatureBucket[],
  threshold: number,
  allFiles: OldMarketFile[],
): { newKeys: string[]; sell: number; buy: number; ts: string } | null {
  const fahrenheit = isFahrenheit(raw.all_outcomes ?? []);
  for (const snap of raw.forecast_snapshots) {
    if ((snap.horizon ?? '').toUpperCase() !== 'D+1') continue;
    const snapMs = new Date(snap.ts).getTime();
    if (Number.isNaN(snapMs) || snapMs <= entryMs) continue;

    const dist = buildSnapDistribution(raw, snap, fahrenheit, allFiles, bucketsC);
    if (!dist) continue;
    const oldPSum = dist.buckets
      .filter((b) => bucketKeys.includes(b.bucket.label))
      .reduce((s, b) => s + b.probability, 0);
    if (oldPSum > threshold) continue; // 旧桶概率仍高，不换仓

    const marketPrices = buildMarketPrices(raw, snap.ts, history);
    const horizon = HORIZON_MAP[snap.horizon] ?? 'd2';
    const newKeys = decideOn(dist, marketPrices, horizon);
    if (!newKeys) continue;
    const same = newKeys.length === bucketKeys.length && newKeys.every((k, i) => k === bucketKeys[i]);
    if (same) continue;

    const sell = findPriceAt(raw, bucketKeys, snap.ts, history);
    const buy = findPriceAt(raw, newKeys, snap.ts, history);
    if (sell === null || buy === null) continue;
    return { newKeys, sell, buy, ts: snap.ts };
  }
  return null;
}

/** 给定时点选中桶的价格之和：优先 price-history 真实序列，回退 all_outcomes 当前价。 */
function findPriceAt(
  raw: OldMarketFile,
  bucketKeys: string[],
  ts: string,
  history: PriceHistory | null,
): number | null {
  if (history) {
    const prices = bucketKeys.map((k) => priceAt(history.get(k) ?? [], ts));
    if (prices.every((p) => p !== null)) {
      return (prices as number[]).reduce((a, b) => a + b, 0);
    }
  }
  // 未结算市场的 all_outcomes 是真实价（非结算 0/1），可作卖价近似。
  const keySet = new Set(bucketKeys);
  const price = (raw.all_outcomes ?? [])
    .filter((o) => keySet.has(bucketKey(o.range[0], o.range[1])))
    .reduce((sum, o) => sum + o.price, 0);
  return price > 0 ? price : null;
}

/**
 * 预测漂移离场（DRIFT_EXIT）：
 *   入场后按时间顺序遍历后续快照，计算 ENS 成员落在选中桶组合的区间概率
 *   （member 转摄氏后与桶半开区间 (min, max] 比较）；一旦 < threshold，
 *   用该时点的市场卖价提前平仓。无成员快照或从未跌破阈值则回退原退出逻辑。
 */
function findDriftExit(
  raw: OldMarketFile,
  bucketKeys: string[],
  entryMs: number,
  hit: boolean | null,
  history: PriceHistory | null,
  threshold: number,
  bucketsC: TemperatureBucket[],
  minStreak: number,
): { price: number | null; driftExit: boolean } {
  const fahrenheit = isFahrenheit(raw.all_outcomes ?? []);
  let streak = 0;
  let lastDriftSnapTs = '';
  for (const snap of raw.forecast_snapshots) {
    const snapMs = new Date(snap.ts).getTime();
    if (Number.isNaN(snapMs) || snapMs < entryMs) continue;
    const members = snap.ens?.membersMax;
    if (!members || members.length === 0) continue;
    let inP = 0;
    for (const mm of members) {
      const t = fahrenheit ? toC(mm) : mm;
      const inside = bucketKeys.some((k) => {
        const b = bucketsC.find((x) => x.label === k);
        if (!b) return false;
        if (b.minTempC !== null && t <= b.minTempC) return false;
        if (b.maxTempC !== null && t > b.maxTempC) return false;
        return true;
      });
      if (inside) inP += 1;
    }
    const p = inP / members.length;
    if (p < threshold) {
      streak += 1;
      lastDriftSnapTs = snap.ts;
      if (streak >= minStreak) {
        const sell = findPriceAt(raw, bucketKeys, snap.ts, history);
        if (sell !== null) return { price: sell, driftExit: true };
      }
    } else {
      streak = 0;
    }
  }
  const exit = findExitPrice(bucketKeys, entryMs ? new Date(entryMs).toISOString() : null, hit, history);
  return { price: exit.price, driftExit: false };
}

/**
 * D0 预测失配离场（EXIT_D0_MISMATCH）：
 *   取入场后"最后一个 D+0 快照"（结算当天最新预测），若 ensemble mean（best）
 *   温度已不在持仓桶组合内 → 用该时点市场卖价平仓；仍在桶内 → 不触发
 *   （返回 null，调用方回退基线退出逻辑）。无 D+0 快照同样不触发。
 */
function findD0MismatchExit(
  raw: OldMarketFile,
  bucketKeys: string[],
  entryMs: number,
  hit: boolean | null,
  history: PriceHistory | null,
  bucketsC: TemperatureBucket[],
): { price: number | null; d0Mismatch: boolean } {
  const fahrenheit = isFahrenheit(raw.all_outcomes ?? []);
  let d0Snap: OldMarketFile['forecast_snapshots'][number] | null = null;
  for (const snap of raw.forecast_snapshots) {
    const snapMs = new Date(snap.ts).getTime();
    if (Number.isNaN(snapMs) || snapMs < entryMs) continue;
    if ((snap.horizon ?? '').toUpperCase() !== 'D+0') continue;
    if (snap.best == null) continue;
    d0Snap = snap; // 保留最后一个 D+0 快照
  }
  if (!d0Snap) return { price: null, d0Mismatch: false };
  const bestC = fahrenheit ? toC(d0Snap.best) : d0Snap.best;
  const inBuckets = bucketKeys.some((k) => bucketContainsC(bucketsC, k, bestC));
  if (inBuckets) return { price: null, d0Mismatch: false };
  const sell = findPriceAt(raw, bucketKeys, d0Snap.ts, history);
  if (sell === null) return { price: null, d0Mismatch: false };
  return { price: sell, d0Mismatch: true };
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
