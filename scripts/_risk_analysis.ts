import fs from 'node:fs';
import path from 'node:path';

const file = path.join(
  process.cwd(),
  'data',
  'backtest',
  'backtest-detail_2026-08-15T04-58-02.csv',
);
const lines = fs
  .readFileSync(file, 'utf8')
  .trim()
  .split('\n')
  .slice(1);

interface Row {
  market: string;
  city: string;
  bucket: string;
  entryPrice: number;
  entryTs: string;
  result: string;
  exitPrice: number;
  profit: number;
}

const rows: Row[] = lines.map((l) => {
  const f = l.split(',');
  return {
    market: f[0],
    city: f[1],
    bucket: f[3],
    entryPrice: Number(f[4]),
    entryTs: f[6],
    result: f[9],
    exitPrice: f[10] === '' ? NaN : Number(f[10]),
    profit: f[11] === '' ? NaN : Number(f[11]),
  };
});

const settled = rows.filter((r) => !Number.isNaN(r.profit));
const losses = settled.filter((r) => r.profit < 0).sort((a, b) => a.profit - b.profit);
const wins = settled.filter((r) => r.profit > 0);

console.log('===== 风险指标（STOP_LOSS_K=0）=====');
console.log('已结算笔数:', settled.length);
console.log('盈利笔数:', wins.length, ' 亏损笔数:', losses.length, ' 盈亏平衡:', settled.filter(r=>r.profit===0).length);
console.log('盈利合计: $' + wins.reduce((s, r) => s + r.profit, 0).toFixed(3));
console.log('亏损合计: $' + losses.reduce((s, r) => s + r.profit, 0).toFixed(3));

console.log('\n===== 最大单笔亏损 Top5 =====');
for (const l of losses.slice(0, 5)) {
  console.log(`  ${l.market} [${l.city}] ${l.bucket} 入场=$${l.entryPrice.toFixed(3)} ${l.result} 盈亏=$${l.profit.toFixed(3)}`);
}

console.log('\n===== 按入场时间累计盈亏 + 最大回撤 =====');
const byTs = [...settled].sort((a, b) => (a.entryTs < b.entryTs ? -1 : 1));
let cum = 0;
let peak = 0;
let maxDrawdown = 0;
let ddFrom = '';
let ddTo = '';
let curPeakTs = '';
for (const r of byTs) {
  cum += r.profit;
  if (cum > peak) {
    peak = cum;
    curPeakTs = r.entryTs.slice(0, 10);
  }
  const dd = cum - peak;
  if (dd < maxDrawdown) {
    maxDrawdown = dd;
    ddFrom = curPeakTs;
    ddTo = r.entryTs.slice(0, 10);
  }
}
console.log('期末累计: $' + cum.toFixed(3));
console.log('最大回撤: $' + maxDrawdown.toFixed(3) + ' (从 ' + ddFrom + ' 到 ' + ddTo + ')');

console.log('\n===== 按城市盈亏 =====');
const byCity = new Map<string, number>();
for (const r of settled) byCity.set(r.city, (byCity.get(r.city) ?? 0) + r.profit);
for (const [c, p] of [...byCity.entries()].sort((a, b) => a[1] - b[1])) {
  console.log(`  ${c}: ${p >= 0 ? '+' : ''}$${p.toFixed(3)}`);
}