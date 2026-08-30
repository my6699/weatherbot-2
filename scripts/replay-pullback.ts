// 网格测试：见顶回落卖出，回落多少亏损最少。
// 数据：logs/combined.log 里全部已平仓持仓的 10 分钟 sumBid 序列（换仓单按 switchAt 截断轨迹，
//   成本=换仓买入价；普通单成本=entryPrice）。
// 规则 A（带门槛）：价格从持仓期峰值回落 >= PULLBACK 且仍 > 成本 → 卖出（锁定利润型）
// 规则 B（无门槛）：纯峰值回落 >= PULLBACK → 卖出（追踪止损型）
// 输出：PULLBACK 0.01→0.30 每档的总 PnL / Δ / 触发数，以及两种规则各自亏损最小的档位。
import fs from 'node:fs';
import path from 'node:path';
import { ALL_CITIES } from '../src/common/types.js';

const logFile = path.join('logs', 'combined.log');
const lines = fs.readFileSync(logFile, 'utf8').split('\n');

const seriesById = new Map<string, Array<{ t: number; sumBid: number }>>();
for (const line of lines) {
  if (!line.includes('"sumBid"')) continue;
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const id = obj.positionId as string | undefined;
    const sumBid = obj.sumBid;
    const ts = obj.timestamp as string | undefined;
    if (!id || typeof sumBid !== 'number' || !ts) continue;
    const arr = seriesById.get(id) ?? [];
    arr.push({ t: new Date(ts).getTime(), sumBid });
    seriesById.set(id, arr);
  } catch {
    /* skip */
  }
}
for (const arr of seriesById.values()) arr.sort((a, b) => a.t - b.t);

interface Pos {
  city: string;
  id: string;
  buckets: string;
  targetDate: string;
  cost: number;
  sizeUsd: number;
  actualExit: number;
  switched: boolean;
  seq: Array<{ t: number; sumBid: number }>;
}

const positions: Pos[] = [];
for (const city of ALL_CITIES) {
  const file = path.join('data', `trades-${city}.json`);
  if (!fs.existsSync(file)) continue;
  const trades = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
  for (const t of trades) {
    if (t.status !== 'closed') continue;
    const id = t.id as string;
    const switched = t.switched === true;
    let cost = (t.entryPrice ?? 0) as number;
    let seq = seriesById.get(id);
    if (!seq || seq.length < 3) continue;
    if (switched) {
      const switchAt = t.switchAt as string | undefined;
      const switchBuy = t.switchBuy as number | undefined;
      if (!switchAt || typeof switchBuy !== 'number' || switchBuy < 0.05) continue;
      const t0 = new Date(switchAt).getTime();
      seq = seq.filter((s) => s.t >= t0);
      if (seq.length < 3) continue;
      cost = switchBuy; // 换仓后实际成本 = 买入新桶对的成本
    }
    positions.push({
      city,
      id,
      buckets: (t.buckets as string[]).join('+'),
      targetDate: (t.targetDate as string) ?? '',
      cost,
      sizeUsd: (t.sizeUsd as number) ?? 20,
      actualExit: (t.exitPrice as number) ?? 0,
      switched,
      seq,
    });
  }
}

// 见顶回落重放。gate=true 时要求卖出价仍 > 成本（只锁利润不割肉）。
function replayPullback(
  seq: Array<{ t: number; sumBid: number }>,
  cost: number,
  pullback: number,
  actualExit: number,
  gate: boolean,
): { price: number; kind: string; t: number | null } {
  let runningPeak = 0;
  for (const s of seq) {
    if (s.sumBid > runningPeak) {
      runningPeak = s.sumBid;
    } else if (runningPeak > 0 && s.sumBid <= runningPeak * (1 - pullback) && (!gate || s.sumBid > cost)) {
      return { price: s.sumBid, kind: 'pullback', t: s.t };
    }
  }
  return { price: actualExit, kind: 'baseline', t: null };
}

const baselinePnL = positions.reduce((acc, p) => acc + (p.actualExit - p.cost) * p.sizeUsd, 0);
console.log(`样本：${positions.length} 笔已平仓持仓（含换仓单 ${positions.filter((p) => p.switched).length} 笔，已按换仓时点截断）`);
console.log(`基线总 PnL（实际平仓）：${baselinePnL >= 0 ? '+' : ''}$${baselinePnL.toFixed(2)}\n`);

const grid: number[] = [];
for (let i = 1; i <= 30; i++) grid.push(i / 100);

interface Row {
  pb: number;
  gate: { pnl: number; delta: number; trig: number; up: number; down: number };
  noGate: { pnl: number; delta: number; trig: number; up: number; down: number };
}
const rows: Row[] = [];

for (const pb of grid) {
  const run = (gate: boolean) => {
    let pnl = 0;
    let trig = 0;
    let up = 0;
    let down = 0;
    for (const p of positions) {
      const r = replayPullback(p.seq, p.cost, pb, p.actualExit, gate);
      const rp = (r.price - p.cost) * p.sizeUsd;
      const bp = (p.actualExit - p.cost) * p.sizeUsd;
      pnl += rp;
      if (r.kind === 'pullback') trig += 1;
      if (rp - bp > 0.01) up += 1;
      if (rp - bp < -0.01) down += 1;
    }
    return { pnl, delta: pnl - baselinePnL, trig, up, down };
  };
  rows.push({ pb, gate: run(true), noGate: run(false) });
}

console.log('===== 网格结果（PULLBACK 0.01→0.30） =====');
console.log(
  `${'PB'.padEnd(5)} | ${'带门槛(锁利润) 总PnL'.padEnd(18)} ${'Δ'.padEnd(8)} ${'触发'.padEnd(5)} ${'升/降'.padEnd(7)} | ${'无门槛(追踪止损) 总PnL'.padEnd(20)} ${'Δ'.padEnd(8)} ${'触发'.padEnd(5)} ${'升/降'.padEnd(6)}`,
);
for (const r of rows) {
  console.log(
    `${r.pb.toFixed(2).padEnd(5)} | ${(r.gate.pnl >= 0 ? '+' : '') + r.gate.pnl.toFixed(2).padStart(7).padEnd(18)} ${(r.gate.delta >= 0 ? '+' : '') + r.gate.delta.toFixed(2).padStart(6).padEnd(8)} ${String(r.gate.trig).padEnd(5)} ${`${r.gate.up}/${r.gate.down}`.padEnd(7)} | ${(r.noGate.pnl >= 0 ? '+' : '') + r.noGate.pnl.toFixed(2).padStart(7).padEnd(20)} ${(r.noGate.delta >= 0 ? '+' : '') + r.noGate.delta.toFixed(2).padStart(6).padEnd(8)} ${String(r.noGate.trig).padEnd(5)} ${`${r.noGate.up}/${r.noGate.down}`.padEnd(6)}`,
  );
}

const bestGate = [...rows].sort((a, b) => b.gate.pnl - a.gate.pnl)[0]!;
const bestNoGate = [...rows].sort((a, b) => b.noGate.pnl - a.noGate.pnl)[0]!;
const worstGate = [...rows].sort((a, b) => a.gate.pnl - b.gate.pnl)[0]!;
console.log('\n===== 结论 =====');
console.log(
  `带门槛最优：PULLBACK=${bestGate.pb.toFixed(2)} → 总PnL ${bestGate.gate.pnl >= 0 ? '+' : ''}$${bestGate.gate.pnl.toFixed(2)}（Δ${bestGate.gate.delta >= 0 ? '+' : ''}$${bestGate.gate.delta.toFixed(2)}，触发 ${bestGate.gate.trig} 笔）`,
);
console.log(
  `无门槛最优：PULLBACK=${bestNoGate.pb.toFixed(2)} → 总PnL ${bestNoGate.noGate.pnl >= 0 ? '+' : ''}$${bestNoGate.noGate.pnl.toFixed(2)}（Δ${bestNoGate.noGate.delta >= 0 ? '+' : ''}$${bestNoGate.noGate.delta.toFixed(2)}，触发 ${bestNoGate.noGate.trig} 笔）`,
);
console.log(
  `带门槛最差：PULLBACK=${worstGate.pb.toFixed(2)} → 总PnL ${worstGate.gate.pnl >= 0 ? '+' : ''}$${worstGate.gate.pnl.toFixed(2)}（触发 ${worstGate.gate.trig} 笔）`,
);

// 最优档位下逐笔明细（带门槛）
console.log(`\n===== 带门槛最优档 PULLBACK=${bestGate.pb.toFixed(2)} 逐笔 =====`);
for (const p of positions) {
  const r = replayPullback(p.seq, p.cost, bestGate.pb, p.actualExit, true);
  const bp = (p.actualExit - p.cost) * p.sizeUsd;
  const rp = (r.price - p.cost) * p.sizeUsd;
  const flag = r.kind === 'pullback' ? '🔔' : '☁️';
  const tag = p.switched ? '（换仓）' : '';
  console.log(
    `${flag} ${p.city} [${p.buckets}]${tag} 成本${p.cost.toFixed(2)} 实际${p.actualExit.toFixed(2)}(${(bp >= 0 ? '+' : '')}${bp.toFixed(2)}) → 卖${r.price.toFixed(2)}(${(rp >= 0 ? '+' : '')}${rp.toFixed(2)}) Δ${(rp - bp >= 0 ? '+' : '')}${(rp - bp).toFixed(2)}${r.t ? ` @${new Date(r.t).toISOString().slice(5, 16).replace('T', ' ')}` : ''}`,
  );
}
