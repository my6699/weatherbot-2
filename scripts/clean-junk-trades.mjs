// 一次性清理脚本：把 status=open 但没有 targetDate 的无效持仓标记为 closed。
// 这类持仓无法被监控/结算/防重，属于历史版本异常写入，必须清理。
// 用法：node scripts/clean-junk-trades.mjs
import fs from 'node:fs';

let cleaned = 0;
for (const f of fs.readdirSync('data').filter((x) => /^trades-.*\.json$/.test(x))) {
  const p = `data/${f}`;
  const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
  let changed = false;
  for (const t of arr) {
    if (t.status === 'open' && !t.targetDate) {
      t.status = 'closed';
      t.closedAt = t.closedAt ?? new Date().toISOString();
      t.exitPrice = t.exitPrice ?? t.entryPrice;
      t.exitPriceA = t.exitPriceA ?? t.entryPriceA;
      t.exitPriceB = t.exitPriceB ?? t.entryPriceB;
      t.reason = `${t.reason ?? ''} | 清理：无目标日期，无法监控/结算`;
      cleaned++;
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(p, JSON.stringify(arr, null, 2), 'utf8');
}
console.log(`已清理 ${cleaned} 笔无目标日期的无效持仓`);
