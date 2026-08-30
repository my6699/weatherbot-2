// 一次性修正脚本：把已结算（settled）且已平仓（closedAt 非空）的记录，
// pnl 从"按结算价 0 计算"重算为"按平仓实现价计算"（08-12 补结算逻辑修正前错算的 8 笔）。
import fs from 'node:fs';

const dir = 'data';
let fixed = 0;
for (const f of fs.readdirSync(dir).filter((x) => /^trades-.*\.json$/.test(x))) {
  const arr = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  let changed = false;
  for (const t of arr) {
    if (t.status === 'settled' && t.closedAt && !t.switched && t.exitPrice !== null) {
      const oldPnl = t.pnl;
      if (t.buckets.length >= 2 && t.exitPriceA !== null && t.exitPriceB !== null) {
        const half = t.sizeUsd / 2;
        t.pnl =
          Math.round(
            (half * (t.exitPriceA - t.entryPriceA) +
              half * (t.exitPriceB - t.entryPriceB)) * 100,
          ) / 100;
        t.hit = t.exitPriceA > 0.5 || t.exitPriceB > 0.5;
      } else {
        t.pnl = Math.round(t.sizeUsd * (t.exitPrice - t.entryPrice) * 100) / 100;
        t.hit = t.exitPrice > 0.5;
      }
      console.log('fix', f, t.id, 'pnl', oldPnl, '->', t.pnl);
      changed = true;
      fixed += 1;
    }
  }
  if (changed) {
    fs.writeFileSync(`${dir}/${f}`, JSON.stringify(arr, null, 2), 'utf8');
  }
}
console.log('fixed total:', fixed);
