// 全量模拟盘交易汇总脚本：读取 data/trades-*.json，输出每笔交易明细。
// 用法：node scripts/trade-summary.mjs
import fs from 'node:fs';
import path from 'node:path';

const CITY_CN = {
  shanghai: '上海', nyc: '纽约', chicago: '芝加哥', miami: '迈阿密', dallas: '达拉斯',
  seattle: '西雅图', atlanta: '亚特兰大', london: '伦敦', paris: '巴黎', munich: '慕尼黑',
  ankara: '安卡拉', seoul: '首尔', tokyo: '东京', singapore: '新加坡', lucknow: '勒克瑙',
  'tel-aviv': '特拉维夫', toronto: '多伦多', 'sao-paulo': '圣保罗', 'buenos-aires': '布宜诺斯艾利斯',
  wellington: '惠灵顿',
};

function cn(city) {
  return CITY_CN[city] ?? city;
}

function bj(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

function horizonOf(t) {
  if (!t.openedAt || !t.targetDate) return '?';
  const diff = Math.round(
    (new Date(`${t.targetDate}T00:00:00Z`) - new Date(t.openedAt)) / 86400000,
  );
  return `D-${diff}`;
}

const files = fs.readdirSync('data').filter((f) => /^trades-.*\.json$/.test(f));
const all = [];
for (const f of files) {
  const city = f.replace('trades-', '').replace('.json', '');
  const arr = JSON.parse(fs.readFileSync(path.join('data', f), 'utf8'));
  for (const t of arr) all.push({ ...t, city });
}
all.sort((a, b) => (a.openedAt < b.openedAt ? -1 : 1));

const open = all.filter((t) => t.status === 'open');
const settled = all.filter((t) => t.status !== 'open');

console.log('================ 未结算持仓（open） ================');
for (const t of open) {
  const buckets = t.switched && t.switchKeys?.length ? t.switchKeys.join('+') : t.buckets.join('+');
  const sw = t.switched ? `  [换仓:${t.switchSell?.toFixed(2)}→${t.switchBuy?.toFixed(2)} @${bj(t.switchAt)}]` : '';
  console.log(
    `[${cn(t.city)}] ${t.id.slice(-8)} | ${t.horizon} 开仓 ${bj(t.openedAt)} | 桶 ${buckets} | 成本 ${t.entryPrice.toFixed(2)} | 资金 $${t.sizeUsd} | 目标 ${t.targetDate}${sw}`,
  );
}
console.log(`未结算持仓合计：${open.length} 笔，成本 $${open.reduce((s, t) => s + t.sizeUsd, 0).toFixed(2)}`);
console.log('');

console.log('================ 已结算/已平仓 ================');
let hitN = 0, missN = 0, pnlSum = 0, hasPnl = 0;
for (const t of settled) {
  const buckets = t.switched && t.switchKeys?.length ? `(换:${t.switchKeys.join('+')})` : '';
  const hit = t.hit === true ? '命中' : t.hit === false ? '未中' : '未定';
  const pnl = t.pnl !== null && t.pnl !== undefined ? ` pnl ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}` : '';
  if (t.hit === true) hitN++;
  if (t.hit === false) missN++;
  if (t.pnl !== null && t.pnl !== undefined) { pnlSum += t.pnl; hasPnl++; }
  console.log(
    `[${cn(t.city)}] ${t.id.slice(-8)} | ${t.horizon} 开 ${bj(t.openedAt)} | 桶 ${t.buckets.join('+')} ${buckets} | 成本 ${t.entryPrice.toFixed(2)} | ${hit}${pnl} | ${t.reason ?? ''}`,
  );
}
console.log(`已结算/已平仓：${settled.length} 笔（命中 ${hitN} / 未中 ${missN} / 未定 ${settled.length - hitN - missN}）`);
console.log(`有盈亏 ${hasPnl} 笔，盈亏合计 ${pnlSum >= 0 ? '+' : ''}${pnlSum.toFixed(2)}`);
