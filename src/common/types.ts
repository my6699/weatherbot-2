// 这个文件只放“类型定义”，不放具体业务逻辑。
// 好处是：每个模块都使用同一套数据结构，减少字段名写错、单位混乱、模块之间对不上接口的问题。

export type CityId =
  | 'shanghai' | 'nyc' | 'chicago' | 'miami' | 'dallas'
  | 'seattle' | 'atlanta' | 'london' | 'paris' | 'munich'
  | 'ankara' | 'seoul' | 'tokyo' | 'singapore' | 'lucknow'
  | 'tel-aviv' | 'toronto' | 'sao-paulo' | 'buenos-aires' | 'wellington';

export const ALL_CITIES: CityId[] = [
  'shanghai', 'nyc', 'chicago', 'miami', 'dallas',
  'seattle', 'atlanta', 'london', 'paris', 'munich',
  'ankara', 'seoul', 'tokyo', 'singapore', 'lucknow',
  'tel-aviv', 'toronto', 'sao-paulo', 'buenos-aires', 'wellington',
];

export type TradingMode = 'paper' | 'live';

export type ForecastHorizon = 'd3' | 'd2' | 'd1' | 'd0';

export type TradeSide = 'YES' | 'NO';

export type OrderSide = 'BUY' | 'SELL';

export type DataSourceStatus = 'healthy' | 'degraded' | 'disabled';

export interface GeoPoint {
  // 纬度，例如 ZSPD 浦东机场约为 31.1443
  lat: number;

  // 经度，例如 ZSPD 浦东机场约为 121.8083
  lon: number;
}

export interface WeatherStation extends GeoPoint {
  // 气象站代码，例如 ZSPD
  stationId: string;

  // 给人看的名称，例如 Shanghai Pudong International Airport
  name: string;

  // 所属城市。每个城市必须独立校正，不能跨城市混用参数。
  city: CityId;

  // 这个站点是否是 Polymarket 结算站点。
  // 上海温度市场重点使用 ZSPD，所以 ZSPD 应该是 true。
  isSettlementStation: boolean;
}

export interface NearbyStationObservation extends GeoPoint {
  // 周边气象站 ID
  stationId: string;

  // 当前或历史观测温度，单位摄氏度。
  temp: number;

  // 周边站点同一目标日期的最高温预报（℃）。
  // 残差修正用：residual = temp - forecastTemp。
  // 观测与预报必须对齐到同一天/同一量纲，否则残差无意义。
  forecastTemp?: number;

  // 周边站点到主站点的距离，单位公里。
  distanceKm: number;

  // 数据观测时间。空间修正必须知道数据是不是足够新。
  observedAt: Date;

  // 数据来源，例如 metar、open-meteo、manual-history。
  sourceId: string;
}

export interface StandardizedForecast {
  // 数据源 ID，例如 open-meteo-ecmwf、open-meteo-gfs、metar。
  sourceId: string;

  // 这次预报发布的时间。
  issuanceTime: Date;

  // 预报提前小时数，例如 D-3 大约是 72 小时附近。
  forecastHour: number;

  // 目标结算站点，例如 ZSPD。
  targetStation: string;

  // 数据源给出的主站点最高温预测，单位摄氏度。
  forecastedMaxTemp: number;

  // 集合预报成员。如果某个数据源没有集合成员，可以不提供。
  // 注意：后续概率引擎不能简单平均这些成员，必须先经过城市独立偏差和空间修正。
  ensembleMembers?: number[];

  // 周边站点观测或预报数据，用于空间加权修正。
  nearbyStationsData?: NearbyStationObservation[];

  // 存放数据源原始信息，例如模型名、API 响应版本、质量标记等。
  metadata: Record<string, unknown>;
}

/**
 * 集合预报（ensemble）逐日最高温。
 * 来自 Open-Meteo ensemble API（独立端点 /v1/ensemble），每个模型一组扰动成员：
 *   - dayTemps[i][d] = 第 i 个成员第 d 天（0 起）的日最高温（℃）
 *   - mean[d]       = 当天所有成员的平均（ensemble mean）
 * 用成员分布直接算桶概率（KDE 核密度），比"单点预报 + 高斯拟合"更贴近真实不确定性，
 * 尾部概率（极端桶）尤其准。
 */
export interface EnsembleDailyForecast {
  // 数据源 ID，例如 open-meteo-ensemble。
  sourceId: string;
  // 底层模型名，例如 ecmwf_ifs025 / gfs025 / icon_seamless。
  model: string;
  // 目标结算站点，例如 ZSPD。
  targetStation: string;
  // 预报发布（拉取）时间。
  issuanceTime: Date;
  // 有效成员数（可能因个别成员缺数而少于模型总成员）。
  memberCount: number;
  // 每个成员每天的最高温（℃）。dayTemps[i][d]。
  dayTemps: number[][];
  // ensemble mean：每天最高温（℃）。
  mean: number[];
}

export interface CityBiasProfile {
  // 城市 ID。偏差库必须按城市隔离。
  city: CityId;

  // 数据源 ID。不同模型的系统性偏差不同，不能混在一起。
  sourceId: string;

  // 季节标签，例如 summer、winter。
  season: string;

  // 天气类型，例如 sunny、rainy、humid、typhoon-risk。
  weatherRegime: string;

  // 该城市、该数据源在类似天气下的平均偏差。
  // 定义为：实际最高温 - 预报最高温。
  meanBiasC: number;

  // 偏差标准差，表示这个数据源在该城市的误差波动有多大。
  stdBiasC: number;

  // 历史偏差分位数，用于识别极端偏差风险。
  quantilesC: {
    p10: number;
    p50: number;
    p90: number;
  };

  // 样本数量。样本少时，策略应该降低对这个偏差 profile 的信任。
  sampleSize: number;

  // 最后更新时间。
  updatedAt: Date;
}

export interface SpatialCorrectionInput {
  city: CityId;
  targetStation: WeatherStation;
  rawForecast: StandardizedForecast;
  cityBiasProfile: CityBiasProfile | null;
}

export interface SpatialCorrectionResult {
  city: CityId;
  targetStation: string;
  sourceId: string;

  // 原始主站点预报温度。
  rawForecastedMaxTemp: number;

  // 城市独立偏差修正后的温度。
  biasCorrectedMaxTemp: number;

  // 空间加权修正后的最终锚定温度。
  spatialCorrectedMaxTemp: number;

  // 空间修正带来的变化量。
  spatialAdjustmentC: number;

  // 0 到 1 的置信度。
  // 周边站越多、越近、数据越新，置信度越高。
  confidence: number;

  // 参与修正的周边站点明细，便于之后复盘。
  nearbyStationWeights: Array<{
    stationId: string;
    distanceKm: number;
    weight: number;
    temp: number;
  }>;

  updatedAt: Date;
}

export interface TemperatureBucket {
  // 桶名称，例如 32、33、34，或 <=30、>=38。
  label: string;

  // 桶的下边界，单位摄氏度。没有下边界时为 null。
  minTempC: number | null;

  // 桶的上边界，单位摄氏度。没有上边界时为 null。
  maxTempC: number | null;
}

export interface BucketProbability {
  bucket: TemperatureBucket;

  // 模型估计该桶命中的概率，范围 0 到 1。
  probability: number;

  // 市场 YES 价格，范围 0 到 1。没有行情时可为空。
  yesPrice?: number;

  // 市场 NO 价格，范围 0 到 1。没有行情时可为空。
  noPrice?: number;

  // 模型概率 - 市场价格。只是多因子之一，不再是唯一标准。
  edge?: number;
}

export interface ProbabilityDistribution {
  city: CityId;
  targetStation: string;
  horizon: ForecastHorizon;

  // 概率计算必须基于空间修正后的温度锚，而不是原始成员简单平均。
  correctedAnchorTempC: number;

  // 离散度越高，说明模型不确定性越强，策略应该更保守。
  dispersionC: number;

  // 共识水平，范围 0 到 1。越高说明多个来源更一致。
  consensusLevel: number;

  buckets: BucketProbability[];

  // 记录各数据源贡献，方便排查为什么某个桶概率高。
  sourceContributions: Array<{
    sourceId: string;
    correctedTempC: number;
    weight: number;
    status: DataSourceStatus;
  }>;

  // 集合预报（ensemble）接入信息（仅启用时存在），用于复盘与对照。
  // 存 ensemble 单独产出的桶概率分布 + 元数据，方便日后对比"纯高斯"与"集合分布"的优劣。
  ensemble?: {
    model: string;
    memberCount: number;
    // ensemble mean 当天的最高温（℃，已应用偏差平移）。
    meanTempC: number;
    // 成员离散度（成员最高温的标准差，℃）。
    dispersionC: number;
    // ensemble 单独产出的桶概率（未与高斯融合，供对照）。
    probabilities: BucketProbability[];
  };

  generatedAt: Date;
}

export interface MarketSnapshot {
  marketId: string;
  city: CityId;
  targetDate: string;
  bucket: TemperatureBucket;
  yesPrice: number;
  noPrice: number;
  volumeUsd: number;
  orderBookImbalance: number;
  capturedAt: Date;
}

export interface TradingSignalScore {
  // 总分，TradingDecisionEngine 会按这个排序候选桶。
  totalScore: number;

  cheapTailScore: number;
  modelShockScore: number;
  orderFlowScore: number;
  spatialSupportScore: number;
  relativeValueScore: number;
  probabilityGapScore: number;
  dispersionPenalty: number;
}

/**
 * Maker 优先入场信息：D2 对便宜桶挂限价单，等 D1 回撤成交，没成交就 Taker 兜底。
 * 回测验证：+15.6% 总盈亏提升（63/69 笔 Maker 成交，均价便宜 4%）。
 */
export interface MakerFirstInfo {
  // 便宜的桶 → 做 Maker，挂限价单等成交。
  makerBucket: TemperatureBucket;
  // 贵的桶 → 做 Taker，在 Maker 成交时间点市价买。
  takerBucket: TemperatureBucket;
  // Maker 限价单价格（D2 开盘价，< 0.30 才挂单）。
  makerLimitPrice: number;
  // 是否满足 Maker 条件（D2 价格 < 0.30）。
  makerQualified: boolean;
  // D2 立即进场总价（供参考对比）。
  entryPriceD2: number;
}

export interface TradingDecision {
  city: CityId;
  horizon: ForecastHorizon;
  side: TradeSide;

  // 主桶（区间中概率较高的那个），兼容单桶逻辑。
  bucket: TemperatureBucket;

  // 双桶区间策略：实际买入的相邻两个桶（>=2 表示双桶）。
  // 退出条件：两桶当前 bid 之和 >= 0.85 即平仓。
  buckets: TemperatureBucket[];

  // 计划买入价格（双桶时为两桶价格之和）。
  entryPrice: number;

  // 计划投入金额，单位美元（凯利动态计算，受 maxPositionUsd 单笔上限约束）。
  sizeUsd: number;

  // 凯利全比例（f*，0-1）：每笔按"资金池 × f* × 凯利系数"动态投入。
  // 仅用于日志/复盘，实际下单用 sizeUsd。
  kellyFraction: number;

  // paper 表示只记录模拟交易，live 才会真实下单。
  mode: TradingMode;

  score: TradingSignalScore;

  // Maker 优先入场信息（D2 时有效，D1/D0 无此信息）。
  makerFirst?: MakerFirstInfo;

  // 用自然语言记录为什么买，便于小白复盘策略行为。
  reason: string;

  createdAt: Date;
}

export interface OpenPosition {
  positionId: string;
  city: CityId;
  side: TradeSide;
  bucket: TemperatureBucket;
  // 市场目标日期（YYYY-MM-DD，结算闭环用）。
  targetDate: string;

  // 双桶区间持仓：买入的相邻两个桶（>=2 表示双桶）。
  buckets?: TemperatureBucket[];

  entryPrice: number;
  sizeUsd: number;
  openedAt: Date;
  mode: TradingMode;
  // D1 换仓标记：已换仓的持仓不再重复换仓（每笔只换一次，与回测 SWITCH_D1 口径一致）。
  switched?: boolean;
}

export type TradeStatus = 'open' | 'closed' | 'settled';

/**
 * 持久化的交易记录，供每日结算报告统计。
 */
export interface TradeRecord {
  id: string;
  city: CityId;
  horizon: ForecastHorizon;
  // 实际买入的桶（双桶区间为两个桶的 label）。
  buckets: string[];
  // 市场目标日期（YYYY-MM-DD，结算闭环用）。
  targetDate: string;
  // 主桶 label（区间中概率较高的那个）。
  bucketLabel: string;
  entryPrice: number;
  // 双桶各自的入场价（单桶时 entryPriceA 等于 entryPrice，entryPriceB 为 0）。
  entryPriceA: number;
  entryPriceB: number;
  sizeUsd: number;
  side: TradeSide;
  openedAt: string;
  closedAt: string | null;
  exitPrice: number | null;
  exitPriceA: number | null;
  exitPriceB: number | null;
  pnl: number | null;
  // true = 命中，false = 未命中，null = 未结算。
  hit: boolean | null;
  settledAt: string | null;
  settlementPrice: number | null;
  status: TradeStatus;
  reason: string;
  // paper = 模拟持仓；live = 真实持仓（重启恢复时按此模式走真实下单平仓/换仓）。
  mode?: TradingMode;
  // ===== D1 换仓（SWITCH_D1，2026-08-09 正式接入生产引擎） =====
  // 触发：持仓目标日期的最新预测中，旧桶对模型区间概率 ≤ SWITCH_THRESHOLD，
  //   且决策引擎选出不同新桶对 → paper/live 卖旧买新。
  // 换仓后该笔持仓以新桶继续监控/结算；结算盈亏按"旧桶段已实现 + 新桶段待结算"计算。
  switched?: boolean;
  switchKeys?: string[]; // 换仓后的新桶 label
  switchSell?: number;   // 旧桶卖出回收（两桶 YES 价和，0~1 价格比例）
  switchBuy?: number;    // 新桶买入成本（两桶 YES 价和，0~1 价格比例）
  switchAt?: string;     // 换仓时间 ISO
  // ===== 市场原生桶精确 °C 边界（2026-08-11 起，进程重启恢复持仓用） =====
  // 桶对象不再依赖 config 摄氏网格（°F 城市原生桶与 config 网格解耦），
  // 开仓/换仓时把桶边界持久化，restorePositions 直接用边界还原桶对象。
  // bucketBounds[i] 对应 buckets[i]；switchBucketBounds[i] 对应 switchKeys[i]。
  bucketBounds?: Array<{ minTempC: number | null; maxTempC: number | null }>;
  switchBucketBounds?: Array<{ minTempC: number | null; maxTempC: number | null }>;
  // ===== 补结算标记（2026-08-12） =====
  // true = 该笔由补结算机制（settleDuePositions）补记，非持仓监控正常结算。
  // 覆盖两类：重启后失联的持仓、平仓后被移出内存的持仓。
  // 这类记录的 pnl/exitPrice 是补结算时刻的市场快照（可能非真实执行价），
  // 统计报告应与正常平仓/结算分开看，避免污染胜率和盈亏口径。
  viaSettleBackfill?: boolean;
}

export interface ExitPlan {
  positionId: string;
  city: CityId;

  // 动态离场开始时间，通常是预测峰值前 1 到 1.5 小时。
  softExitStartsAt: Date;

  // 硬性清仓时间。上海策略默认本地时间 14:00 前。
  hardExitAt: Date;

  // 分批卖出次数。TWAP 会把大单拆成多笔，减少滑点。
  twapSlices: number;

  // 触发止盈的最低收益率，例如 0.25 表示盈利 25%。
  takeProfitRatio: number;

  // 是否已经完成全部离场。
  completed: boolean;
}

export interface RedisWeatherPayload {
  city: CityId;
  horizon: ForecastHorizon;
  probability: ProbabilityDistribution;
  spatialCorrections: SpatialCorrectionResult[];

  // 写入 Redis 的时间。策略端用它检查数据是否过期。
  timestamp: string;
}

export interface DataSourceHealth {
  sourceId: string;
  status: DataSourceStatus;
  consecutiveFailures: number;
  lastSuccessAt?: Date;
  lastError?: string;

  // 当前数据源权重。失败过多后会自动降权。
  currentWeight: number;
}
