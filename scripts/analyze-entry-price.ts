// 分析入场价分布，找出最优的 MAX_ENTRY_COST 阈值
import fs from 'node:fs';

const csvPath = 'data/backtest/backtest-detail_2026-08-17T08-03-26.csv';
const csv = fs.readFileSync(csvPath, 'utf8');
const lines = csv.trim().split('\n').slice(1).filter(l => l.includes('price-history'));
const trades = lines.map(l => {
  const f = l.split(',');
  return { city: f[1], date: f[2], entry: parseFloat(f[4]), result: f[9], pnl: parseFloat(f[11]) };
});

console.log('=== 69 笔实际成交的入场价分布 ===');
const prices = trades.map(t => t.entry).sort((a, b) => a - b);
console.log(`最低: $${prices[0].toFixed(3)}`);
console.log(`最高: $${prices[prices.length - 1].toFixed(3)}`);
console.log(`中位数: $${prices[Math.floor(prices.length / 2)].toFixed(3)}`);
console.log(`平均: $${(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(3)}`);

console.log('\n入场价分布表:');
console.log('区间'.padEnd(12), '笔数'.padEnd(8), '胜率'.padEnd(8), '总盈亏'.padEnd(12), '单笔盈亏');
const bins = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
bins.forEach((b, i) => {
  const lower = i === 0 ? 0 : bins[i - 1];
  const t = trades.filter(t => t.entry > lower && t.entry <= b);
  if (t.length === 0) return;
  const wins = t.filter(x => x.result === '命中').length;
  const totalPnl = t.reduce((s, x) => s + x.pnl, 0);
  console.log(`$${lower.toFixed(1)}-$${b.toFixed(1)}`.padEnd(12), `${t.length}笔`.padEnd(8), `${(wins / t.length * 100).toFixed(0)}%`.padEnd(8), `$${totalPnl.toFixed(2)}`.padEnd(12), `$${(totalPnl / t.length).toFixed(3)}`);
});

console.log('\n=== 不同 MAX_ENTRY_COST 的效果 ===');
console.log('阈值'.padEnd(12), '笔数'.padEnd(8), '保留率'.padEnd(10), '胜率'.padEnd(8), '总盈亏'.padEnd(12), '单笔盈亏'.padEnd(12), '相对当前');
[0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65].forEach(cap => {
  const filtered = trades.filter(t => t.entry <= cap);
  const wins = filtered.filter(x => x.result === '命中').length;
  const totalPnl = filtered.reduce((s, x) => s + x.pnl, 0);
  const avgPnl = totalPnl / filtered.length;
  const currentTotal = trades.reduce((s, x) => s + x.pnl, 0);
  const ratio = totalPnl / currentTotal;
  console.log(`$${cap.toFixed(2)}`.padEnd(12), `${filtered.length}笔`.padEnd(8), `${(filtered.length / trades.length * 100).toFixed(0)}%`.padEnd(10), `${(wins / filtered.length * 100).toFixed(0)}%`.padEnd(8), `$${totalPnl.toFixed(2)}`.padEnd(12), `$${avgPnl.toFixed(3)}`.padEnd(12), `${(ratio * 100).toFixed(0)}%`);
});

console.log('\n=== 高入场价 (>= 0.55) 的交易 ===');
const expensive = trades.filter(t => t.entry >= 0.55);
expensive.forEach(t => {
  console.log(`  ${t.city} ${t.date} 入场$${t.entry.toFixed(3)} ${t.result} 盈亏$${t.pnl.toFixed(3)}`);
});
const expWins = expensive.filter(x => x.result === '命中').length;
const expTotal = expensive.reduce((s, x) => s + x.pnl, 0);
console.log(`\n  高入场价合计: ${expensive.length}笔, 胜率${(expWins / expensive.length * 100).toFixed(0)}%, 总盈亏$${expTotal.toFixed(2)}`);

console.log('\n=== 低入场价 (< 0.40) 的交易 ===');
const cheap = trades.filter(t => t.entry < 0.40);
cheap.forEach(t => {
  console.log(`  ${t.city} ${t.date} 入场$${t.entry.toFixed(3)} ${t.result} 盈亏$${t.pnl.toFixed(3)}`);
});
const cheapWins = cheap.filter(x => x.result === '命中').length;
const cheapTotal = cheap.reduce((s, x) => s + x.pnl, 0);
console.log(`\n  低入场价合计: ${cheap.length}笔, 胜率${(cheapWins / cheap.length * 100).toFixed(0)}%, 总盈亏$${cheapTotal.toFixed(2)}`);