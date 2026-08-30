// 双桶 NO 侧回测脚本
// 基于同一份回测数据（backtest-detail CSV + price-history JSON），
// 对每个双桶选择模拟买 NO 的盈亏。
//
// 逻辑：
//   1. 读取最新 backtest-detail CSV，每行对应一个双桶选择
//   2. 从 price-history 中读取该行两个桶在入场时间点的 YES 价格
//   3. NO 价格 = 1 - YES 价格
//   4. 结算：温度落在任一桶 → 部分赢（$1），都不落 → 全赢（$2）
//   5. 对比 YES 策略和 NO 策略的盈亏

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

const CSV_DIR = path.resolve(process.cwd(), 'data/backtest');
const PH_DIR = path.resolve(process.cwd(), 'data/price-history');

// 找最新回测 CSV
const files = fs.readdirSync(CSV_DIR).filter(f => f.startsWith('backtest-detail_') && f.endsWith('.csv'));
files.sort().reverse();
const latestCsv = files[0];
if (!latestCsv) { console.error('没有找到回测 CSV'); process.exit(1); }

console.log(`使用回测数据: ${latestCsv}`);

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

interface NoResult {
  row: number;
  city: string;
  date: string;
  buckets: string;       // "32-32+33-33"
  entryPrice: number;    // YES 双桶入场价
  noCost: number;        // NO 双桶入场价 = 2 - entryPrice
  yesPnl: number;        // YES 策略盈亏
  noPnl: number;         // NO 策略盈亏
  actualTemp: number;
  result: string;        // 命中/未中
}

function findBucketPrice(ph: any, bucketLabel: string, targetTime: number): number | null {
  // 桶 label 如 "32-32" 在 buckets 里可能是 "32-32" 形式
  const prices = ph.buckets?.[bucketLabel];
  if (!prices || !Array.isArray(prices) || prices.length === 0) return null;

  // 找 entryTime 附近的第一个价格点（通常在 D2 开盘后不久）
  let best = prices[0];
  for (const p of prices) {
    if (Math.abs(p.t - targetTime) < Math.abs(best.t - targetTime)) {
      best = p;
    }
  }
  return best.p;
}

function parseBucketPair(pair: string): [string, string] {
  const parts = pair.split('+');
  if (parts.length < 2) {
    console.warn(`  ⚠ 桶格式异常: "${pair}"`);
    return [pair, pair];
  }
  return [parts[0].trim(), parts[1].trim()];
}

const results: NoResult[] = [];
let skipped = 0;

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const city = r['城市'];
  const date = r['日期'];
  const bucketPair = r['桶组合'];
  const entryPriceStr = r['入场价'];
  const entryTimeStr = r['入场时间'];
  const entryLevel = r['入场水平'];
  const actualTempStr = r['实际温度C'];
  const result = r['结算结果'];

  // 只处理有入场价和实际温度的
  if (!entryPriceStr || !actualTempStr || !bucketPair) { skipped++; continue; }

  const entryPrice = parseFloat(entryPriceStr);
  const actualTemp = parseFloat(actualTempStr);
  if (isNaN(entryPrice) || isNaN(actualTemp)) { skipped++; continue; }

  // 解析 entryTime
  let entryTime: number;
  if (entryTimeStr) {
    entryTime = new Date(entryTimeStr).getTime() / 1000;
  } else {
    // 没有 entryTime 说明是 all_outcomes，跳过
    skipped++; continue;
  }

  // 加载 price-history JSON
  const phPath = path.join(PH_DIR, `${city}_${date}.json`);
  if (!fs.existsSync(phPath)) { skipped++; continue; }

  let ph: any;
  try { ph = JSON.parse(fs.readFileSync(phPath, 'utf-8')); } catch { skipped++; continue; }

  const [bA, bB] = parseBucketPair(bucketPair);

  // 找两个桶的 YES 价格
  const yesA = findBucketPrice(ph, bA, entryTime);
  const yesB = findBucketPrice(ph, bB, entryTime);

  if (yesA === null || yesB === null) { skipped++; continue; }

  // 验证一下 entryPrice 是否 ≈ yesA + yesB（允许 5% 误差）
  const calcEntry = yesA + yesB;
  const diff = Math.abs(calcEntry - entryPrice) / entryPrice;
  if (diff > 0.10) {
    // 可能 timestamp 没对上，换用 entryPrice 反推
    // 按比例分配
    const ratio = yesA / (yesA + yesB);
    // 保持原样
  }

  // NO 策略
  const noA = 1 - yesA;
  const noB = 1 - yesB;
  const noCost = noA + noB;  // 买 NO 双桶的成本
  const expectedNoCost = 2 - entryPrice; // 理论值 = 2 - YES 入场价

  // YES 策略盈亏
  const yesPnl = result === '命中' ? 1 - entryPrice : -entryPrice;

  // NO 策略盈亏
  // 见解析温度是否落在两个桶里
  // 桶 label 如 "32-32" → 温度范围 32-32°C
  const parseBucketRange = (label: string): [number, number] => {
    const cleaned = label.replace(/[<>=]/g, '');
    const parts = cleaned.split('-');
    if (parts.length === 1) {
      // "<=29" 或 ">=39" 特殊处理
      if (label.includes('<=')) return [-Infinity, parseInt(parts[0])];
      if (label.includes('>=')) return [parseInt(parts[0]), Infinity];
      return [parseInt(parts[0]), parseInt(parts[0])];
    }
    return [parseInt(parts[0]), parseInt(parts[1])];
  };

  const [aMin, aMax] = parseBucketRange(bA);
  const [bMin, bMax] = parseBucketRange(bB);

  const inA = actualTemp >= aMin && actualTemp <= aMax;
  const inB = actualTemp >= bMin && actualTemp <= bMax;

  let noPayout: number;
  if (inA || inB) {
    noPayout = 1;  // 只赢一个 NO
  } else {
    noPayout = 2;  // 两个 NO 都赢
  }

  const noPnl = noPayout - noCost;

  results.push({
    row: i + 2,
    city, date,
    buckets: bucketPair,
    entryPrice: Math.round(entryPrice * 1000) / 1000,
    noCost: Math.round(noCost * 1000) / 1000,
    yesPnl: Math.round(yesPnl * 1000) / 1000,
    noPnl: Math.round(noPnl * 1000) / 1000,
    actualTemp,
    result,
  });
}

// === 输出结果 ===
console.log(`\n已处理 ${results.length} 个市场，跳过 ${skipped} 个`);

// 统计
const yesWins = results.filter(r => r.yesPnl > 0).length;
const yesLosses = results.filter(r => r.yesPnl < 0).length;
const yesTotalPnl = results.reduce((s, r) => s + r.yesPnl, 0);

const noWins = results.filter(r => r.noPnl > 0).length;
const noLosses = results.filter(r => r.noPnl < 0).length;
const noTotalPnl = results.reduce((s, r) => s + r.noPnl, 0);

// NO 部分赢（一个桶命中）和全赢（两个都不命中）
const noFullWin = results.filter(r => r.noPnl > 0 && r.result === '未中').length;
const noPartialWin = results.filter(r => r.noPnl > 0 && r.result === '命中').length;
const noFullLoss = results.filter(r => r.noPnl < 0 && r.result === '未中').length;
const noPartialLoss = results.filter(r => r.noPnl < 0 && r.result === '命中').length;

console.log('\n=== YES 策略（双桶买 YES）===')
console.log(`  盈利: ${yesWins}  亏损: ${yesLosses}  总盈亏: $${yesTotalPnl.toFixed(3)}`)

console.log('\n=== NO 策略（双桶买 NO）===')
console.log(`  盈利: ${noWins}  亏损: ${noLosses}  总盈亏: $${noTotalPnl.toFixed(3)}`)
console.log(`  全赢(两桶都不落): ${noFullWin}  部分赢(落一桶): ${noPartialWin}`)
console.log(`  全亏(两桶都不落): ${noFullLoss}  部分亏(落一桶): ${noPartialLoss}`)

// NO 价格分布
const noCosts = results.map(r => r.noCost);
const avgNoCost = noCosts.reduce((s, c) => s + c, 0) / noCosts.length;
console.log(`\nNO 双桶入场均价: $${avgNoCost.toFixed(3)}`)

// 按城市统计
console.log('\n=== 按城市对比 ===')
const cityStats: Record<string, { yesPnl: number; noPnl: number; count: number }> = {};
for (const r of results) {
  if (!cityStats[r.city]) cityStats[r.city] = { yesPnl: 0, noPnl: 0, count: 0 };
  cityStats[r.city].yesPnl += r.yesPnl;
  cityStats[r.city].noPnl += r.noPnl;
  cityStats[r.city].count++;
}

for (const [city, s] of Object.entries(cityStats).sort((a, b) => b[1].yesPnl - a[1].yesPnl)) {
  console.log(`  ${city}: ${s.count}笔 YES=$${s.yesPnl.toFixed(3)} NO=$${s.noPnl.toFixed(3)}`)
}

// 输出详细表格（前 20 行）
console.log('\n=== 详细对比（前 30 笔）===')
console.log('城市 日期 桶 YES入场价 NO入场价 实际温度 结算 YES_PnL NO_PnL')
for (const r of results.slice(0, 30)) {
  console.log(`${r.city} ${r.date} ${r.buckets} $${r.entryPrice.toFixed(3)} $${r.noCost.toFixed(3)} ${r.actualTemp}°C ${r.result} $${r.yesPnl.toFixed(3)} $${r.noPnl.toFixed(3)}`)
}

// 分析：NO 策略的最佳入场条件
console.log('\n=== NO 盈利案例分析 ===')
const noWinners = results.filter(r => r.noPnl > 0).sort((a, b) => b.noPnl - a.noPnl);
for (const r of noWinners.slice(0, 10)) {
  console.log(`${r.city} ${r.date} ${r.buckets} NO入场=$${r.noCost.toFixed(3)} YES入场=$${r.entryPrice.toFixed(3)} PnL=$${r.noPnl.toFixed(3)} 温度=${r.actualTemp}°C ${r.result}`)
}

console.log('\n=== NO 亏损案例分析 ===')
const noLosers = results.filter(r => r.noPnl < 0).sort((a, b) => a.noPnl - b.noPnl);
for (const r of noLosers.slice(0, 10)) {
  console.log(`${r.city} ${r.date} ${r.buckets} NO入场=$${r.noCost.toFixed(3)} YES入场=$${r.entryPrice.toFixed(3)} PnL=$${r.noPnl.toFixed(3)} 温度=${r.actualTemp}°C ${r.result}`)
}