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
): TradeRecord | null {
  const records = readAll(city);
  const idx = records.findIndex((r) => r.id === tradeId && r.status !== 'settled');
  if (idx === -1) return null;

  const record = records[idx]!;
  record.settledAt = new Date().toISOString();
  record.status = 'settled';

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