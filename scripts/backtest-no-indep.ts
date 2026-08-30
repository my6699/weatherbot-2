// 独立找 NO 被低估的桶
// 条件：开盘初期（D3/D2）+ NO 价格异常低
// 思路：市场开盘时，如果某个桶的 NO 极度便宜（市场确信该温度不会发生），
// 但实际温度可能落在别处，NO 就有机会。

import fs from 'node:fs';
import path from 'node:path';

const PH_DIR = path.resolve(process.cwd(), 'data/price-history');

// 扫描所有 price-history 文件
const phFiles = fs.readdirSync(PH_DIR).filter(f => f.endsWith('.json'));
console.log(`扫描 ${phFiles.length} 个市场文件\n`);

interface NoEntry {
  city: string; date: string;
  bucketA: string; bucketB: string;
  openingTime: number;
  noCost: number;       // NO 双桶价格
  yesA: number; yesB: number;
  actualTemp: number;
  // 结算
  tempInA: boolean;
  tempInB: boolean;
  noPayout: number;
  noPnl: number;
  // 开盘特征
  openingVolatility: number; // 开盘波动率
  isAdjacent: boolean;       // 是否相邻桶
}

function parseBucketRange(label: string): [number, number] {
  const cleaned = label.replace(/[<>=a-zA-Z°\s]/g, '');
  const parts = cleaned.split('-');
  if (parts.length === 1) {
    if (label.includes('<=')) return [-Infinity, parseInt(parts[0])];
    if (label.includes('>=')) return [parseInt(parts[0]), Infinity];
    return [parseInt(parts[0]), parseInt(parts[0])];
  }
  return [parseInt(parts[0]), parseInt(parts[1])];
}

function getSettlementTime(date: string): number {
  return new Date(date + 'T16:00:00Z').getTime() / 1000;
}

function getBucketSortKey(label: string): number {
  const num = parseInt(label.replace(/[<>=a-zA-Z°\s]/g, ''));
  return isNaN(num) ? 0 : num;
}

function areAdjacent(a: string, b: string): boolean {
  const ka = getBucketSortKey(a);
  const kb = getBucketSortKey(b);
  return Math.abs(ka - kb) <= 1;
}

const allEntries: NoEntry[] = [];
let skipped = 0;
let noOpening = 0;

for (const fname of phFiles) {
  // 解析城市和日期
  const match = fname.match(/^(.+)_(\d{4}-\d{2}-\d{2})\.json$/);
  if (!match) continue;
  const city = match[1];
  const date = match[2];

  let ph: any;
  try { ph = JSON.parse(fs.readFileSync(path.join(PH_DIR, fname), 'utf-8')); }
  catch { skipped++; continue; }

  const buckets = ph.buckets;
  if (!buckets || typeof buckets !== 'object') { skipped++; continue; }

  const settlementTime = getSettlementTime(date);
  const bucketKeys = Object.keys(buckets).sort((a, b) => getBucketSortKey(a) - getBucketSortKey(b));

  if (bucketKeys.length < 2) { skipped++; continue; }

  // 找开盘时间（最早的价格时间点）
  let earliestTime = Infinity;
  for (const key of bucketKeys) {
    const prices = buckets[key];
    if (Array.isArray(prices) && prices.length > 0) {
      for (const p of prices) {
        if (p.t < earliestTime) earliestTime = p.t;
      }
    }
  }

  if (!Number.isFinite(earliestTime) || earliestTime >= settlementTime) { noOpening++; continue; }

  // 开盘窗口：前 24 小时
  const openingWindow = earliestTime + 86400;
  const openingEnd = Math.min(openingWindow, settlementTime);

  // 收集每个桶在开盘窗口内的价格
  interface BucketPrice { yes: number; no: number; time: number; }
  const bucketPrices: Record<string, BucketPrice> = {};
  const bucketVolatilities: Record<string, number> = {};

  for (const key of bucketKeys) {
    const prices = buckets[key];
    if (!Array.isArray(prices) || prices.length === 0) continue;

    // 找开盘窗口内的第一个和最后一个价格
    let firstPrice: number | null = null;
    let lastPrice: number | null = null;
    let firstTime: number | null = null;
    let lastTime: number | null = null;
    const windowPrices: number[] = [];

    for (const p of prices) {
      if (p.t >= earliestTime && p.t <= openingEnd) {
        windowPrices.push(p.p);
        if (firstPrice === null) { firstPrice = p.p; firstTime = p.t; }
        lastPrice = p.p;
        lastTime = p.t;
      }
    }

    if (firstPrice === null) continue;

    // 开盘价格
    const yesPrice = firstPrice;
    bucketPrices[key] = { yes: yesPrice, no: 1 - yesPrice, time: firstTime! };

    // 开盘波动率：窗口内价格变化幅度
    if (windowPrices.length >= 2) {
      const maxP = Math.max(...windowPrices);
      const minP = Math.min(...windowPrices);
      bucketVolatilities[key] = (maxP - minP) / (maxP + minP + 0.001);
    } else {
      bucketVolatilities[key] = 0;
    }
  }

  const activeKeys = Object.keys(bucketPrices);
  if (activeKeys.length < 2) { noOpening++; continue; }

  // 按 NO 价格排序（从低到高，低 NO = 市场认为该桶最不可能）
  const sortedByNo = activeKeys.sort((a, b) => bucketPrices[a].no - bucketPrices[b].no);

  // 取 NO 最低的桶对（有两种组合：最低+次低，或者相邻的最低桶）
  let bestPair: [string, string] | null = null;
  let bestNoCost = Infinity;

  for (let i = 0; i < sortedByNo.length - 1; i++) {
    for (let j = i + 1; j < sortedByNo.length; j++) {
      const a = sortedByNo[i];
      const b = sortedByNo[j];
      const noCost = bucketPrices[a].no + bucketPrices[b].no;

      // 优先选相邻桶，但不相邻也可以
      if (noCost < bestNoCost) {
        bestNoCost = noCost;
        bestPair = [a, b];
      }
    }
  }

  if (!bestPair) { noOpening++; continue; }

  const [bA, bB] = bestPair;
  const noCost = bucketPrices[bA].no + bucketPrices[bB].no;
  const yesA = bucketPrices[bA].yes;
  const yesB = bucketPrices[bB].yes;
  const openingTime = Math.min(bucketPrices[bA].time, bucketPrices[bB].time);

  // 结算判断
  // 用实际温度检查
  // 从数据中找实际温度 - 这里没有，需要从 CSV 读取
  // 暂时跳过实际温度判断，后面再处理

  // 开盘波动率
  const volA = bucketVolatilities[bA] || 0;
  const volB = bucketVolatilities[bB] || 0;
  const openingVolatility = Math.max(volA, volB);

  allEntries.push({
    city, date,
    bucketA: bA, bucketB: bB,
    openingTime,
    noCost: Math.round(noCost * 1000) / 1000,
    yesA: Math.round(yesA * 1000) / 1000,
    yesB: Math.round(yesB * 1000) / 1000,
    actualTemp: 0, // 待填充
    tempInA: false, tempInB: false,
    noPayout: 0, noPnl: 0,
    openingVolatility: Math.round(openingVolatility * 1000) / 1000,
    isAdjacent: areAdjacent(bA, bB),
  });
}

console.log(`从 price-history 直接解析: ${allEntries.length} 个市场，跳过 ${skipped} 个，无开盘数据 ${noOpening} 个\n`);

// 现在需要实际温度数据来结算。从 CSV 读取
// 找最新回测 CSV
const CSV_DIR = path.resolve(process.cwd(), 'data/backtest');
const csvFiles = fs.readdirSync(CSV_DIR).filter(f => f.startsWith('backtest-detail_') && f.endsWith('.csv'));
csvFiles.sort().reverse();
if (csvFiles.length === 0) { console.error('没找到回测 CSV'); process.exit(1); }

const csvRaw = fs.readFileSync(path.join(CSV_DIR, csvFiles[0]), 'utf-8');
const lines = csvRaw.trim().split('\n');
const header = lines[0].split(',');
const csvRows = lines.slice(1).map(l => {
  const cols = l.split(',');
  const obj: Record<string, string> = {};
  header.forEach((h, i) => obj[h.trim()] = (cols[i] || '').trim());
  return obj;
});

// 建立温度映射
const tempMap: Record<string, { actualTemp: number; result: string }> = {};
for (const r of csvRows) {
  const key = `${r['城市']}_${r['日期']}`;
  const temp = parseFloat(r['实际温度C']);
  if (!isNaN(temp)) {
    tempMap[key] = { actualTemp: temp, result: r['结算结果'] };
  }
}

// 结算计算
const settledEntries: NoEntry[] = [];
for (const e of allEntries) {
  const key = `${e.city}_${e.date}`;
  const info = tempMap[key];
  if (!info) { continue; }

  e.actualTemp = info.actualTemp;

  const [aMin, aMax] = parseBucketRange(e.bucketA);
  const [bMin, bMax] = parseBucketRange(e.bucketB);
  e.tempInA = info.actualTemp >= aMin && info.actualTemp <= aMax;
  e.tempInB = info.actualTemp >= bMin && info.actualTemp <= bMax;

  if (e.tempInA || e.tempInB) {
    e.noPayout = 1;
  } else {
    e.noPayout = 2;
  }
  e.noPnl = Math.round((e.noPayout - e.noCost) * 1000) / 1000;
  settledEntries.push(e);
}

console.log(`有温度数据的市场: ${settledEntries.length} 个\n`);

// === 按 NO 价格阈值回测 ===
console.log('=== 开盘 NO 最低桶对回测 ===')
for (const threshold of [2.0, 1.9, 1.8, 1.7, 1.6, 1.5, 1.4, 1.3, 1.2, 1.1, 1.0, 0.9, 0.8, 0.7, 0.6, 0.5]) {
  const filtered = settledEntries.filter(e => e.noCost <= threshold);
  if (filtered.length === 0) continue;

  const wins = filtered.filter(e => e.noPnl > 0).length;
  const losses = filtered.filter(e => e.noPnl < 0).length;
  const pnl = filtered.reduce((s, e) => s + e.noPnl, 0);
  const avgCost = filtered.reduce((s, e) => s + e.noCost, 0) / filtered.length;
  const hitRate = filtered.filter(e => e.tempInA || e.tempInB).length / filtered.length * 100;
  console.log(`  NO ≤ $${threshold.toFixed(2)}: ${filtered.length}笔 赢${wins}亏${losses} 胜率${(wins/filtered.length*100).toFixed(0)}% PnL=$${pnl.toFixed(3)} 均入场=$${avgCost.toFixed(3)} 温度命中率=${hitRate.toFixed(0)}%`)
}

// 最佳阈值详细
console.log('\n=== 最佳区域详细（NO ≤ 1.3）===')
const best = settledEntries.filter(e => e.noCost <= 1.3);
const bestWins = best.filter(e => e.noPnl > 0).length;
const bestLosses = best.filter(e => e.noPnl < 0).length;
const bestPnl = best.reduce((s, e) => s + e.noPnl, 0);
console.log(`  入场: ${best.length}笔 赢${bestWins}亏${bestLosses} PnL=$${bestPnl.toFixed(3)}`)

// 按相邻/不相邻
const adj = best.filter(e => e.isAdjacent);
const nonAdj = best.filter(e => !e.isAdjacent);
console.log(`  相邻桶: ${adj.length}笔 PnL=$${adj.reduce((s, e) => s + e.noPnl, 0).toFixed(3)}`)
console.log(`  不相邻: ${nonAdj.length}笔 PnL=$${nonAdj.reduce((s, e) => s + e.noPnl, 0).toFixed(3)}`)

// 按波动率
const highVol = best.filter(e => e.openingVolatility > 0.1);
const lowVol = best.filter(e => e.openingVolatility <= 0.1);
console.log(`  高波动(>0.1): ${highVol.length}笔 PnL=$${highVol.reduce((s, e) => s + e.noPnl, 0).toFixed(3)}`)
console.log(`  低波动(≤0.1): ${lowVol.length}笔 PnL=$${lowVol.reduce((s, e) => s + e.noPnl, 0).toFixed(3)}`)

// 城市分布
const cStats: Record<string, { count: number; pnl: number; wins: number }> = {};
for (const e of best) {
  if (!cStats[e.city]) cStats[e.city] = { count: 0, pnl: 0, wins: 0 };
  cStats[e.city].count++;
  cStats[e.city].pnl += e.noPnl;
  if (e.noPnl > 0) cStats[e.city].wins++;
}
console.log('\n  城市分布:')
for (const [c, s] of Object.entries(cStats).sort((a, b) => b[1].pnl - a[1].pnl)) {
  console.log(`    ${c}: ${s.count}笔 赢${s.wins} PnL=$${s.pnl.toFixed(3)}`)
}

// 详细
console.log('\n  详细记录:')
console.log('  城市 日期 桶 YES价格 NO价格 开盘波动 相邻 温度 结果 NO盈亏')
for (const e of best) {
  const result = e.tempInA || e.tempInB ? '命中' : '未中';
  console.log(`  ${e.city} ${e.date} ${e.bucketA}+${e.bucketB} $${e.yesA}+$${e.yesB} $${e.noCost} ${e.openingVolatility} ${e.isAdjacent?'Y':'N'} ${e.actualTemp}°C ${result} $${e.noPnl.toFixed(3)}`)
}

// 全部 NO 价格分布
console.log('\n=== 开盘最低 NO 桶对的价格分布 ===')
const costs = settledEntries.map(e => e.noCost).sort((a, b) => a - b);
console.log(`  最小: $${costs[0]?.toFixed(3)}  5%: $${costs[Math.floor(costs.length * 0.05)]?.toFixed(3)}`)
console.log(`  25%: $${costs[Math.floor(costs.length * 0.25)]?.toFixed(3)}  中位数: $${costs[Math.floor(costs.length * 0.5)]?.toFixed(3)}`)
console.log(`  75%: $${costs[Math.floor(costs.length * 0.75)]?.toFixed(3)}  最大: $${costs[costs.length - 1]?.toFixed(3)}`)