// 全量回测：最新离场逻辑 vs 实际成交（VPS 同步数据，8/9 之后全城市双桶持仓）。
//
// 最新离场逻辑（按生产 ExitStrategy + 新见顶回落，优先级从上到下）：
//   1. 区间目标：双桶 bid 之和 >= 0.85 → 平仓（锁赢家）
//   2. 见顶回落：从持仓期峰值回落 >= 5% → 平仓（无成本门槛，跌破成本也割肉离场）
//   3. 未触发 → 按实际成交价（基线）
//   （价格止损 K=0.7 已取消）
// 买入规则：平仓时刻所在城市日 D3/D2 → 桶对可重新入选（走完整选桶流程）；
//           D1/D0 → 永久黑名单。
//
// 数据：logs/combined.log 的 10 分钟 sumBid 轨迹 + data/trades-<city>.json 的成交记录。
// 换仓单按 switchAt 截断轨迹、成本 = switchBuy。
// 运行：npx tsx scripts/backtest-exits-vps.ts（STOP_LOSS_K=0 无止损；默认即无止损）
import fs from 'node:fs';
import path from 'node:path';
import { ALL_CITIES } from '../src/common/types.js';
import { loadCityConfig } from '../src/common/config-loader.js';

// ==================== 参数（最新逻辑） ====================
const PULLBACK = Number(process.env.PULLBACK ?? '0.05'); // 见顶回落阈值（网格确认 5% 最优）
const STOP_LOSS_K = Number(process.env.STOP_LOSS_K ?? '0'); // 止损已取消，默认 0；可临时设为 0.7 对比
const STOP_LOSS_LOCAL_HOUR = 15; // D0 当天此本地时刻起止损可用
const INTERVAL_EXIT = 0.85;
// D1_REBUY=1：模拟"D1/D0 平仓后也允许重买"（放开黑名单）——平仓后下一采样按当时 sumBid 重买，
// 再按同一离场链跑二次收益。注意 sumBid 是 bid 口径，真实重买成本=ask 更高，结果偏乐观。
const D1_REBUY = (process.env.D1_REBUY ?? '0') === '1';
const ASK_SLIPPAGE = Number(process.env.ASK_SLIPPAGE ?? '1.0'); // 重买成本 bid→ask 价差系数
// MAX_COST=0 不限成本上限；>0 时只回测 cost<=MAX_COST 的持仓（验证"开仓成本上限"假设）。
const MAX_COST = Number(process.env.MAX_COST ?? '0');
// EXIT_SLIPPAGE：真实平仓成交价 = 触发时 bid × 折扣（bid 是纸面报价，长尾市场深度不足，
// 卖出会打穿 bid，0.8 即假设只能拿到 bid 的 80%）。=1 时退化为原 bid 口径。
// 公平对比：实际成交（actualExit 本身也是 paper 按 bid 记的）同样按 EXIT_SLIPPAGE 打折。
const EXIT_SLIPPAGE = Number(process.env.EXIT_SLIPPAGE ?? '0.8');

// ==================== 读取 10 分钟 sumBid 轨迹 ====================
// 日志时间戳是 UTC 墙钟（无时区后缀），必须按 UTC 解析，否则会按本机时区偏移。
function parseLogTs(s: string): number {
  return Date.parse(s.replace(' ', 'T') + 'Z');
}

const seriesById = new Map<string, Array<{ t: number; sumBid: number }>>();
for (const line of fs.readFileSync(path.join('logs', 'combined.log'), 'utf8').split('\n')) {
  if (!line.includes('"sumBid"')) continue;
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const id = obj.positionId as string | undefined;
    const sumBid = obj.sumBid;
    const ts = obj.timestamp as string | undefined;
    if (!id || typeof sumBid !== 'number' || !ts) continue;
    const arr = seriesById.get(id) ?? [];
    arr.push({ t: parseLogTs(ts), sumBid });
    seriesById.set(id, arr);
  } catch { /* skip */ }
}
for (const arr of seriesById.values()) arr.sort((a, b) => a.t - b.t);

// ==================== 城市本地时间工具 ====================
const tzCache = new Map<string, { tz: string; hardExit: string }>();
function cityMeta(city: string): { tz: string; hardExit: string } {
  let m = tzCache.get(city);
  if (m) return m;
  try {
    const cfg = loadCityConfig(city as Parameters<typeof loadCityConfig>[0]);
    m = { tz: cfg.timezone, hardExit: cfg.peakTimeLocal.latest };
  } catch {
    m = { tz: 'Asia/Shanghai', hardExit: '14:00' };
  }
  tzCache.set(city, m);
  return m;
}

function localParts(ms: number, tz: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
}

// ==================== 最新离场链重放 ====================
type ExitKind = 'interval' | 'stop_loss' | 'pullback' | 'baseline';
function replayExits(
  seq: Array<{ t: number; sumBid: number }>,
  cost: number,
  targetDate: string,
  tz: string,
  actualExit: number,
): { kind: ExitKind; price: number; at: number | null } {
  let runningPeak = 0;
  for (const s of seq) {
    // 1) 区间目标优先
    if (s.sumBid >= INTERVAL_EXIT) return { kind: 'interval', price: s.sumBid, at: s.t };
    // 2) 价格止损（D0 本地 15:00 前禁用）
    if (STOP_LOSS_K > 0) {
      const local = localParts(s.t, tz);
      const isD0 = local.date === targetDate;
      const stopEnabled = !(isD0 && local.hour < STOP_LOSS_LOCAL_HOUR);
      if (stopEnabled && s.sumBid <= cost * STOP_LOSS_K) {
        return { kind: 'stop_loss', price: s.sumBid, at: s.t };
      }
    }
    // 3) 见顶回落（纯峰值追踪，无成本门槛：跌破成本回落 3% 也割肉离场）
    if (s.sumBid > runningPeak) {
      runningPeak = s.sumBid;
    } else if (runningPeak > 0 && s.sumBid <= runningPeak * (1 - PULLBACK)) {
      return { kind: 'pullback', price: s.sumBid, at: s.t };
    }
  }
  return { kind: 'baseline', price: actualExit, at: null };
}

// ==================== 平仓日 horizon 判定（买入规则：D3/D2 可重选，D1/D0 永久黑名单） ====================
// 平仓时刻在目标城市本地日期距离 targetDate 的天数：0=D0、1=D1、2=D2、>=3=D3。
function horizonAt(ms: number, targetDate: string, tz: string): string {
  if (!targetDate) return '?';
  const local = localParts(ms, tz);
  const days = Math.round((Date.parse(targetDate) - Date.parse(local.date)) / 86400000);
  if (days <= 0) return 'D0';
  if (days === 1) return 'D1';
  if (days === 2) return 'D2';
  return `D${days}`;
}

// ==================== 加载持仓 ====================
interface Pos {
  city: string; id: string; buckets: string; targetDate: string;
  cost: number; sizeUsd: number; actualExit: number; switched: boolean;
  seq: Array<{ t: number; sumBid: number }>;
  openedAt: string;
}

const positions: Pos[] = [];
const noSeries: string[] = [];
for (const city of ALL_CITIES) {
  const file = path.join('data', `trades-${city}.json`);
  if (!fs.existsSync(file)) continue;
  const trades = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
  for (const t of trades) {
    if (t.status !== 'closed') continue;
    const buckets = t.buckets as string[];
    if (!buckets || buckets.length < 2) continue; // 只回测当前双桶区间策略的持仓（排除单桶占位单）
    const id = t.id as string;
    const switched = t.switched === true;
    let cost = (t.entryPrice ?? 0) as number;
    let seq = seriesById.get(id);
    if (switched) {
      const switchAt = t.switchAt as string | undefined;
      const switchBuy = t.switchBuy as number | undefined;
      if (!switchAt || typeof switchBuy !== 'number' || switchBuy < 0.05) continue;
      seq = seq?.filter((s) => s.t >= new Date(switchAt).getTime());
      cost = switchBuy;
    }
    if (!seq || seq.length < 3) {
      noSeries.push(`${city} ${id}`);
      continue;
    }
    if (MAX_COST > 0 && cost > MAX_COST) continue; // 开仓成本上限过滤
    positions.push({
      city, id, buckets: buckets.join('+'), targetDate: (t.targetDate as string) ?? '',
      cost, sizeUsd: (t.sizeUsd as number) ?? 20, actualExit: (t.exitPrice as number) ?? 0,
      switched, seq, openedAt: (t.openedAt as string) ?? '',
    });
  }
}

// ==================== 回测 ====================
console.log(`样本：${positions.length} 笔双桶已平仓持仓（8/9 之后全城市，换仓单 ${positions.filter((p) => p.switched).length} 笔${MAX_COST > 0 ? `，成本上限 $${MAX_COST}` : ''}）`);
if (noSeries.length > 0) console.log(`无轨迹跳过：${noSeries.length} 笔（${noSeries.join('、')}）\n`);

let actualTotal = 0; // 实际成交 × 折价
let actualTotalBid = 0; // 实际成交 bid 口径（不打折）
let replayTotal = 0; // 最新逻辑 bid 口径（不打折）
let replayTotalAdj = 0; // 最新逻辑 × 折价
const byKind = new Map<ExitKind, { n: number; delta: number; up: number; down: number }>();
const reEligible: string[] = [];
const banned: string[] = [];
let d1RebuyTotal = 0;
let d1RebuyN = 0;
const d1RebuyRows: string[] = [];
for (const p of positions) {
  const meta = cityMeta(p.city);
  const r = replayExits(p.seq, p.cost, p.targetDate, meta.tz, p.actualExit);
  // 触发类（interval/stop_loss/pullback）平仓价 = 触发时 bid；真实成交按 EXIT_SLIPPAGE 打折。
  // baseline（无触发）沿用实际成交价；实际成交本身也是 paper 按 bid 记的，同样打折做公平对比。
  const exitAdj = r.price * EXIT_SLIPPAGE;
  const actualAdj = p.actualExit * EXIT_SLIPPAGE;
  const ap = (actualAdj - p.cost) * p.sizeUsd; // 实际（同折价口径）
  const apBid = (p.actualExit - p.cost) * p.sizeUsd; // 实际 bid 口径
  const rp = (r.price - p.cost) * p.sizeUsd; // 最新逻辑 bid 口径
  const rpAdj = (exitAdj - p.cost) * p.sizeUsd; // 最新逻辑折价口径（真实盈利能力）
  const d = rpAdj - ap;
  actualTotal += ap;
  actualTotalBid += apBid;
  replayTotal += rp;
  replayTotalAdj += rpAdj;
  const k = byKind.get(r.kind) ?? { n: 0, delta: 0, up: 0, down: 0 };
  k.n += 1; k.delta += d; if (d > 0.01) k.up += 1; if (d < -0.01) k.down += 1;
  byKind.set(r.kind, k);

  // 平仓日判定：D3/D2 可重选，D1/D0 永久黑名单
  const exitMs = r.at ?? p.seq[p.seq.length - 1].t;
  const hor = horizonAt(exitMs, p.targetDate, meta.tz);
  const canRe = hor === 'D2' || hor === 'D3';
  (canRe ? reEligible : banned).push(`${p.city}[${p.buckets}]${p.switched ? '(换)' : ''}@${hor}`);

  const flag = r.kind === 'pullback' ? '🔔' : r.kind === 'stop_loss' ? '🛑' : r.kind === 'interval' ? '🎯' : '☁️';
  const tag = p.switched ? '（换仓）' : '';
  const adjMark = r.kind === 'baseline' ? '' : `×${EXIT_SLIPPAGE}`;
  console.log(
    `${flag} ${p.city.padEnd(11)} [${p.buckets}]${tag} 成本${p.cost.toFixed(2)} 实际${p.actualExit.toFixed(2)}(${(ap >= 0 ? '+' : '')}${ap.toFixed(2)}) → ${r.kind === 'baseline' ? '无触发' : r.kind + ' ' + r.price.toFixed(2) + adjMark}(${(rpAdj >= 0 ? '+' : '')}${rpAdj.toFixed(2)}) Δ${(d >= 0 ? '+' : '')}${d.toFixed(2)} ${canRe ? '🟢' : '🔴'}${hor}${canRe ? '可重选' : '黑名单'}${r.at ? ` @${new Date(r.at).toISOString().slice(5, 16).replace('T', ' ')} UTC` : ''}`,
  );

  // D1/D0 平仓后允许重买模拟（放开黑名单）
  if (D1_REBUY && !canRe && r.at) {
    const reSeg = p.seq.filter((s) => s.t > r.at!);
    if (reSeg.length >= 3) {
      const reCost = reSeg[0].sumBid * ASK_SLIPPAGE;
      const r2 = replayExits(reSeg, reCost, p.targetDate, meta.tz, reSeg[reSeg.length - 1].sumBid);
      const rp2 = (r2.price - reCost) * p.sizeUsd;
      d1RebuyTotal += rp2;
      d1RebuyN += 1;
      d1RebuyRows.push(
        `${p.city}[${p.buckets}] 重买${reCost.toFixed(2)} → ${r2.kind === 'baseline' ? '无触发' : r2.kind + ' ' + r2.price.toFixed(2)} PnL${(rp2 >= 0 ? '+' : '')}${rp2.toFixed(2)}${r2.at ? ` @${new Date(r2.at).toISOString().slice(5, 16).replace('T', ' ')} UTC` : ''}`,
      );
    }
  }
}

console.log(`\n===== 汇总（完整逻辑：0.85 优先 + 无止损 + 回落 5% 无门槛 + 平仓日黑名单） =====`);
console.log(`[bid 口径] 实际总 PnL：${actualTotalBid >= 0 ? '+' : ''}$${actualTotalBid.toFixed(2)} → 最新逻辑 ${replayTotal >= 0 ? '+' : ''}$${replayTotal.toFixed(2)}（Δ${(replayTotal - actualTotalBid) >= 0 ? '+' : ''}$${(replayTotal - actualTotalBid).toFixed(2)}）`);
console.log(`[×${EXIT_SLIPPAGE} 折价，真实盈利能力] 实际总 PnL：${actualTotal >= 0 ? '+' : ''}$${actualTotal.toFixed(2)} → 最新逻辑 ${replayTotalAdj >= 0 ? '+' : ''}$${replayTotalAdj.toFixed(2)}（Δ${(replayTotalAdj - actualTotal) >= 0 ? '+' : ''}$${(replayTotalAdj - actualTotal).toFixed(2)}）`);
for (const [kind, s] of [...byKind.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${kind.padEnd(10)} 触发 ${s.n} 笔，Δ${(s.delta >= 0 ? '+' : '')}$${s.delta.toFixed(2)}，改善 ${s.up}/变差 ${s.down}`);
}
console.log(`\n买入规则判定（平仓日 D3/D2 可重选 ${reEligible.length} 笔）：${reEligible.join('、') || '无'}`);
console.log(`买入规则判定（平仓日 D1/D0 永久黑名单 ${banned.length} 笔）：${banned.join('、') || '无'}`);
if (D1_REBUY) {
  console.log(`\n===== D1/D0 放开黑名单重买模拟（成本=bid${ASK_SLIPPAGE > 1 ? `×${ASK_SLIPPAGE}` : ''}，偏乐观） =====`);
  for (const row of d1RebuyRows) console.log(`  🔄 ${row}`);
  console.log(`重买 ${d1RebuyN} 笔，额外 PnL ${d1RebuyTotal >= 0 ? '+' : ''}$${d1RebuyTotal.toFixed(2)}（叠加后总 ${replayTotal + d1RebuyTotal >= 0 ? '+' : ''}$${(replayTotal + d1RebuyTotal).toFixed(2)}）`);
}
