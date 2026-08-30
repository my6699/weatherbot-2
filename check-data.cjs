// 检查 VPS 同步回来的数据：wellington 重复开循环、sao-paulo 旧大单、其他异常
const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, 'data');

console.log('=== WELLINGTON ===');
const wellington = JSON.parse(fs.readFileSync(path.join(BASE, 'trades-wellington.json'), 'utf8'));
const byDate = {};
wellington.forEach(r => {
  byDate[r.targetDate] = (byDate[r.targetDate] || 0) + 1;
});
console.log('按 targetDate 统计:', JSON.stringify(byDate, null, 1));
const last8 = wellington.slice(-8).map(r => ({
  id: r.id,
  td: r.targetDate,
  b: r.buckets,
  st: r.status,
  at: r.openedAt ? r.openedAt.slice(0, 16) : null,
  ct: r.closedAt ? r.closedAt.slice(0, 16) : null,
  pnl: r.pnl,
  reason: r.reason
}));
console.log('最近 8 条:', JSON.stringify(last8, null, 1));

console.log('=== SAO-PAULO ===');
const sao = JSON.parse(fs.readFileSync(path.join(BASE, 'trades-sao-paulo.json'), 'utf8'));
console.log('总数:', sao.length);
const saoByDate = {};
sao.forEach(r => {
  saoByDate[r.targetDate] = (saoByDate[r.targetDate] || 0) + 1;
});
console.log('按 targetDate 统计:', JSON.stringify(saoByDate, null, 1));
const saoLarge = sao.filter(r => r.sizeUsd > 10);
console.log('大单 (>10):', saoLarge.length);
saoLarge.forEach(r => ({
  id: r.id,
  td: r.targetDate,
  b: r.buckets,
  bnds: r.bucketBounds,
  sz: r.sizeUsd,
  st: r.status,
  at: r.openedAt ? r.openedAt.slice(0, 16) : null,
  pnl: r.pnl,
}));

console.log('=== 全量统计 ===');
const cities = fs.readdirSync(BASE).filter(f => /^trades-.+\.json$/.test(f));
cities.forEach(city => {
  const t = JSON.parse(fs.readFileSync(path.join(BASE, city), 'utf8'));
  const bySt = { open: 0, closed: 0, settled: 0 };
  t.forEach(r => {
    bySt[r.status] = (bySt[r.status] || 0) + 1;
  });
  const pnl = t.reduce((sum, r) => sum + (r.pnl || 0), 0);
  console.log(`${city}: 总数=${t.length}, open=${bySt.open}, closed=${bySt.closed}, settled=${bySt.settled}, pnl=${pnl}`);
});
