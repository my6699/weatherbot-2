// 一次性标记脚本：给历史已结算记录打 viaSettleBackfill: true，并按新口径重算 hit。
// 背景：08-12 修复前，settled 记录全部由补结算机制（settleDuePositions）补记
// （失联持仓/平仓后补记），非正常监控路径结算 → 统一打标，统计报告区分。
// hit 新口径：提前平仓的记录命中 = 实际盈利（pnl>0），不再用 exitPrice>0.5。
import fs from 'node:fs';

const dir = 'data';
let marked = 0;
let hitFixed = 0;
for (const f of fs.readdirSync(dir).filter((x) => /^trades-.*\.json$/.test(x))) {
  const arr = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  let changed = false;
  for (const t of arr) {
    if (t.status === 'settled' && !t.viaSettleBackfill) {
      t.viaSettleBackfill = true;
      changed = true;
      marked += 1;
    }
    if (t.status === 'settled' && t.closedAt && t.pnl !== null) {
      const newHit = t.pnl > 0;
      if (t.hit !== newHit) {
        t.hit = newHit;
        changed = true;
        hitFixed += 1;
      }
    }
  }
  if (changed) {
    fs.writeFileSync(`${dir}/${f}`, JSON.stringify(arr, null, 2), 'utf8');
    console.log('update', f);
  }
}
console.log('marked total:', marked, 'hitFixed:', hitFixed);
