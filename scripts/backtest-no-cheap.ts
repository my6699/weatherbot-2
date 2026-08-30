// 双桶 NO 策略：模型最优桶 + 不限时间
// 先看 NO 价格分布，再找合理的入场阈值

import fs from 'node:fs';
import path from 'node:path';

const CSV_DIR = path.resolve(process.cwd(), 'data/backtest');
const PH_DIR = path.resolve(process.cwd(), 'data/price-history');

const files = fs.readdirSync(CSV_DIR).filter(f => f.startsWith('backtest-detail_') && f.endsWith('.csv'));
files.sort().reverse();
const latestCsv = files[0];

const csvRaw = fs.readFileSync(path.join(CSV_DIR, latestCsv), 'utf-8');
const lines = csvRaw.trim().split('\n');
const header = lines[0].split(',');
const rows = lines.slice(1).map(l => {
  const cols = l.split(',');
  const obj: Record<string, string> = {};
  header.forEach((h, i) => obj[h.trim()] = (cols[i] || '').trim());
  return obj;
});

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

// 收集所有市场的 NO 价格分布
const noPriceDist: number[] = [];
const noPriceByResult: { hit: number[]; miss: number[] } = { hit: [], miss: [] };
const entries: any[] = [];

let skipped = 0;

for (const r of rows) {
  const city = r['城市'];
  const date = r['日期'];
  const bucketPair = r['桶组合'];
  const actualTempStr = r['实际温度C'];
  const result = r['结算结果'];

  if (!actualTempStr || !bucketPair) { skipped++; continue; }
  const actualTemp = parseFloat(actualTempStr);
  if (isNaN(actualTemp)) { skipped++; continue; }

  const parts = bucketPair.split('+');
  const bA = parts[0]?.trim() || '';
  const bB = parts[1]?.trim() || '';

  const phPath = path.join(PH_DIR, `${city}_${date}.json`);
  if (!fs.existsSync(phPath)) { skipped++; continue; }
  let ph: any;
  try { ph = JSON.parse(fs.readFileSync(phPath, 'utf-8')); } catch { skipped++; continue; }

  const pricesA = ph.buckets?.[bA];
  const pricesB = ph.buckets?.[bB];
  if (!pricesA || !pricesB) { skipped++; continue; }

  const settlementTime = getSettlementTime(date);
  const [aMin, aMax] = parseBucketRange(bA);
  const [bMin, bMax] = parseBucketRange(bB);
  const inA = actualTemp >= aMin && actualTemp <= aMax;
  const inB = actualTemp >= bMin && actualTemp <= bMax;
  const modelHit = inA || inB;

  // 收集所有时间点的 NO 价格
  const allTimes = new Set<number>();
  for (const p of pricesA) if (p.t) allTimes.add(p.t);
  for (const p of pricesB) if (p.t) allTimes.add(p.t);

  const sortedTimes = Array.from(allTimes).sort((a, b) => a - b);

  for (const t of sortedTimes) {
    if (t >= settlementTime) continue;
    const pa = pricesA.find((p: any) => p.t === t);
    const pb = pricesB.find((p: any) => p.t === t);
    if (!pa || !pb) continue;

    const noCost = 2 - (pa.p + pb.p);
    noPriceDist.push(noCost);

    if (modelHit) noPriceByResult.hit.push(noCost);
    else noPriceByResult.miss.push(noCost);

    if (noCost <= 1.0) {
      const secs = settlementTime - t;
      const hours = Math.round(secs / 3600);
      let horizon = 'D3';
      if (hours <= 60) horizon = 'D2';
      if (hours <= 36) horizon = 'D1';
      if (hours <= 12) horizon = 'D0';

      entries.push({
        city, date, buckets: bucketPair,
        noCost: Math.round(noCost * 1000) / 1000,
        yesCost: Math.round((pa.p + pb.p) * 1000) / 1000,
        horizon, hoursBefore: hours,
        modelHit, actualTemp, result,
        noPayout: modelHit ? 1 : 2,
        noPnl: Math.round(((modelHit ? 1 : 2) - noCost) * 1000) / 1000,
      });
    }
  }
}

// NO 价格分布
console.log('=== 模型最优桶的 NO 价格分布 ===')
noPriceDist.sort((a, b) => a - b);
const p5 = noPriceDist[Math.floor(noPriceDist.length * 0.05)];
const p10 = noPriceDist[Math.floor(noPriceDist.length * 0.1)];
const p25 = noPriceDist[Math.floor(noPriceDist.length * 0.25)];
const p50 = noPriceDist[Math.floor(noPriceDist.length * 0.5)];
const p75 = noPriceDist[Math.floor(noPriceDist.length * 0.75)];
const p90 = noPriceDist[Math.floor(noPriceDist.length * 0.9)];
const min = noPriceDist[0];
const max = noPriceDist[noPriceDist.length - 1];
console.log(`  样本量: ${noPriceDist.length} 个时间点`)
console.log(`  最小: $${min.toFixed(3)}  5%: $${p5.toFixed(3)}  10%: $${p10.toFixed(3)}  25%: $${p25.toFixed(3)}`)
console.log(`  中位数: $${p50.toFixed(3)}  75%: $${p75.toFixed(3)}  90%: $${p90.toFixed(3)}  最大: $${max.toFixed(3)}`)

// 按阈值回测
console.log('\n=== 按 NO 价格阈值回测（模型最优桶 + 不限时间）===')
for (const threshold of [1.0, 0.95, 0.90, 0.85, 0.80, 0.75, 0.70, 0.65, 0.60, 0.55, 0.50]) {
  const filtered = entries.filter(e => e.noCost <= threshold);

  // 去重：每个市场只取最早入场点
  const seen = new Set<string>();
  const unique: typeof entries = [];
  for (const e of filtered) {
    const key = `${e.city}_${e.date}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(e);
    }
  }

  if (unique.length === 0) continue;
  const wins = unique.filter(e => e.noPnl > 0).length;
  const losses = unique.filter(e => e.noPnl < 0).length;
  const pnl = unique.reduce((s, e) => s + e.noPnl, 0);
  const avgCost = unique.reduce((s, e) => s + e.noCost, 0) / unique.length;
  console.log(`  NO ≤ $${threshold.toFixed(2)}: ${unique.length}笔 赢${wins}亏${losses} 胜率${(wins/unique.length*100).toFixed(0)}% PnL=$${pnl.toFixed(3)} 均入场=$${avgCost.toFixed(3)}`)
}

// 最佳阈值详细
console.log('\n=== 最佳阈值详细（NO ≤ 1.0，去重取最早入场）===')
const bestThreshold = 1.0;
const best = entries.filter(e => e.noCost <= bestThreshold);
const seen = new Set<string>();
const uniqueBest: typeof entries = [];
for (const e of best) {
  const key = `${e.city}_${e.date}`;
  if (!seen.has(key)) {
    seen.add(key);
    uniqueBest.push(e);
  }
}

const bestWins = uniqueBest.filter(e => e.noPnl > 0).length;
const bestLosses = uniqueBest.filter(e => e.noPnl < 0).length;
const bestPnl = uniqueBest.reduce((s, e) => s + e.noPnl, 0);

console.log(`  入场: ${uniqueBest.length}笔 赢${bestWins}亏${bestLosses} PnL=$${bestPnl.toFixed(3)}`)

// 按入场时间分布
const hStats: Record<string, { count: number; pnl: number }> = {};
for (const e of uniqueBest) {
  if (!hStats[e.horizon]) hStats[e.horizon] = { count: 0, pnl: 0 };
  hStats[e.horizon].count++;
  hStats[e.horizon].pnl += e.noPnl;
}
console.log('\n  入场时间分布:')
for (const [h, s] of Object.entries(hStats).sort()) {
  console.log(`    ${h}: ${s.count}笔 PnL=$${s.pnl.toFixed(3)}`)
}

// 城市分布
const cStats: Record<string, { count: number; pnl: number }> = {};
for (const e of uniqueBest) {
  if (!cStats[e.city]) cStats[e.city] = { count: 0, pnl: 0 };
  cStats[e.city].count++;
  cStats[e.city].pnl += e.noPnl;
}
console.log('\n  城市分布:')
for (const [c, s] of Object.entries(cStats).sort((a, b) => b[1].pnl - a[1].pnl)) {
  console.log(`    ${c}: ${s.count}笔 PnL=$${s.pnl.toFixed(3)}`)
}

// 详细记录
console.log('\n  详细记录（前20笔）:')
console.log('  城市 日期 桶 YES总价 NO入场 时间 距结算 结果 NO盈亏')
for (const e of uniqueBest.slice(0, 20)) {
  console.log(`  ${e.city} ${e.date} ${e.buckets} $${e.yesCost.toFixed(3)} $${e.noCost.toFixed(3)} ${e.horizon}(${-e.hoursBefore}h) ${e.result} $${e.noPnl.toFixed(3)}`)
}

// 底部亏损案例
console.log('\n  亏损案例（全部）:')
const losers = uniqueBest.filter(e => e.noPnl < 0).sort((a, b) => a.noPnl - b.noPnl);
for (const e of losers) {
  console.log(`  ${e.city} ${e.date} ${e.buckets} NO=$${e.noCost.toFixed(3)} ${e.horizon}(${-e.hoursBefore}h) 温度=${e.actualTemp}°C ${e.result} pnl=$${e.noPnl.toFixed(3)}`)
}