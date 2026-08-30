import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || path.join(process.cwd(), 'data');
const files = fs.readdirSync(dir).filter((f) => /^trades-.+\.json$/.test(f));

const settled = [];
const open = [];

for (const f of files) {
  const city = f.replace('trades-', '').replace('.json', '');
  const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const t of arr) {
    t._city = city;
    if (t.status === 'open') open.push(t);
    else settled.push(t);
  }
}

const hit = settled.filter((t) => t.hit);
const pnl = settled.reduce((s, t) => s + (t.pnl || 0), 0);
const gross = settled.reduce((s, t) => s + (t.sizeUsd || 0), 0);
const roi = gross > 0 ? (pnl / gross) * 100 : 0;
const wins = settled.filter((t) => (t.pnl || 0) > 0);
const losses = settled.filter((t) => (t.pnl || 0) < 0);

console.log('\n============================================');
console.log('         完 整 交 易 报 告');
console.log('============================================');
console.log(`数据源: ${dir}`);
console.log(`城市数: ${files.length}`);
console.log(`总交易: ${settled.length + open.length}`);
console.log(`已结算: ${settled.length} | 持仓中: ${open.length}`);
console.log(`命中: ${hit.length}/${settled.length} (${((hit.length/settled.length)*100).toFixed(1)}%)`);
console.log(`盈利: ${wins.length} | 亏损: ${losses.length} | 平: ${settled.length - wins.length - losses.length}`);
console.log(`总盈亏: $${pnl.toFixed(3)}`);
console.log(`总投入: $${gross.toFixed(3)}`);
console.log(`ROI: ${roi.toFixed(2)}%`);

console.log('\n----- 分城市盈亏 -----');
const byCity = {};
for (const t of settled) {
  byCity[t._city] = byCity[t._city] || { n: 0, hit: 0, pnl: 0, gross: 0 };
  byCity[t._city].n++;
  if (t.hit) byCity[t._city].hit++;
  byCity[t._city].pnl += t.pnl || 0;
  byCity[t._city].gross += t.sizeUsd || 0;
}
const sorted = Object.entries(byCity).sort((a, b) => b[1].pnl - a[1].pnl);
for (const [c, v] of sorted) {
  const r = v.gross > 0 ? (v.pnl / v.gross) * 100 : 0;
  const sign = v.pnl >= 0 ? '+' : '';
  console.log(`  ${c.padEnd(13)} n=${String(v.n).padStart(2)} hit=${v.hit}/${v.n} 盈亏=${sign}$${v.pnl.toFixed(3).padStart(8)}  ROI=${r.toFixed(1)}%`);
}

console.log('\n----- 当前持仓 -----');
if (open.length) {
  for (const t of open) {
    console.log(`  ${t._city.padEnd(13)} ${(t.bucketLabel||'').padEnd(9)} target=${t.targetDate} entry=$${(t.entryPrice||0).toFixed(3)} size=$${(t.sizeUsd||0).toFixed(2)} id=${t.id.slice(0,20)}`);
  }
} else {
  console.log('  (无持仓)');
}

console.log('\n============================================');