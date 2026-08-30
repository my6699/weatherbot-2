// 交易记录持久化模块。
//
// 负责把 paper/live 交易的每笔开仓、平仓、结算记录到 JSON 文件，
// 供每日报告脚本读取统计。
//
// 每个城市独立文件：data/trades-<city>.json
// 并发安全：读-改-写三部曲，写入临时文件再 rename 实现原子操作。

import fs from 'node:fs';
import path from 'node:path';
import type { CityId, TradeRecord, ForecastHorizon, TemperatureBucket, TradingMode } from '../common/types.js';

const TRADES_DIR = 'data';

function tradesFilePath(city: CityId): string {
  return path.join(TRADES_DIR, `trades-${city}.json`);
}

function ensureDir(): void {
  if (!fs.existsSync(TRADES_DIR)) {
    fs.mkdirSync(TRADES_DIR, { recursive: true });
  }
}

function readAll(city: CityId): TradeRecord[] {
  const filePath = tradesFilePath(city);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as TradeRecord[];
  } catch {
    return [];
  }
}

function writeAll(city: CityId, records: TradeRecord[]): void {
  ensureDir();
  const filePath = tradesFilePath(city);
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * 记录一笔新开仓。
 * 可传入自定义 tradeId，用于与 StrategyInstance 的 positionId 对齐。
 */
export function recordOpenTrade(
  city: CityId,
  horizon: ForecastHorizon,
  buckets: TemperatureBucket[],
  entryPrice: number,
  sizeUsd: number,
  side: 'YES' | 'NO',
  entryPriceA: number,
  entryPriceB: number,
  reason: string,
  tradeId?: string,
  targetDate?: string,
  mode?: TradingMode,
): TradeRecord {
  const records = readAll(city);
  const record: TradeRecord = {
    id: tradeId ?? `${city}-${buckets.map((b) => b.label).join('+')}-${Date.now()}`,
    city,
    horizon,
    targetDate: targetDate ?? '',
    buckets: buckets.map((b) => b.label),
    bucketLabel: buckets[0]?.label ?? '',
    // 持久化精确 °C 边界：重启恢复持仓对象用，不再依赖 config 桶 label 匹配。
    bucketBounds: buckets.map((b) => ({ minTempC: b.minTempC, maxTempC: b.maxTempC })),
    entryPrice,
    entryPriceA,
    entryPriceB,
    sizeUsd,
    side,
    openedAt: new Date().toISOString(),
    closedAt: null,
    exitPrice: null,
    exitPriceA: null,
    exitPriceB: null,
    pnl: null,
    hit: null,
    settledAt: null,
    settlementPrice: null,
    status: 'open',
    reason,
  };
  if (mode) record.mode = mode;
  records.push(record);
  writeAll(city, records);
  return record;
}

/**
 * 标记一笔交易为已平仓（离场，但未结算）。
 */
export function recordCloseTrade(
  city: CityId,
  tradeId: string,
  exitPrice: number,
  exitPriceA: number,
  exitPriceB: number,
): TradeRecord | null {
  const records = readAll(city);
  const idx = records.findIndex((r) => r.id === tradeId && r.status === 'open');
  if (idx === -1) return null;

  records[idx]!.closedAt = new Date().toISOString();
  records[idx]!.exitPrice = exitPrice;
  records[idx]!.exitPriceA = exitPriceA;
  records[idx]!.exitPriceB = exitPriceB;
  records[idx]!.status = 'closed';
  // 平仓即实现盈亏（2026-08-12）：不再等补结算才有 pnl，报告当日就能统计。
  // 口径与 recordSettleTrade 已平仓分支一致：
  //   双桶区间：half 仓位各按 exitPriceA/B - entryPriceA/B；命中 = pnl > 0。
  const r = records[idx]!;
  if (r.buckets.length >= 2 && exitPriceA !== null && exitPriceB !== null) {
    const half = r.sizeUsd / 2;
    r.pnl =
      Math.round(
        (half * (exitPriceA - r.entryPriceA) + half * (exitPriceB - r.entryPriceB)) * 100,
      ) / 100;
  } else {
    r.pnl = Math.round(r.sizeUsd * (exitPrice - r.entryPrice) * 100) / 100;
  }
  r.hit = r.pnl > 0;
  writeAll(city, records);
  return records[idx]!;
}

/**
 * 记录一次换仓（D1 漂移调仓）：旧桶→新桶，卖旧买新。
 *
 * 只更新 open 状态且尚未换仓过的记录。换仓后 status 仍为 open，
 * 持仓以新桶（switchKeys）继续监控/结算；进程重启后也从 switchKeys 恢复。
 * switchSell/switchBuy 是 0~1 的价格比例（两桶 YES 价和），供结算时算盈亏。
 */
export function recordSwitchTrade(
  city: CityId,
  tradeId: string,
  switchKeys: string[],
  switchSell: number,
  switchBuy: number,
  switchBucketBounds?: TemperatureBucket[],
): TradeRecord | null {
  const records = readAll(city);
  const idx = records.findIndex((r) => r.id === tradeId && r.status === 'open');
  if (idx === -1) return null;
  const record = records[idx]!;
  if (record.switched) return record; // 每笔只换一次

  record.switched = true;
  record.switchKeys = switchKeys;
  // 持久化新桶精确 °C 边界：重启后按边界恢复换仓后的持仓桶对象。
  if (switchBucketBounds?.length) {
    record.switchBucketBounds = switchBucketBounds.map((b) => ({ minTempC: b.minTempC, maxTempC: b.maxTempC }));
  }
  record.switchSell = Math.round(switchSell * 1000) / 1000;
  record.switchBuy = Math.round(switchBuy * 1000) / 1000;
  record.switchAt = new Date().toISOString();
  writeAll(city, records);
  return record;
}

/**
 * 结算一笔交易（市场已结算，知道实际结果和盈亏）。
 * settlementPrice 是结算时 YES 的价格（0 或 1）。
 * 双桶区间：settlementPriceB 是第二个桶的结算价；pnl 按两个桶各半仓精确计算
 * （单桶时 settlementPriceB 缺省忽略，用原单桶公式）。
 *
 * 换仓过的记录（switched）：旧桶段已实现收益 = sizeUsd*(switchSell-entryPrice)，
 * 新桶段待结算 = sizeUsd*(settleNew-switchBuy)，其中 settleNew 是新桶的平均结算比例
 * （双新桶取 (A+B)/2）。与回测 SWITCH_D1 口径一致（profit = (sell-entry)+(settle-buy)）。
 */
export function recordSettleTrade(
  city: CityId,
  tradeId: string,
  settlementPrice: number,
  settlementPriceB?: number,
  viaBackfill = false,
): TradeRecord | null {
  const records = readAll(city);
  const idx = records.findIndex((r) => r.id === tradeId && r.status !== 'settled');
  if (idx === -1) return null;

  const record = records[idx]!;
  record.settledAt = new Date().toISOString();
  record.status = 'settled';
  // 补结算标记：由 settleDuePositions 补记的持仓打标，统计报告与正常结算分开看。
  if (viaBackfill) record.viaSettleBackfill = true;

  // 已平仓记录（离场价已实现）：盈亏按平仓实现价算，不再用结算价。
  // 覆盖"峰值前平仓 / 峰值到点平仓"后由补结算补记 pnl 的持仓。
  // 双桶区间：half 仓位各按 exitPriceA/B - entryPriceA/B；命中 = 任一桶平仓价 > 0.5。
  if (record.closedAt && record.exitPrice !== null) {
    if (
      record.buckets.length >= 2 &&
      record.exitPriceA !== null &&
      record.exitPriceB !== null
    ) {
      const half = record.sizeUsd / 2;
      record.pnl =
        Math.round(
          (half * (record.exitPriceA - record.entryPriceA) +
            half * (record.exitPriceB - record.entryPriceB)) *
            100,
        ) / 100;
      // 提前平仓的记录：命中 = 实际盈利（pnl>0）。
      // 旧口径 exitPrice>0.5 对提前平仓不合理（如 0.25 平仓但入场 0.11 仍是赢）。
      record.hit = record.pnl > 0;
    } else {
      record.pnl = Math.round(record.sizeUsd * (record.exitPrice - record.entryPrice) * 100) / 100;
      record.hit = record.pnl > 0;
    }
    record.settlementPrice = settlementPrice;
    writeAll(city, records);
    return record;
  }

  // 换仓笔：旧桶段已实现 + 新桶段结算，不再按原开仓桶算。
  if (record.switched && record.switchSell !== undefined && record.switchBuy !== undefined) {
    const sellRef = record.switchSell;
    const buyRef = record.switchBuy;
    const settleNew =
      record.switchKeys && record.switchKeys.length >= 2 && settlementPriceB !== undefined
        ? (settlementPrice + settlementPriceB) / 2
        : settlementPrice;
    record.settlementPrice = settlementPrice;
    record.hit = settleNew > 0.5;
    // 新桶段的"名义仓位"与开仓时一致（sizeUsd 总额度）。
    record.pnl = Math.round(record.sizeUsd * (sellRef - record.entryPrice + settleNew - buyRef) * 100) / 100;
  } else if (record.buckets.length >= 2 && settlementPriceB !== undefined) {
    // 双桶区间：两个桶各 half 仓位，各自的结算价独立计算盈亏。
    record.settlementPrice = settlementPrice;
    const half = record.sizeUsd / 2;
    const pnlA = half * (settlementPrice - record.entryPriceA);
    const pnlB = half * (settlementPriceB - record.entryPriceB);
    record.pnl = Math.round((pnlA + pnlB) * 100) / 100;
    record.hit = settlementPrice > 0.5 || settlementPriceB > 0.5;
  } else {
    record.settlementPrice = settlementPrice;
    record.hit = settlementPrice > 0.5;
    // 计算实际盈亏
    if (record.side === 'YES') {
      record.pnl = record.sizeUsd * (settlementPrice - record.entryPrice);
    } else {
      // NO 仓位：结算时 NO 价格 = 1 - settlementPrice
      record.pnl = record.sizeUsd * ((1 - settlementPrice) - (1 - record.entryPrice));
    }
  }

  writeAll(city, records);
  return record;
}

/**
 * 读取某个城市的所有交易记录。
 */
export function readTrades(city: CityId): TradeRecord[] {
  return readAll(city);
}

/**
 * 读取所有城市的交易记录。
 */
export function readAllTrades(): TradeRecord[] {
  if (!fs.existsSync(TRADES_DIR)) return [];

  const all: TradeRecord[] = [];
  const files = fs.readdirSync(TRADES_DIR);
  for (const file of files) {
    if (!file.startsWith('trades-') || !file.endsWith('.json')) continue;
    const city = file.replace('trades-', '').replace('.json', '') as CityId;
    all.push(...readAll(city));
  }
  return all;
}

/**
 * 获取今日已结算的交易（用于每日报告）。
 */
export function getTodaySettledTrades(): TradeRecord[] {
  const all = readAllTrades();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return all.filter((r) => {
    if (r.status !== 'settled' || !r.settledAt) return false;
    return r.settledAt.slice(0, 10) === today;
  });
}

/**
 * 获取今日已平仓的交易（离场但未结算，或今日开仓）。
 */
export function getTodayClosedTrades(): TradeRecord[] {
  const all = readAllTrades();
  const today = new Date().toISOString().slice(0, 10);
  return all.filter((r) => {
    if (r.closedAt && r.closedAt.slice(0, 10) === today) return true;
    if (r.openedAt.slice(0, 10) === today) return true;
    return false;
  });
}

/**
 * 获取所有未结算的持仓（open 或 closed 状态）。
 */
export function getOpenPositions(): TradeRecord[] {
  const all = readAllTrades();
  return all.filter((r) => r.status === 'open' || r.status === 'closed');
}

/**
 * 获取所有已结算交易的总盈亏。
 */
export function getTotalPnL(): number {
  const all = readAllTrades();
  return all
    .filter((r) => r.status === 'settled' && r.pnl !== null)
    .reduce((sum, r) => sum + (r.pnl ?? 0), 0);
}

// ============================================================================
// 交易决策日志（trade journal，2026-08-12）
// ============================================================================
// 独立文件 data/trade-journal.json：
//   evaluations[]：每次"开仓评估"的完整决策快照（含跳过原因），不管最终是否
//     开仓都记——复盘"这笔为什么没开 / 开了之后为什么亏"从这里查。
//   traces{}：每笔持仓的逐轮价格轨迹（opened/hold/switched/exit/settled），
//     sumBid 从开仓到平仓怎么走的直接回放，一眼看出失败是怎么造成的。
// 结构版本化，未来字段只增不减，兼容旧文件。

const JOURNAL_FILE = 'data/trade-journal.json';

interface JournalFile {
  version: number;
  evaluations: Array<Record<string, unknown>>;
  traces: Record<
    string,
    {
      city: string;
      points: Array<{
        t: string;
        action: string;
        sumBid?: number;
        note?: string;
      }>;
    }
  >;
}

function readJournal(): JournalFile {
  if (!fs.existsSync(JOURNAL_FILE)) {
    return { version: 1, evaluations: [], traces: {} };
  }
  try {
    const raw = fs.readFileSync(JOURNAL_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<JournalFile>;
    return {
      version: parsed.version ?? 1,
      evaluations: parsed.evaluations ?? [],
      traces: parsed.traces ?? {},
    };
  } catch {
    // 文件损坏（如半写）时重建，不阻塞交易。
    return { version: 1, evaluations: [], traces: {} };
  }
}

function writeJournal(j: JournalFile): void {
  ensureDir();
  const tmpPath = JOURNAL_FILE + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(j, null, 2), 'utf-8');
  fs.renameSync(tmpPath, JOURNAL_FILE);
}

/**
 * 记录一次开仓评估（含最终决策与跳过原因）。
 * 每次引擎评估都记，开仓/跳过/无决策都有据可查。
 */
export function journalEvaluation(e: Record<string, unknown>): void {
  const j = readJournal();
  j.evaluations.push({ t: new Date().toISOString(), ...e });
  // 上限保护：只保留最近 5000 条评估，防文件无限膨胀。
  if (j.evaluations.length > 5000) {
    j.evaluations.splice(0, j.evaluations.length - 5000);
  }
  writeJournal(j);
}

/**
 * 记录一笔持仓的轨迹点。
 * action: opened / hold / switched / exit / settled。
 * sumBid = 双桶实时 bid 之和（0~2），开仓时用入场成本近似。
 */
export function appendPositionTrace(
  tradeId: string,
  city: string,
  action: string,
  sumBid?: number | undefined,
  note?: string | undefined,
): void {
  const j = readJournal();
  const entry = j.traces[tradeId] ?? { city, points: [] };
  entry.city = city;
  entry.points.push({
    t: new Date().toISOString(),
    action,
    ...(sumBid !== undefined ? { sumBid } : {}),
    ...(note !== undefined ? { note } : {}),
  });
  // 每笔轨迹保留最近 400 点（约 2.7 天 @10min/轮），足够复盘完整生命周期。
  if (entry.points.length > 400) {
    entry.points.splice(0, entry.points.length - 400);
  }
  j.traces[tradeId] = entry;
  writeJournal(j);
}

/** 读取全部交易决策日志（评估事件 + 持仓轨迹），供报告/分析脚本使用。 */
export function readJournalFile(): JournalFile {
  return readJournal();
}