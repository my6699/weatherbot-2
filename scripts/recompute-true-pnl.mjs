// 临时核对脚本：重算所有已结算/已平仓交易的真实已实现盈亏。
// 正确口径（对齐 recordSettleTrade switched 分支 / 回测 SWITCH_D1）：
//   - 换仓过：sizeUsd*(switchSell - entryPrice) + sizeUsd*(离场/结算价 - switchBuy)
//   - 未换仓双桶：两桶各半仓按各自离场/结算价
//   - 未换仓单桶：sizeUsd*(离场/结算价 - entryPrice)
import fs from 'node:fs';

const files = fs.readdirSync('data').filter((f) => /^trades-.*\.json$/.test(f));
let all = [];
for (const f of files) all.push(...JSON.parse(fs.readFileSync('data/' + f, 'utf8')));

function truePnl(t) {
  if (t.status !== 'settled' && t.status !== 'closed') return null;
  const hasExit = t.exitPrice !== null && t.exitPrice !== undefined;
  // 换仓：旧桶段在 switchSell 已实现；新桶段按离场(exit)或结算(settleNew)价
  if (t.switched && t.switchSell !== undefined && t.switchBuy !== undefined) {
    const sellRef = t.switchSell;
    const buyRef = t.switchBuy;
    let newLeg;
    if (hasExit) {
      newLeg = t.sizeUsd * (t.exitPrice - buyRef);
    } else {
      const settleNew =
        t.switchKeys && t.switchKeys.length >= 2 && t.settlementPriceB !== undefined
          ? (t.settlementPrice + t.settlementPriceB) / 2
          : t.settlementPrice;
      newLeg = t.sizeUsd * (settleNew - buyRef);
    }
    return t.sizeUsd * (sellRef - t.entryPrice) + newLeg;
  }
  // 未换仓双桶
  if (t.buckets.length >= 2) {
    const half = t.sizeUsd / 2;
    if (hasExit) {
      return half * (t.exitPriceA - t.entryPriceA) + half * (t.exitPriceB - t.entryPriceB);
    }
    return half * (t.settlementPrice - t.entryPriceA) + half * ((t.settlementPriceB ?? 0) - t.entryPriceB);
  }
  // 未换仓单桶
  if (hasExit) return t.sizeUsd * (t.exitPrice - t.entryPrice);
  return t.sizeUsd * (t.settlementPrice - t.entryPrice);
}

let total = 0;
let n = 0;
let diff = 0;
for (const t of all) {
  const p = truePnl(t);
  if (p === null) continue;
  n++;
  total += p;
  if (t.pnl !== null && t.pnl !== undefined && Math.abs(p - t.pnl) > 0.005) {
    diff++;
    console.log(
      `[存储有误] ${t.city} ${t.targetDate ?? ''} ${(t.buckets || []).join('+')}${t.switched ? ' -> ' + (t.switchKeys || []).join('+') : ''} | stored ${t.pnl.toFixed(2)} | 正确 ${p.toFixed(2)}`,
    );
  }
}
console.log('---');
console.log(`重算样本 ${n} 笔, 真实累计已实现盈亏 = $${total.toFixed(2)}, 其中 ${diff} 笔存储值与正确值有差异`);
