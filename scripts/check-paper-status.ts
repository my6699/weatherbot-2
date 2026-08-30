// 检查模拟交易状态
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CITIES = [
  'shanghai','tel-aviv','wellington','tokyo','paris','london','munich',
  'ankara','singapore','lucknow','seoul','nyc','chicago','miami','dallas',
  'seattle','atlanta','toronto','sao-paulo','buenos-aires'
];

interface Trade {
  status?: string;
  settled?: boolean;
  pnl?: number;
  realizedPnl?: number;
  entryPrice?: number;
  sizeUsd?: number;
  bucket?: string;
  buckets?: string[];
  targetDate?: string;
  openedAt?: string;
  closedAt?: string;
  entryPriceD2?: number;
  makerFirst?: any;
  reason?: string;
  [key: string]: any;
}

let totalAll = 0, totalOpen = 0, totalSettled = 0, totalPnl = 0;

for (const city of CITIES) {
  const fp = path.join(DATA_DIR, `trades-${city}.json`);
  if (!fs.existsSync(fp)) continue;

  const trades: Trade[] = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  if (trades.length === 0) continue;

  const open = trades.filter(t => t.status === 'open').length;
  const settled = trades.filter(t => t.status === 'settled' || t.settled).length;
  const cityPnl = trades
    .filter(t => t.status === 'settled' || t.settled)
    .reduce((s, t) => s + (t.pnl || t.realizedPnl || 0), 0);

  totalAll += trades.length;
  totalOpen += open;
  totalSettled += settled;
  totalPnl += cityPnl;

  console.log(`${city}: ${trades.length}笔  open=${open} settled=${settled} pnl=$${cityPnl.toFixed(2)}`);
}

console.log(`\n合计: ${totalAll}笔`);
console.log(`  持有中: ${totalOpen}笔`);
console.log(`  已结算: ${totalSettled}笔`);
console.log(`  总盈亏: $${totalPnl.toFixed(2)}`);

// 查看最近的开仓详情
console.log('\n=== 最近开仓（取前 10 笔持有中的） ===');
for (const city of CITIES) {
  const fp = path.join(DATA_DIR, `trades-${city}.json`);
  if (!fs.existsSync(fp)) continue;
  const trades: Trade[] = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  const openTrades = trades.filter(t => t.status === 'open').reverse();
  for (const t of openTrades) {
    const buckets = t.buckets?.join('+') || t.bucket || '?';
    const entry = t.entryPrice || t.entryPriceD2 || 0;
    const size = t.sizeUsd || 0;
    const date = t.targetDate || '?';
    const makerTag = t.makerFirst ? ' [Maker]' : '';
    const openedAt = t.openedAt ? new Date(t.openedAt).toISOString().slice(0, 19) : '?';
    console.log(`  ${city} ${date} ${buckets} entry=$${entry.toFixed(3)} size=$${size.toFixed(0)} ${openedAt}${makerTag}`);
  }
}