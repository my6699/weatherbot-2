// 双桶 NO 策略：按成交量选桶（避开模型最优桶）
// 逻辑：高成交量桶 = 零售情绪驱动，YES 价格可能被高估 → NO 有机会
// 成交量代理：price history 中每个桶的数据点数量（越多=交易越活跃）
//
// 回测用同一份 backtest-detail CSV + price-history JSON

import fs from 'node:fs';
import path from 'node:path';

const CSV_DIR = path.resolve(process.cwd(), 'data/backtest');
const PH_DIR = path.resolve(process.cwd(), 'data/price-history');

// 找最新回测 CSV
const files = fs.readdirSync(CSV_DIR).filter(f => f.startsWith('backtest-detail_') && f.endsWith('.csv'));
files.sort().reverse();
const latestCsv = files[0];
if (!latestCsv) { console.error('没找到回测 CSV'); process.exit(1); }

console.log(`使用回测数据: ${latestCsv}\n`);

// 解析 CSV
const csvRaw = fs.readFileSync(path.join(CSV_DIR, latestCsv), 'utf-8');
const lines = csvRaw.trim().split('\n');
const header = lines[0].split(',');
const rows = lines.slice(1).map(l => {
  const cols = l.split(',');
  const obj: Record<string, string> = {};
  header.forEach((h, i) => obj[h.trim()] = (cols[i] || '').trim());
  return obj;
});

interface Result {
  city: string; date: string;
  modelBuckets: string;        // 模型选的最优桶
  modelEntry: number;          // 模型 YES 入场价
  volBuckets: string;          // 按成交量选的桶
  volYesCost: number;          // 高量桶的 YES 合计价格
  volNoCost: number;           // 高量桶的 NO 合计价格 = 2 - volYesCost
  volNoPnl: number;            // 高量桶买 NO 的盈亏
  actualTemp: number;
  result: string;              // 模型桶的结算结果
  volResult: string;           // 高量桶的结算结果
}

function findBucketPrice(ph: any, bucketLabel: string, targetTime: number): number | null {
  const prices = ph.buckets?.[bucketLabel];
  if (!prices || !Array.isArray(prices) || prices.length === 0) return null;
  let best = prices[0];
  for (const p of prices) {
    if (Math.abs(p.t - targetTime) < Math.abs(best.t - targetTime)) {
      best = p;
    }
  }
  return best.p;
}

function countDataPoints(ph: any, bucketLabel: string): number {
  const prices = ph.buckets?.[bucketLabel];
  if (!prices || !Array.isArray(prices)) return 0;
  return prices.length;
}

/** 找高成交量的相邻桶对（按 price history 数据点数量） */
function findHighVolumeAdjacentPair(ph: any, excludeBuckets: string[]): [string, string] | null {
  const bucketKeys = Object.keys(ph.buckets || {});
  if (bucketKeys.length < 2) return null;

  // 给每个桶打分（数据点数量 = 成交量代理）
  const scores: Record<string, number> = {};
  for (const k of bucketKeys) {
    scores[k] = countDataPoints(ph, k);
  }

  // 找相邻桶对，总分最高且不包含 excludeBuckets
  let bestPair: [string, string] | null = null;
  let bestScore = -1;

  // 桶按 label 排序（温度顺序）
  const sortedKeys = bucketKeys.sort((a, b) => {
    const numA = parseInt(a.replace(/[<>=a-zA-Z]/g, ''));
    const numB = parseInt(b.replace(/[<>=a-zA-Z]/g, ''));
    return numA - numB;
  });

  for (let i = 0; i < sortedKeys.length - 1; i++) {
    const a = sortedKeys[i];
    const b = sortedKeys[i + 1];
    // 排除模型最优桶
    if (excludeBuckets.includes(a) || excludeBuckets.includes(b)) continue;
    const totalScore = (scores[a] || 0) + (scores[b] || 0);
    if (totalScore > bestScore) {
      bestScore = totalScore;
      bestPair = [a, b];
    }
  }

  return bestPair;
}

function parseBucketRange(label: string): [number, number] {
  const cleaned = label.replace(/[<>=a-zA-Z°\s]/g, '');
  const parts = cleaned.split('-');
  if (parts.length === 1) {
    if (label.includes('<=') || label.includes('or below')) return [-Infinity, parseInt(parts[0])];
    if (label.includes('>=') || label.includes('or higher')) return [parseInt(parts[0]), Infinity];
    return [parseInt(parts[0]), parseInt(parts[0])];
  }
  return [parseInt(parts[0]), parseInt(parts[1])];
}

const results: Result[] = [];
let skipped = 0;
let noPairFound = 0;

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const city = r['城市'];
  const date = r['日期'];
  const bucketPair = r['桶组合'];
  const entryPriceStr = r['入场价'];
  const entryTimeStr = r['入场时间'];
  const actualTempStr = r['实际温度C'];
  const result = r['结算结果'];

  if (!entryPriceStr || !actualTempStr || !bucketPair) { skipped++; continue; }
  const entryPrice = parseFloat(entryPriceStr);
  const actualTemp = parseFloat(actualTempStr);
  if (isNaN(entryPrice) || isNaN(actualTemp)) { skipped++; continue; }

  let entryTime: number;
  if (entryTimeStr) {
    entryTime = new Date(entryTimeStr).getTime() / 1000;
  } else { skipped++; continue; }

  // 加载 price-history
  const phPath = path.join(PH_DIR, `${city}_${date}.json`);
  if (!fs.existsSync(phPath)) { skipped++; continue; }

  let ph: any;
  try { ph = JSON.parse(fs.readFileSync(phPath, 'utf-8')); } catch { skipped++; continue; }

  // 解析模型选的桶
  const modelParts = bucketPair.split('+');
  const modelBucketA = modelParts[0]?.trim() || '';
  const modelBucketB = modelParts[1]?.trim() || '';

  // 找高成交量相邻桶对（避开模型桶）
  const pair = findHighVolumeAdjacentPair(ph, [modelBucketA, modelBucketB]);
  if (!pair) { noPairFound++; continue; }

  const [volA, volB] = pair;

  // 找高量桶在 D2 的价格
  const yesA = findBucketPrice(ph, volA, entryTime);
  const yesB = findBucketPrice(ph, volB, entryTime);
  if (yesA === null || yesB === null) { noPairFound++; continue; }

  const volYesCost = yesA + yesB;
  const volNoCost = 2 - volYesCost;

  // 结算判断
  const [aMin, aMax] = parseBucketRange(volA);
  const [bMin, bMax] = parseBucketRange(volB);

  const inA = actualTemp >= aMin && actualTemp <= aMax;
  const inB = actualTemp >= bMin && actualTemp <= bMax;

  let noPayout: number;
  let volResult: string;
  if (inA || inB) {
    noPayout = 1;
    volResult = '命中';
  } else {
    noPayout = 2;
    volResult = '未中';
  }
  const volNoPnl = noPayout - volNoCost;

  results.push({
    city, date,
    modelBuckets: bucketPair,
    modelEntry: Math.round(entryPrice * 1000) / 1000,
    volBuckets: `${volA}+${volB}`,
    volYesCost: Math.round(volYesCost * 1000) / 1000,
    volNoCost: Math.round(volNoCost * 1000) / 1000,
    volNoPnl: Math.round(volNoPnl * 1000) / 1000,
    actualTemp,
    result,
    volResult,
  });
}

// === 输出 ===
console.log(`已处理 ${results.length} 个市场，跳过 ${skipped} 个，无高量桶对 ${noPairFound} 个\n`);

// 整体统计
const modelWins = results.filter(r => r.result === '命中').length;
const modelLosses = results.filter(r => r.result === '未中').length;
const modelTotalPnl = results.reduce((s, r) => s + (r.result === '命中' ? 1 - r.modelEntry : -r.modelEntry), 0);

const noWins = results.filter(r => r.volNoPnl > 0).length;
const noLosses = results.filter(r => r.volNoPnl < 0).length;
const noTotalPnl = results.reduce((s, r) => s + r.volNoPnl, 0);

// NO 分场景统计
const noFullWin = results.filter(r => r.volNoPnl > 0 && r.volResult === '未中').length;
const noPartialWin = results.filter(r => r.volNoPnl > 0 && r.volResult === '命中').length;
const noFullLoss = results.filter(r => r.volNoPnl < 0 && r.volResult === '未中').length;
const noPartialLoss = results.filter(r => r.volNoPnl < 0 && r.volResult === '命中').length;

console.log('=== 模型最优桶策略（买 YES）===')
console.log(`  盈利: ${modelWins}  亏损: ${modelLosses}  总盈亏: $${modelTotalPnl.toFixed(3)}`)

console.log('\n=== 高成交量桶 NO 策略 ===')
console.log(`  盈利: ${noWins}  亏损: ${noLosses}  总盈亏: $${noTotalPnl.toFixed(3)}`)
console.log(`  全赢(两桶都不落): ${noFullWin}  部分赢(落一桶): ${noPartialWin}`)
console.log(`  全亏(两桶都不落): ${noFullLoss}  部分亏(落一桶): ${noPartialLoss}`)

const avgNoCost = results.reduce((s, r) => s + r.volNoCost, 0) / results.length;
console.log(`\nNO 双桶入场均价: $${avgNoCost.toFixed(3)}`)

// === 按城市统计 ===
console.log('\n=== 按城市对比 ===')
const cityStats: Record<string, { modelPnl: number; noPnl: number; count: number }> = {};
for (const r of results) {
  if (!cityStats[r.city]) cityStats[r.city] = { modelPnl: 0, noPnl: 0, count: 0 };
  const modelPnl = r.result === '命中' ? 1 - r.modelEntry : -r.modelEntry;
  cityStats[r.city].modelPnl += modelPnl;
  cityStats[r.city].noPnl += r.volNoPnl;
  cityStats[r.city].count++;
}
for (const [city, s] of Object.entries(cityStats).sort((a, b) => b[1].noPnl - a[1].noPnl)) {
  const modelRoi = s.modelPnl / (s.count * 0.65) * 100;
  const noRoi = s.noPnl / (s.count * avgNoCost) * 100;
  console.log(`  ${city}: ${s.count}笔 模型YES=$${s.modelPnl.toFixed(3)} 高量NO=$${s.noPnl.toFixed(3)}`)
}

// === 高量桶 vs 模型桶的对比分析 ===
console.log('\n=== 高量桶 vs 模型桶对比 ===')
const samePair = results.filter(r => r.modelBuckets === r.volBuckets).length;
const diffPair = results.filter(r => r.modelBuckets !== r.volBuckets).length;
console.log(`  高量桶=模型桶: ${samePair} 笔`)
console.log(`  高量桶≠模型桶: ${diffPair} 笔`)

// 当高量桶 ≠ 模型桶时，NO 表现如何
const diffResults = results.filter(r => r.modelBuckets !== r.volBuckets);
const diffWins = diffResults.filter(r => r.volNoPnl > 0).length;
const diffLosses = diffResults.filter(r => r.volNoPnl < 0).length;
const diffPnl = diffResults.reduce((s, r) => s + r.volNoPnl, 0);
console.log(`  不同桶时 NO 策略: ${diffWins}赢 ${diffLosses}亏 PnL=$${diffPnl.toFixed(3)}`)

// 当高量桶 = 模型桶时，NO 表现如何
const sameResults = results.filter(r => r.modelBuckets === r.volBuckets);
const sameWins = sameResults.filter(r => r.volNoPnl > 0).length;
const sameLosses = sameResults.filter(r => r.volNoPnl < 0).length;
const samePnl = sameResults.reduce((s, r) => s + r.volNoPnl, 0);
console.log(`  相同桶时 NO 策略: ${sameWins}赢 ${sameLosses}亏 PnL=$${samePnl.toFixed(3)}`)

// === 前 10 盈利案例 ===
console.log('\n=== TOP 10 NO 盈利 ===')
const winners = results.filter(r => r.volNoPnl > 0).sort((a, b) => b.volNoPnl - a.volNoPnl);
for (const r of winners.slice(0, 10)) {
  console.log(`  ${r.city} ${r.date} 高量桶=${r.volBuckets} NO入场=$${r.volNoCost.toFixed(3)} PnL=$${r.volNoPnl.toFixed(3)} 温度=${r.actualTemp}°C 模型桶=${r.modelBuckets}(${r.modelEntry})`)
}

// === 前 10 亏损案例 ===
console.log('\n=== TOP 10 NO 亏损 ===')
const losers = results.filter(r => r.volNoPnl < 0).sort((a, b) => a.volNoPnl - b.volNoPnl);
for (const r of losers.slice(0, 10)) {
  console.log(`  ${r.city} ${r.date} 高量桶=${r.volBuckets} NO入场=$${r.volNoCost.toFixed(3)} PnL=$${r.volNoPnl.toFixed(3)} 温度=${r.actualTemp}°C 模型桶=${r.modelBuckets}(${r.modelEntry})`)
}

// 高量桶的分布
console.log('\n=== 高量桶的共性分析 ===')
const bucketFreq: Record<string, number> = {};
for (const r of results) {
  const b = r.volBuckets;
  bucketFreq[b] = (bucketFreq[b] || 0) + 1;
}
const sortedFreq = Object.entries(bucketFreq).sort((a, b) => b[1] - a[1]);
for (const [b, freq] of sortedFreq.slice(0, 15)) {
  console.log(`  ${b}: ${freq} 次`)
}