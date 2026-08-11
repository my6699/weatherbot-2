// 一次性审计脚本：检查服务器 paper 盘所有持仓的异常情况。
// 用法：node scripts/audit-paper.mjs
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), 'data');
const files = fs.readdirSync(dir).filter((f) => f.startsWith('trades-') && f.endsWith('.json'));
const all = [];
for (const f of files) {
  const city = f.replace('trades-', '').replace('.json', '');
  const trades = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const t of trades) {
    all.push({ city, ...t });
  }
}

const open = all.filter((t) => t.status === 'open');
const settled = all.filter((t) => t.status === 'settled');
const closed = all.filter((t) => t.status === 'closed');

console.log('========== 持仓总量 ==========');
console.log(`总记录 ${all.length}：open=${open.length} settled=${settled.length} closed=${closed.length}`);

console.log('\n========== 异常检测 ==========');
const anomalies = [];

// 1. 无 targetDate 的 open
for (const t of open) {
  if (!t.targetDate) anomalies.push(`无 targetDate: ${t.city} ${t.id}`);
}
// 2. 开放桶
for (const t of open) {
  for (const b of t.buckets || []) {
    if (b.startsWith('<=') || b.startsWith('>=')) anomalies.push(`开放桶持仓: ${t.city} ${t.id} ${b} cost=${t.entryPrice}`);
  }
}
// 3. 成本异常（<0.05）
for (const t of open) {
  if (t.entryPrice < 0.05) anomalies.push(`成本异常(<0.05): ${t.city} ${t.id} ${(t.buckets || []).join('+')} cost=${t.entryPrice}`);
}
// 4. 同城市同目标日多笔 open（重复开仓）
const seen = new Map();
for (const t of open) {
  const key = `${t.city}|${t.targetDate}`;
  seen.set(key, (seen.get(key) || 0) + 1);
}
for (const [key, n] of seen) {
  if (n > 1) anomalies.push(`重复开仓 x${n}: ${key}`);
}
// 5. 已过目标日仍 open（该结算未结算）
const today = new Date().toISOString().slice(0, 10);
for (const t of open) {
  if (t.targetDate && t.targetDate < today) {
    anomalies.push(`超期未结算: ${t.city} ${t.id} target=${t.targetDate} 今日=${today}`);
  }
}

if (anomalies.length === 0) {
  console.log('无异常 ✓');
} else {
  for (const a of anomalies) console.log(`⚠️ ${a}`);
}

console.log('\n========== open 持仓明细 ==========');
const rows = open.map((t) => ({
  city: t.city,
  buckets: (t.buckets || []).join('+'),
  entry: t.entryPrice,
  size: t.sizeUsd,
  target: t.targetDate || '-',
  switched: t.switched ? 'Y' : '-',
  switchTo: t.switchKeys ? t.switchKeys.join('+') : '',
}));
rows.sort((a, b) => (a.target || '').localeCompare(b.target || '') || a.city.localeCompare(b.city));
console.table(rows);

// 成本/浮盈（正常单，剔除成本异常）
console.log('\n========== 成本与目标日分布 ==========');
const costTotal = open.filter((t) => t.entryPrice >= 0.05).reduce((s, t) => s + t.sizeUsd, 0);
const costAnomaly = open.filter((t) => t.entryPrice < 0.05).reduce((s, t) => s + t.sizeUsd, 0);
console.log(`正常单成本合计 $${costTotal.toFixed(2)}（${open.filter((t) => t.entryPrice >= 0.05).length} 笔）`);
console.log(`异常单成本合计 $${costAnomaly.toFixed(2)}（${open.filter((t) => t.entryPrice < 0.05).length} 笔，未计入）`);

const byTarget = new Map();
for (const t of open) byTarget.set(t.targetDate || '?', (byTarget.get(t.targetDate || '?') || 0) + 1);
console.log('目标日分布:', [...byTarget.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}:${v}笔`).join('  '));
