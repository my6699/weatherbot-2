// 探查 price-history 数据结构 + 亏损单平仓时间
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join('data', 'price-history');
console.log('=== price-history 目录 ===');
if (fs.existsSync(dir)) {
  const files = fs.readdirSync(dir).slice(0, 10);
  console.log(`文件总数: ${fs.readdirSync(dir).length}, 前 10 个:`);
  for (const f of files) console.log(`  ${f}`);
  const first = fs.readdirSync(dir)[0];
  if (first) {
    console.log(`\n=== 样本文件 ${first} ===`);
    const raw = fs.readFileSync(path.join(dir, first), 'utf8');
    console.log(`大小 ${raw.length} 字符`);
    console.log(raw.slice(0, 900));
  }
} else {
  console.log('不存在');
}

// 14 笔亏损单对应城市 + closedAt
const cities = ['lucknow', 'toronto', 'paris', 'nyc', 'seattle', 'tel-aviv', 'ankara', 'sao-paulo', 'london', 'tokyo', 'singapore', 'atlanta', 'wellington', 'chicago'];
console.log('\n=== 各城市 trades 中 closed 记录的 closedAt ===');
for (const city of cities) {
  const file = path.join('data', `trades-${city}.json`);
  if (!fs.existsSync(file)) continue;
  const trades = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
  const closed = trades.filter((t) => t.status === 'closed');
  for (const t of closed) {
    const exit = t.exitPrice as number;
    if ((exit ?? 0) > 0.01 && (exit ?? 0) < 0.99) {
      console.log(
        `${city} 目标 ${t.targetDate} [${(t.buckets as string[]).join('+')}] 成本 ${t.switchBuy ?? t.entryPrice} 平仓价 ${exit} 于 ${t.closedAt} 原因 ${t.exitReason ?? '-'}`,
      );
    }
  }
}
