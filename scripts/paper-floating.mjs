// 一次性脚本：paper 盘浮盈 + 平仓记录分析。
// 用法：node scripts/paper-floating.mjs
import fs from 'node:fs';
import path from 'node:path';
import { PolymarketClient } from '../src/utils/polymarket-client.js';

const dir = path.join(process.cwd(), 'data');
const files = fs.readdirSync(dir).filter((f) => f.startsWith('trades-') && f.endsWith('.json'));
const all = [];
for (const f of files) {
  const city = f.replace('trades-', '').replace('.json', '');
  const trades = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const t of trades) all.push({ city, ...t });
}

const open = all.filter((t) => t.status === 'open');
const closed = all.filter((t) => t.status === 'closed');
const client = new PolymarketClient();

// 桶 label → 实时 bid（label 摄氏，market 华氏/摄氏统一转摄氏按温度差匹配）
function matchBid(markets, label) {
  const isOpenLow = label.startsWith('<=');
  const isOpenHigh = label.startsWith('>=');
  const numC = Number(label.replace(/[^\d.-]/g, ''));
  let best = null, bestD = Infinity;
  for (const m of markets) {
    const q = m.question ?? '';
    const mm = q.match(/(\d+)\s*°([CF])/);
    if (!mm) continue;
    const isF = mm[2] === 'F';
    const tempC = isF ? ((Number(mm[1]) - 32) * 5) / 9 : Number(mm[1]);
    const isLow = /or below/i.test(q);
    const isHigh = /or higher/i.test(q);
    if (isOpenLow && isLow) return Number(m.bestBid) || 0;
    if (isOpenHigh && isHigh) return Number(m.bestBid) || 0;
    if (isOpenLow || isOpenHigh) continue;
    const d = Math.abs(tempC - numC);
    if (d < bestD) { bestD = d; best = m; }
  }
  if (!best || bestD > 2) return null;
  return Number(best.bestBid) || 0;
}

const rows = [];
for (const t of open) {
  const buckets = t.switched && t.switchKeys?.length ? t.switchKeys : (t.buckets || []);
  const cost = t.switched && t.switchBuy ? t.switchBuy : t.entryPrice; // 换仓后成本
  let sumBid = null;
  try {
    if (t.targetDate) {
      const [y, m, d] = t.targetDate.split('-').map(Number);
      const event = await client.findEventBySlug(t.city, y, m, d);
      if (event) {
        const bids = buckets.map((b) => matchBid(event.markets ?? [], b)).filter((b) => b !== null && b > 0);
        if (bids.length === buckets.length) sumBid = bids.reduce((a, b) => a + b, 0);
      }
    }
  } catch { sumBid = null; }
  const value = sumBid !== null && cost > 0 ? (t.sizeUsd * sumBid) / cost : null;
  rows.push({
    city: t.city, buckets: buckets.join('+'), cost: +cost.toFixed(3),
    sumBid: sumBid !== null ? +sumBid.toFixed(3) : null, value: value !== null ? +value.toFixed(1) : null,
    target: t.targetDate, switched: t.switched ? 'Y' : '',
  });
}
rows.sort((a, b) => (a.target || '').localeCompare(b.target || '') || a.city.localeCompare(b.city));
console.log('========== open 持仓浮盈明细 ==========');
console.table(rows);

const costTotal = rows.reduce((s, r) => s + r.cost * (r.cost >= 0.05 ? 20 / 20 : 1), 0); // 近似
const normal = rows.filter((r) => r.cost >= 0.05);
const costN = normal.reduce((s, r) => s + 20, 0);
const valueN = normal.reduce((s, r) => s + (r.value ?? 0), 0);
console.log(`正常单（${normal.length} 笔）：成本 $${costN.toFixed(2)}  市值 $${valueN.toFixed(2)}  浮盈 ${(valueN - costN) >= 0 ? '+' : ''}$${(valueN - costN).toFixed(2)}（${costN > 0 ? ((valueN - costN) / costN * 100).toFixed(1) : 0}%）`);

console.log('\n========== 平仓记录分析 ==========');
const exitClosed = closed.filter((t) => t.exitPrice !== null && t.exitPrice > 0);
const zeroClosed = closed.filter((t) => t.exitPrice === null || t.exitPrice === 0);
console.log(`closed 总数 ${closed.length}：有离场价 ${exitClosed.length} 笔，无离场价(0/清理) ${zeroClosed.length} 笔`);
for (const t of exitClosed) {
  console.log(`  离场: ${t.city} ${(t.buckets || []).join('+')} 成本=${t.entryPrice} 离场价=${t.exitPrice} target=${t.targetDate} reason=${(t.reason || '').slice(0, 40)}`);
}
// 换仓记录
const switchedAll = all.filter((t) => t.switched);
console.log(`\n换仓记录（open+closed）共 ${switchedAll.length} 笔:`);
for (const t of switchedAll) {
  console.log(`  换仓: ${t.city} ${(t.buckets || []).join('+')}→${(t.switchKeys || []).join('+')} 卖=${t.switchSell} 买=${t.switchBuy} @${t.switchAt?.slice(0, 16) || '?'} 状态=${t.status}`);
}
