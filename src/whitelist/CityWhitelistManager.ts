// 城市黑白名单自动管理器。
//
// 数据链路：
//   1. 读取 data/predictions.json（DataHub 落盘的修正后预报）和 metar_max.json（METAR 真值）
//      计算每个城市的预报命中率（interval hit rate）。
//   2. 读取 data/trades-*.json（交易记录）计算每个城市的交易胜率和盈亏。
//   3. 按阈值自动判定城市是否应进入黑名单或回到白名单。
//   4. 输出 data/city-whitelist.json，供 config-loader 读取。
//   5. 记录状态变更历史，供每日报告推送通知。
//
// 黑白名单逻辑（阈值可调）：
//   黑名单（任一满足）：
//     - 30天区间命中率 < 25%（最低 15 次预报）
//     - 30天交易胜率 < 20%（最低 10 笔结算）
//     - 30天累计盈亏 < -$5（最低 10 笔结算）
//   白名单（全部满足）：
//     - 14天区间命中率 >= 40%（最低 10 次预报）
//     - 14天交易胜率 >= 35%（最低 5 笔结算）
//     - 14天累计盈亏 > $0
//
// 优先级：.env 的 DISABLED_CITIES 手动强制覆盖 > 自动黑白名单

import fs from 'node:fs';
import path from 'node:path';
import { createModuleLogger } from '../common/logger.js';
import type { CityId, TradeRecord } from '../common/types.js';
import { ALL_CITIES } from '../common/types.js';
import { sendWeComMarkdown } from '../utils/wecom-notifier.js';

const logger = createModuleLogger('CityWhitelistManager');

// ==================== 类型定义 ====================

/** 预测记录（predictions.json 的条目结构）。 */
interface PredictionRecord {
  city: string;
  stationId: string;
  date: string;
  horizons: Record<string, {
    anchorC: number;
    topBucket: string;
    topMinC: number | null;
    topMaxC: number | null;
    topProb: number;
    secondBucket: string | null;
    secondMinC: number | null;
    secondMaxC: number | null;
    secondProb: number | null;
    rawAnchorC?: number;
    rawTopBucket?: string | null;
    rawTopMinC?: number | null;
    rawTopMaxC?: number | null;
    updatedAt: string;
  }>;
}

/** 城市黑白名单状态。 */
export type CityWhitelistStatus = 'active' | 'blacklisted' | 'insufficient_data';

/** 城市黑白名单条目。 */
export interface CityWhitelistEntry {
  city: CityId;
  status: CityWhitelistStatus;
  blacklistedAt: string | null;   // 进入黑名单的日期（ISO）
  whitelistedAt: string | null;   // 回到白名单的日期（ISO）
  reason: string | null;          // 状态变更原因
  // 滚动指标
  metrics: {
    intervalHitRate30d: number | null;  // 30天区间命中率
    predictionCount30d: number;         // 30天预报样本数
    tradeHitRate30d: number | null;     // 30天交易胜率
    tradeCount30d: number;              // 30天结算交易数
    pnl30d: number | null;              // 30天累计盈亏
    intervalHitRate14d: number | null;  // 14天区间命中率
    predictionCount14d: number;         // 14天预报样本数
    tradeHitRate14d: number | null;     // 14天交易胜率
    tradeCount14d: number;              // 14天结算交易数
    pnl14d: number | null;              // 14天累计盈亏
  };
  lastUpdated: string;  // ISO 时间戳
}

/** 状态变更记录。 */
export interface CityWhitelistChange {
  city: CityId;
  from: CityWhitelistStatus;
  to: CityWhitelistStatus;
  reason: string;
  metrics: CityWhitelistEntry['metrics'];
  detectedAt: string;
}

/** 完整的黑白名单数据文件结构。 */
export interface CityWhitelistData {
  version: number;
  updatedAt: string;
  cities: Record<string, CityWhitelistEntry>;
  changes: CityWhitelistChange[];
}

// ==================== 默认配置 ====================

interface WhitelistThresholds {
  // 黑名单条件
  blacklistIntervalHitRate: number;   // 30天区间命中率 < 此值
  blacklistIntervalMinSamples: number; // 最少预报样本数
  blacklistTradeHitRate: number;      // 30天交易胜率 < 此值
  blacklistTradeMinSamples: number;   // 最少交易样本数
  blacklistPnl: number;               // 30天累计盈亏 < 此值（负值）
  blacklistPnlMinSamples: number;     // 最少交易样本数（PnL 条件）
  // 白名单条件
  whitelistIntervalHitRate: number;   // 14天区间命中率 >= 此值
  whitelistIntervalMinSamples: number; // 最少预报样本数
  whitelistTradeHitRate: number;      // 14天交易胜率 >= 此值
  whitelistTradeMinSamples: number;   // 最少交易样本数
  whitelistPnl: number;               // 14天累计盈亏 >= 此值
}

const DEFAULT_THRESHOLDS: WhitelistThresholds = {
  // 黑名单
  blacklistIntervalHitRate: 0.25,
  blacklistIntervalMinSamples: 15,
  blacklistTradeHitRate: 0.20,
  blacklistTradeMinSamples: 10,
  blacklistPnl: -5,
  blacklistPnlMinSamples: 10,
  // 白名单
  whitelistIntervalHitRate: 0.40,
  whitelistIntervalMinSamples: 10,
  whitelistTradeHitRate: 0.35,
  whitelistTradeMinSamples: 5,
  whitelistPnl: 0,
};

// ==================== 核心逻辑 ====================

const WHITELIST_FILE = 'data/city-whitelist.json';

function whitelistFilePath(projectRoot: string): string {
  return path.join(projectRoot, WHITELIST_FILE);
}

/** 读取现有的黑白名单数据。 */
function readExisting(projectRoot: string): CityWhitelistData {
  const filePath = whitelistFilePath(projectRoot);
  if (!fs.existsSync(filePath)) {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      cities: {},
      changes: [],
    };
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as CityWhitelistData;
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), cities: {}, changes: [] };
  }
}

/** 写入黑白名单数据。 */
function writeWhitelist(projectRoot: string, data: CityWhitelistData): void {
  const filePath = whitelistFilePath(projectRoot);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/** 判断温度是否在桶区间内。 */
function inBucket(tempC: number, minC: number | null, maxC: number | null): boolean {
  if (minC !== null && tempC < minC) return false;
  if (maxC !== null && tempC >= maxC) return false;
  return true;
}

/**
 * 计算城市在指定天数窗口内的预报命中率。
 * 返回 { intervalHitRate, predictionCount }。
 */
function calcPredictionAccuracy(
  predictions: Record<string, PredictionRecord>,
  metarMax: Record<string, Record<string, number>>,
  city: string,
  stationId: string,
  windowDays: number,
  today: string,
): { intervalHitRate: number | null; count: number } {
  const cutoff = new Date(Date.now() - windowDays * 86400_000).toISOString().slice(0, 10);
  let hits = 0;
  let total = 0;

  for (const record of Object.values(predictions)) {
    if (record.city !== city) continue;
    if (record.date < cutoff || record.date >= today) continue;

    const actualC = metarMax[stationId]?.[record.date];
    if (actualC === undefined) continue;

    for (const h of Object.values(record.horizons)) {
      const top1Hit = inBucket(actualC, h.topMinC, h.topMaxC);
      const intervalHit =
        top1Hit ||
        (h.secondMinC !== null || h.secondMaxC !== null
          ? inBucket(actualC, h.secondMinC, h.secondMaxC)
          : false);
      if (intervalHit) hits++;
      total++;
    }
  }

  return {
    intervalHitRate: total >= 1 ? hits / total : null,
    count: total,
  };
}

/**
 * 计算城市在指定天数窗口内的交易表现。
 * 返回 { tradeHitRate, pnl, tradeCount }。
 */
function calcTradePerformance(
  trades: TradeRecord[],
  windowDays: number,
  today: string,
): { tradeHitRate: number | null; pnl: number | null; count: number } {
  const cutoff = new Date(Date.now() - windowDays * 86400_000).toISOString().slice(0, 10);
  const settled = trades.filter(
    (t) =>
      t.status === 'settled' &&
      t.pnl !== null &&
      t.targetDate >= cutoff &&
      t.targetDate < today,
  );

  if (settled.length === 0) {
    return { tradeHitRate: null, pnl: null, count: 0 };
  }

  const wins = settled.filter((t) => (t.pnl ?? 0) > 0).length;
  const totalPnl = settled.reduce((s, t) => s + (t.pnl ?? 0), 0);

  return {
    tradeHitRate: wins / settled.length,
    pnl: totalPnl,
    count: settled.length,
  };
}

/** 判断一个城市是否应进入黑名单。 */
function shouldBlacklist(
  metrics: CityWhitelistEntry['metrics'],
  _thresholds: WhitelistThresholds,
): { yes: boolean; reason: string } {
  const t = _thresholds;
  const reasons: string[] = [];

  // 条件1：30天区间命中率低
  if (metrics.predictionCount30d >= t.blacklistIntervalMinSamples &&
      metrics.intervalHitRate30d !== null &&
      metrics.intervalHitRate30d < t.blacklistIntervalHitRate) {
    reasons.push(
      `30天区间命中率 ${(metrics.intervalHitRate30d * 100).toFixed(0)}%（<${(t.blacklistIntervalHitRate * 100).toFixed(0)}%，${metrics.predictionCount30d}样本）`,
    );
  }

  // 条件2：30天交易胜率低
  if (metrics.tradeCount30d >= t.blacklistTradeMinSamples &&
      metrics.tradeHitRate30d !== null &&
      metrics.tradeHitRate30d < t.blacklistTradeHitRate) {
    reasons.push(
      `30天交易胜率 ${(metrics.tradeHitRate30d * 100).toFixed(0)}%（<${(t.blacklistTradeHitRate * 100).toFixed(0)}%，${metrics.tradeCount30d}笔）`,
    );
  }

  // 条件3：30天累计亏损
  if (metrics.tradeCount30d >= t.blacklistPnlMinSamples &&
      metrics.pnl30d !== null &&
      metrics.pnl30d < t.blacklistPnl) {
    reasons.push(
      `30天累计亏损 $${metrics.pnl30d.toFixed(2)}（<$${t.blacklistPnl.toFixed(2)}，${metrics.tradeCount30d}笔）`,
    );
  }

  if (reasons.length > 0) {
    return { yes: true, reason: reasons.join('；') };
  }
  return { yes: false, reason: '' };
}

/** 判断一个城市是否应回到白名单。 */
function shouldWhitelist(
  metrics: CityWhitelistEntry['metrics'],
  _thresholds: WhitelistThresholds,
): { yes: boolean; reason: string } {
  const t = _thresholds;
  const reasons: string[] = [];

  // 条件1：14天区间命中率达标
  if (metrics.predictionCount14d >= t.whitelistIntervalMinSamples &&
      metrics.intervalHitRate14d !== null &&
      metrics.intervalHitRate14d >= t.whitelistIntervalHitRate) {
    reasons.push(
      `14天区间命中率 ${(metrics.intervalHitRate14d * 100).toFixed(0)}%（≥${(t.whitelistIntervalHitRate * 100).toFixed(0)}%，${metrics.predictionCount14d}样本）`,
    );
  }

  // 条件2：14天交易胜率达标
  if (metrics.tradeCount14d >= t.whitelistTradeMinSamples &&
      metrics.tradeHitRate14d !== null &&
      metrics.tradeHitRate14d >= t.whitelistTradeHitRate) {
    reasons.push(
      `14天交易胜率 ${(metrics.tradeHitRate14d * 100).toFixed(0)}%（≥${(t.whitelistTradeHitRate * 100).toFixed(0)}%，${metrics.tradeCount14d}笔）`,
    );
  }

  // 条件3：14天累计盈利
  if (metrics.tradeCount14d >= 1 &&
      metrics.pnl14d !== null &&
      metrics.pnl14d >= t.whitelistPnl) {
    // 盈利条件只要求样本数 >= 1（有交易即可），不严格要求 5 笔
    if (metrics.tradeCount14d >= t.whitelistTradeMinSamples) {
      reasons.push(
        `14天累计盈亏 $${metrics.pnl14d.toFixed(2)}（≥$0，${metrics.tradeCount14d}笔）`,
      );
    }
  }

  // 全部条件满足才放行
  const allConditions = [
    metrics.predictionCount14d >= t.whitelistIntervalMinSamples &&
      metrics.intervalHitRate14d !== null &&
      metrics.intervalHitRate14d >= t.whitelistIntervalHitRate,
    metrics.tradeCount14d >= t.whitelistTradeMinSamples &&
      metrics.tradeHitRate14d !== null &&
      metrics.tradeHitRate14d >= t.whitelistTradeHitRate,
    metrics.tradeCount14d >= t.whitelistTradeMinSamples &&
      metrics.pnl14d !== null &&
      metrics.pnl14d >= t.whitelistPnl,
  ];

  const allMet = allConditions.every(Boolean);
  if (allMet) {
    return { yes: true, reason: reasons.join('；') };
  }

  return { yes: false, reason: '' };
}

/**
 * 城市中文名映射。
 */
const CITY_CN: Record<string, string> = {
  shanghai: '上海',
  nyc: '纽约',
  chicago: '芝加哥',
  miami: '迈阿密',
  dallas: '达拉斯',
  seattle: '西雅图',
  atlanta: '亚特兰大',
  london: '伦敦',
  paris: '巴黎',
  munich: '慕尼黑',
  ankara: '安卡拉',
  seoul: '首尔',
  tokyo: '东京',
  singapore: '新加坡',
  lucknow: '勒克瑙',
  'tel-aviv': '特拉维夫',
  toronto: '多伦多',
  'sao-paulo': '圣保罗',
  'buenos-aires': '布宜诺斯艾利斯',
  wellington: '惠灵顿',
};

// ==================== 对外接口 ====================

export interface WhitelistEvalResult {
  data: CityWhitelistData;
  changes: CityWhitelistChange[];
  /** 有状态变更的城市列表（用于推送通知）。 */
  changedCities: CityWhitelistChange[];
  /** 所有被禁城市 ID（自动 + 手动）。 */
  disabledCities: CityId[];
}

/**
 * 执行城市黑白名单评估。
 * 读取 predictions.json、metar_max.json、trades-*.json，
 * 计算指标，更新 city-whitelist.json，返回评估结果。
 *
 * @param projectRoot 项目根目录
 * @param manualDisabled 手动强制禁用的城市集合（来自 .env DISABLED_CITIES）
 * @param thresholds 阈值配置（可选，默认使用 DEFAULT_THRESHOLDS）
 */
export function evaluateCityWhitelist(
  projectRoot: string,
  manualDisabled: Set<CityId> = new Set(),
  thresholds: WhitelistThresholds = DEFAULT_THRESHOLDS,
): WhitelistEvalResult {
  const dataDir = path.join(projectRoot, 'data');
  const today = new Date().toISOString().slice(0, 10);

  // 1. 读取 predictions.json
  const predFile = path.join(dataDir, 'predictions.json');
  const predictions: Record<string, PredictionRecord> = fs.existsSync(predFile)
    ? JSON.parse(fs.readFileSync(predFile, 'utf-8'))
    : {};

  // 2. 读取 metar_max.json
  const oldDataDir =
    process.env.OLD_PROJECT_DATA_DIR ??
    path.resolve(projectRoot, '..', 'weather-bot', 'polymarket-weather-bot', 'data');
  const metarFile = path.join(oldDataDir, 'metar_max.json');
  const metarMax: Record<string, Record<string, number>> = fs.existsSync(metarFile)
    ? JSON.parse(fs.readFileSync(metarFile, 'utf-8'))
    : {};

  // 3. 读取 trades-*.json
  const allTrades: Record<string, TradeRecord[]> = {};
  if (fs.existsSync(dataDir)) {
    for (const f of fs.readdirSync(dataDir)) {
      const m = f.match(/^trades-(.+)\.json$/);
      if (!m) continue;
      try {
        allTrades[m[1]!] = JSON.parse(
          fs.readFileSync(path.join(dataDir, f), 'utf-8'),
        ) as TradeRecord[];
      } catch {
        /* 单文件损坏跳过 */
      }
    }
  }

  // 4. 构建 city → stationId 映射
  const cityStation: Record<string, string> = {};
  for (const r of Object.values(predictions)) {
    if (r.city && r.stationId) cityStation[r.city] = r.stationId;
  }

  // 5. 读取现有黑白名单
  const existing = readExisting(projectRoot);
  const newChanges: CityWhitelistChange[] = [];

  // 6. 逐城市评估
  for (const city of ALL_CITIES) {
    const stationId = cityStation[city] ?? '';
    const trades = allTrades[city] ?? [];

    // 计算30天指标
    const pred30 = calcPredictionAccuracy(predictions, metarMax, city, stationId, 30, today);
    const trade30 = calcTradePerformance(trades, 30, today);

    // 计算14天指标
    const pred14 = calcPredictionAccuracy(predictions, metarMax, city, stationId, 14, today);
    const trade14 = calcTradePerformance(trades, 14, today);

    const metrics: CityWhitelistEntry['metrics'] = {
      intervalHitRate30d: pred30.intervalHitRate,
      predictionCount30d: pred30.count,
      tradeHitRate30d: trade30.tradeHitRate,
      tradeCount30d: trade30.count,
      pnl30d: trade30.pnl,
      intervalHitRate14d: pred14.intervalHitRate,
      predictionCount14d: pred14.count,
      tradeHitRate14d: trade14.tradeHitRate,
      tradeCount14d: trade14.count,
      pnl14d: trade14.pnl,
    };

    // 确定新状态
    const oldEntry = existing.cities[city];
    const oldStatus = oldEntry?.status ?? 'insufficient_data';

    // 被手动强制禁用 → 保持 blacklisted
    if (manualDisabled.has(city)) {
      const newEntry: CityWhitelistEntry = {
        city,
        status: 'blacklisted',
        blacklistedAt: oldEntry?.blacklistedAt ?? today,
        whitelistedAt: null,
        reason: '手动强制禁用（.env DISABLED_CITIES）',
        metrics,
        lastUpdated: new Date().toISOString(),
      };
      existing.cities[city] = newEntry;

      if (oldStatus !== 'blacklisted') {
        newChanges.push({
          city,
          from: oldStatus,
          to: 'blacklisted',
          reason: '手动强制禁用',
          metrics,
          detectedAt: new Date().toISOString(),
        });
      }
      continue;
    }

    // 数据不足时保持 insufficient_data 或检查是否有了足够数据
    const hasAnyData = pred30.count >= 1 || trade30.count >= 1;
    if (!hasAnyData) {
      existing.cities[city] = {
        city,
        status: 'insufficient_data',
        blacklistedAt: null,
        whitelistedAt: null,
        reason: '数据不足（尚无预报或交易记录）',
        metrics,
        lastUpdated: new Date().toISOString(),
      };
      continue;
    }

    // 判断状态
    let newStatus: CityWhitelistStatus;
    let newReason: string;

    if (oldStatus === 'blacklisted') {
      // 黑名单中的城市：检查是否满足白名单条件
      const wl = shouldWhitelist(metrics, thresholds);
      if (wl.yes) {
        newStatus = 'active';
        newReason = `自动恢复白名单：${wl.reason}`;
      } else {
        newStatus = 'blacklisted';
        newReason = oldEntry?.reason ?? '黑名单中（条件未达标）';
      }
    } else {
      // 活跃或数据不足：检查是否应进入黑名单
      const bl = shouldBlacklist(metrics, thresholds);
      if (bl.yes) {
        newStatus = 'blacklisted';
        newReason = `自动进入黑名单：${bl.reason}`;
      } else {
        newStatus = 'active';
        newReason = pred30.count >= 1 ? '预报命中率正常' : '数据不足';
      }
    }

    // 记录状态变更
    if (oldStatus !== newStatus) {
      newChanges.push({
        city,
        from: oldStatus,
        to: newStatus,
        reason: newReason,
        metrics,
        detectedAt: new Date().toISOString(),
      });
    }

    existing.cities[city] = {
      city,
      status: newStatus,
      blacklistedAt:
        newStatus === 'blacklisted'
          ? (oldEntry?.blacklistedAt ?? today)
          : null,
      whitelistedAt:
        newStatus === 'active' && oldStatus === 'blacklisted'
          ? today
          : oldEntry?.whitelistedAt ?? null,
      reason: newReason,
      metrics,
      lastUpdated: new Date().toISOString(),
    };
  }

  // 7. 追加变更记录（最多保留最近 50 条）
  existing.changes.push(...newChanges);
  if (existing.changes.length > 50) {
    existing.changes = existing.changes.slice(-50);
  }
  existing.updatedAt = new Date().toISOString();

  // 8. 写入文件
  writeWhitelist(projectRoot, existing);

  // 9. 计算最终被禁城市集合（黑名单 + 手动禁用）
  const disabledCities: CityId[] = [];
  for (const city of ALL_CITIES) {
    const entry = existing.cities[city];
    if (entry?.status === 'blacklisted' || manualDisabled.has(city)) {
      disabledCities.push(city);
    }
  }

  logger.info('黑白名单评估完成', {
    totalCities: ALL_CITIES.length,
    blacklisted: disabledCities.length,
    changes: newChanges.length,
    changesDetail: newChanges.map((c) => `${c.city}: ${c.from} → ${c.to}`),
  });

  return {
    data: existing,
    changes: newChanges,
    changedCities: newChanges,
    disabledCities,
  };
}

/**
 * 生成黑白名单状态变更的推送消息（企业微信 Markdown 格式）。
 */
export function buildWhitelistNotification(
  changes: CityWhitelistChange[],
): string | null {
  if (changes.length === 0) return null;

  const lines: string[] = [
    `**城市黑白名单变更通知**`,
    ``,
  ];

  for (const c of changes) {
    const cityName = CITY_CN[c.city] ?? c.city;
    const fromLabel = c.from === 'active' ? '活跃' : c.from === 'blacklisted' ? '黑名单' : '数据不足';
    const toLabel = c.to === 'active' ? '活跃' : c.to === 'blacklisted' ? '黑名单' : '数据不足';
    lines.push(
      `- **${cityName}**：${fromLabel} → **${toLabel}**`,
      `  原因：${c.reason}`,
    );
    if (c.metrics.intervalHitRate30d !== null) {
      lines.push(
        `  30天区间命中率：${(c.metrics.intervalHitRate30d * 100).toFixed(0)}%（${c.metrics.predictionCount30d}样本）`,
      );
    }
    if (c.metrics.tradeHitRate30d !== null) {
      lines.push(
        `  30天交易胜率：${(c.metrics.tradeHitRate30d * 100).toFixed(0)}%（${c.metrics.tradeCount30d}笔）`,
      );
    }
    if (c.metrics.pnl30d !== null) {
      const sign = c.metrics.pnl30d >= 0 ? '+' : '';
      lines.push(
        `  30天盈亏：${sign}$${c.metrics.pnl30d.toFixed(2)}`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 读取 city-whitelist.json，返回被禁城市集合。
 * 供 config-loader.ts 在启动时调用。
 */
export function loadDisabledCitiesFromWhitelist(
  projectRoot: string,
): CityId[] {
  const data = readExisting(projectRoot);
  const disabled: CityId[] = [];
  for (const city of ALL_CITIES) {
    const entry = data.cities[city];
    if (entry?.status === 'blacklisted') {
      disabled.push(city);
    }
  }
  return disabled;
}

/**
 * 执行评估并推送变更通知。
 * 供 winrate-report.ts 在每日报告末尾调用。
 */
export async function runWhitelistEvalAndNotify(
  projectRoot: string,
  manualDisabled: Set<CityId> = new Set(),
): Promise<WhitelistEvalResult> {
  const result = evaluateCityWhitelist(projectRoot, manualDisabled);

  if (result.changedCities.length > 0) {
    const msg = buildWhitelistNotification(result.changedCities);
    if (msg) {
      const ok = await sendWeComMarkdown(msg);
      logger.info('黑白名单变更通知已推送', {
        ok,
        changes: result.changedCities.length,
      });
    }
  }

  return result;
}