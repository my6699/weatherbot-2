// 审计：所有提前平仓（非结算）交易的盈亏分布——回答"提前平仓的各个交易没有盈利的？"
import fs from 'node:fs';
import path from 'node:path';
import { ALL_CITIES } from '../src/common/types.js';

interface TradeRecord {
  city: string;
  status: string;
  targetDate?: string;
  buckets?: string[];
  entryPrice?: number;
  switchBuy?: number;
  exitPrice?: number;
  exitReason?: string;
  closedAt?: string;
  sizeUsd?: number;
  pnl?: number | null;
  settledAt?: string;
}

const rows: Array<{ city: string; targetDate: string; buckets: string; cost: number; exitPrice: number; pnl: number; reason: string }> = [];
const summaries: Record<string, { early: { win: number; lose: number; pnl: number }; settle: { win: number; lose: number; pnl: number } }> = {};

for (const city of ALL_CITIES) {
  const file = path.join('data', `trades-${city}.json`);
  if (!fs.existsSync(file)) continue;
  const trades = JSON.parse(fs.readFileSync(file, 'utf8')) as TradeRecord[];
  summaries[city] = { early: { win: 0, lose: 0, pnl: 0 }, settle: { win: 0, lose: 0, pnl: 0 } };
  for (const t of trades) {
    if (t.status !== 'closed') continue;
    const cost = t.switchBuy ?? t.entryPrice ?? 0;
    const exit = t.exitPrice ?? 0;
    const pnl = (exit - cost) * (t.sizeUsd ?? 0);
    const isSettle = (t.exitReason ?? '').includes('settle') || exit >= 0.99 || exit <= 0.01;
    const key = isSettle ? 'settle' : 'early';
    const s = summaries[city][key];
    if (pnl >= 0) s.win += 1; else s.lose += 1;
    s.pnl += pnl;
    if (!isSettle) {
      rows.push({
        city,
        targetDate: t.targetDate ?? '',
        buckets: (t.buckets ?? []).join('+'),
        cost,
        exitPrice: exit,
        pnl,
        reason: t.exitReason ?? '',
      });
    }
  }
}

let earlyWin = 0, earlyLose = 0, earlyPnl = 0, settleWin = 0, settleLose = 0, settlePnl = 0;
for (const city of Object.keys(summaries)) {
  const s = summaries[city];
  earlyWin += s.early.win; earlyLose += s.early.lose; earlyPnl += s.early.pnl;
  settleWin += s.settle.win; settleLose += s.settle.lose; settlePnl += s.settle.pnl;
}

console.log('===== 提前平仓（非结算）逐笔明细 =====');
for (const r of rows.sort((a, b) => a.pnl - b.pnl)) {
  console.log(`${r.pnl >= 0 ? '🟢' : '🔴'} ${r.city} ${r.targetDate} [${r.buckets}] 成本 ${r.cost.toFixed(3)} 平仓价 ${r.exitPrice.toFixed(3)} 盈亏 $${r.pnl.toFixed(2)} 原因: ${r.reason}`);
}
console.log('\n===== 汇总 =====');
console.log(`提前平仓: ${earlyWin} 笔盈利 / ${earlyLose} 笔亏损, 合计 $${earlyPnl.toFixed(2)}`);
console.log(`结算出场: ${settleWin} 笔盈利 / ${settleLose} 笔亏损, 合计 $${settlePnl.toFixed(2)}`);
