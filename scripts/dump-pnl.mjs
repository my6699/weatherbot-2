// 一次性汇总：trades 里所有 settled 记录的 pnl（企业微信报告"累计盈亏"来源）。
import fs from 'node:fs';

let pnlSum = 0, settledN = 0, openN = 0, closedN = 0;
const samples = [];
for (const f of fs.readdirSync('data').filter((x) => /^trades-.*\.json$/.test(x))) {
  const arr = JSON.parse(fs.readFileSync(`data/${f}`, 'utf8'));
  for (const t of arr) {
    if (t.status === 'settled') {
      settledN++;
      if (t.pnl !== null && t.pnl !== undefined) {
        pnlSum += t.pnl;
        samples.push({
          city: f.replace('trades-', '').replace('.json', ''),
          hit: t.hit,
          pnl: t.pnl,
          sw: t.switched,
          buckets: t.buckets,
          entry: t.entryPrice,
          swSell: t.switchSell,
          swBuy: t.switchBuy,
          settledAt: t.settledAt,
        });
      }
    }
    if (t.status === 'open') openN++;
    if (t.status === 'closed') closedN++;
  }
}
console.log(`open=${openN} closed=${closedN} settled=${settledN} pnlSum=${pnlSum.toFixed(2)}`);
console.log(JSON.stringify(samples, null, 1));
