// 详细回测报告：最新离场逻辑（0.85 优先 + 无止损 + 回落 5% 无门槛 + 平仓日黑名单）
// 逐笔重放，输出每笔交易的进出场时间（UTC + 城市本地）、持仓时长、触发细节与 PnL 分析，
// 生成 Markdown 报告到 data/processed/backtest-report-<date>.md。
//
// 数据：logs/combined.log 的 10 分钟 sumBid 轨迹 + data/trades-<city>.json 的成交记录。
// 换仓单按 switchAt 截断轨迹、成本 = switchBuy、进场时间 = switchAt。
// 运行：npx tsx scripts/backtest-report.ts
import fs from 'node:fs';
import path from 'node:path';
import { ALL_CITIES } from '../src/common/types.js';
import { loadCityConfig } from '../src/common/config-loader.js';

// ==================== 参数（与生产完全一致） ====================
const PULLBACK = Number(process.env.PULLBACK ?? '0.05');
const STOP_LOSS_K = Number(process.env.STOP_LOSS_K ?? '0');
const INTERVAL_EXIT = 0.85;

// ==================== 城市中英文名与本地时区 ====================
const CITY_CN: Record<string, string> = {
  shanghai: '上海', nyc: '纽约', chicago: '芝加哥', miami: '迈阿密', dallas: '达拉斯',
  seattle: '西雅图', atlanta: '亚特兰大', london: '伦敦', paris: '巴黎', munich: '慕尼黑',
  ankara: '安卡拉', seoul: '首尔', tokyo: '东京', singapore: '新加坡', lucknow: '勒克瑙',
  'tel-aviv': '特拉维夫', toronto: '多伦多', 'sao-paulo': '圣保罗', 'buenos-aires': '布宜诺斯艾利斯',
  wellington: '惠灵顿',
};

// ==================== 读取 10 分钟 sumBid 轨迹 ====================
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

function fmtUTC(ms: number): string {
  return new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
}

function fmtLocal(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const h = (Number(get('hour')) % 24).toString().padStart(2, '0');
  return `${get('year')}-${get('month')}-${get('day')} ${h}:${get('minute')}`;
}

// ==================== 最新离场链重放（与生产 ExitStrategy 一致） ====================
type ExitKind = 'interval' | 'pullback' | 'baseline';
interface ReplayResult {
  kind: ExitKind;
  price: number;
  at: number | null;
  peak: number;
  peakAt: number;
}
function replayExits(
  seq: Array<{ t: number; sumBid: number }>,
  targetDate: string,
  tz: string,
  actualExit: number,
): ReplayResult {
  let runningPeak = 0;
  let peakAt = 0;
  for (const s of seq) {
    // 1) 区间目标优先
    if (s.sumBid >= INTERVAL_EXIT) {
      return { kind: 'interval', price: s.sumBid, at: s.t, peak: runningPeak, peakAt };
    }
    // 2) 见顶回落（无成本门槛）
    if (s.sumBid > runningPeak) {
      runningPeak = s.sumBid;
      peakAt = s.t;
    } else if (runningPeak > 0 && s.sumBid <= runningPeak * (1 - PULLBACK)) {
      return { kind: 'pullback', price: s.sumBid, at: s.t, peak: runningPeak, peakAt };
    }
  }
  return { kind: 'baseline', price: actualExit, at: null, peak: runningPeak, peakAt };
}

// ==================== 平仓日 horizon 判定 ====================
function horizonAt(ms: number, targetDate: string, tz: string): string {
  if (!targetDate) return '?';
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const localDate = fmt.format(new Date(ms));
  const days = Math.round((Date.parse(targetDate) - Date.parse(localDate)) / 86400000);
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
  entryMs: number; // 进场时间（换仓单 = switchAt）
  reason: string;
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
    if (!buckets || buckets.length < 2) continue;
    const id = t.id as string;
    const switched = t.switched === true;
    let cost = (t.entryPrice ?? 0) as number;
    let entryMs = Date.parse((t.openedAt as string) ?? '');
    let seq = seriesById.get(id);
    if (switched) {
      const switchAt = t.switchAt as string | undefined;
      const switchBuy = t.switchBuy as number | undefined;
      if (!switchAt || typeof switchBuy !== 'number' || switchBuy < 0.05) continue;
      seq = seq?.filter((s) => s.t >= Date.parse(switchAt));
      cost = switchBuy;
      entryMs = Date.parse(switchAt);
    }
    if (!seq || seq.length < 3 || !Number.isFinite(entryMs)) {
      noSeries.push(`${city} ${id}`);
      continue;
    }
    positions.push({
      city, id, buckets: buckets.join('+'), targetDate: (t.targetDate as string) ?? '',
      cost, sizeUsd: (t.sizeUsd as number) ?? 20, actualExit: (t.exitPrice as number) ?? 0,
      switched, seq, entryMs, reason: (t.reason as string) ?? '',
    });
  }
}

// ==================== 逐笔重放与统计 ====================
const rows: Array<Record<string, string | number>> = [];
let actualTotal = 0;
let replayTotal = 0;
const byKind = new Map<ExitKind, { n: number; delta: number; up: number; down: number }>();
const cityAgg = new Map<string, { n: number; pnl: number; delta: number }>();
const reEligible: string[] = [];
const banned: string[] = [];
const triggers: ExitKind[] = [];

for (const p of positions) {
  const meta = cityMeta(p.city);
  const r = replayExits(p.seq, p.targetDate, meta.tz, p.actualExit);
  const ap = (p.actualExit - p.cost) * p.sizeUsd;
  const rp = (r.price - p.cost) * p.sizeUsd;
  const d = rp - ap;
  actualTotal += ap;
  replayTotal += rp;
  triggers.push(r.kind);

  const k = byKind.get(r.kind) ?? { n: 0, delta: 0, up: 0, down: 0 };
  k.n += 1; k.delta += d; if (d > 0.01) k.up += 1; if (d < -0.01) k.down += 1;
  byKind.set(r.kind, k);

  const ca = cityAgg.get(p.city) ?? { n: 0, pnl: 0, delta: 0 };
  ca.n += 1; ca.pnl += rp; ca.delta += d;
  cityAgg.set(p.city, ca);

  const exitMs = r.at ?? p.seq[p.seq.length - 1].t;
  const hor = horizonAt(exitMs, p.targetDate, meta.tz);
  const canRe = hor === 'D2' || hor === 'D3';
  (canRe ? reEligible : banned).push(`${p.city}[${p.buckets}]@${hor}`);

  const holdHours = (exitMs - p.entryMs) / 3600000;
  const peakLine = r.peak * (1 - PULLBACK);

  rows.push({
    city: `${CITY_CN[p.city] ?? p.city}${p.switched ? '（换仓）' : ''}`,
    buckets: p.buckets,
    entryUtc: fmtUTC(p.entryMs),
    entryLocal: fmtLocal(p.entryMs, meta.tz),
    exitUtc: r.at ? fmtUTC(r.at) : fmtUTC(p.seq[p.seq.length - 1].t),
    exitLocal: r.at ? fmtLocal(r.at, meta.tz) : fmtLocal(p.seq[p.seq.length - 1].t, meta.tz),
    holdHours: Math.round(holdHours * 10) / 10,
    cost: p.cost,
    sizeUsd: p.sizeUsd,
    trigger: r.kind === 'baseline' ? '未触发' : r.kind === 'interval' ? '0.85目标' : `回落${PULLBACK * 100}%`,
    peak: Math.round(r.peak * 1000) / 1000,
    exitPrice: Math.round(r.price * 1000) / 1000,
    actualPnl: Math.round(ap * 100) / 100,
    replayPnl: Math.round(rp * 100) / 100,
    delta: Math.round(d * 100) / 100,
    rule: canRe ? `🟢${hor}可重选` : `🔴${hor}黑名单`,
  });
}

// ==================== 生成 Markdown ====================
const today = new Date().toISOString().slice(0, 10);
const lines: string[] = [];

lines.push(`# 详细回测报告（${today}）`);
lines.push('');
lines.push(`> 离场逻辑：**0.85 区间目标优先 → 见顶回落 ${PULLBACK * 100}%（无成本门槛）**，价格止损已取消（K=${STOP_LOSS_K}）。`);
lines.push(`> 买入规则：平仓日 **D2/D3 → 桶对可重新入选**；**D1/D0 → 永久黑名单**。`);
lines.push(`> 数据：10 分钟 sumBid 轨迹（logs/combined.log）+ 成交记录（data/trades-*.json），换仓单按 switchAt 截断、成本 = switchBuy。`);
lines.push('');

// ---- 总览 ----
const n = positions.length;
const intervalN = byKind.get('interval')?.n ?? 0;
const pullbackN = byKind.get('pullback')?.n ?? 0;
const baselineN = byKind.get('baseline')?.n ?? 0;
const totalDelta = replayTotal - actualTotal;

lines.push('## 一、总览（大白话）');
lines.push('');
lines.push(`- 回测样本：**${n} 笔**双桶已平仓持仓（8/9 之后全城市，其中换仓单 ${positions.filter((p) => p.switched).length} 笔）`);
lines.push(`- 实际成交总 PnL：**${actualTotal >= 0 ? '+' : ''}$${actualTotal.toFixed(2)}**`);
lines.push(`- 最新逻辑总 PnL：**${replayTotal >= 0 ? '+' : ''}$${replayTotal.toFixed(2)}**（比实际 **${totalDelta >= 0 ? '多赚' : '少赚'} $${Math.abs(totalDelta).toFixed(2)}**）`);
lines.push(`- 触发分布：0.85 目标 **${intervalN}** 笔 / 见顶回落 **${pullbackN}** 笔 / 未触发（按实际价）**${baselineN}** 笔`);
if (noSeries.length > 0) lines.push(`- ⚠️ 无轨迹跳过 ${noSeries.length} 笔（${noSeries.join('、')}）`);
lines.push('');

// ---- 逐笔明细 ----
lines.push('## 二、逐笔交易明细');
lines.push('');
lines.push(`| # | 城市 | 桶对 | 进场(UTC) | 进场(本地) | 出场(UTC) | 出场(本地) | 持仓h | 成本 | 触发 | 峰值 | 出场价 | 实际PnL | 最新PnL | Δ | 买入规则 |`);
lines.push('|---|------|------|-----------|------------|-----------|------------|-------|------|------|------|--------|---------|---------|------|----------|');
rows.forEach((r, i) => {
  const fmtMoney = (v: number) => `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`;
  lines.push(
    `| ${i + 1} | ${r.city} | ${r.buckets} | ${r.entryUtc} | ${r.entryLocal} | ${r.exitUtc} | ${r.exitLocal} | ${r.holdHours} | ${(r.cost as number).toFixed(2)} | ${r.trigger} | ${(r.peak as number).toFixed(3)} | ${(r.exitPrice as number).toFixed(3)} | ${fmtMoney(r.actualPnl as number)} | ${fmtMoney(r.replayPnl as number)} | ${fmtMoney(r.delta as number)} | ${r.rule} |`,
  );
});
lines.push('');

// ---- 触发类型统计 ----
lines.push('## 三、按触发类型统计');
lines.push('');
lines.push(`| 触发 | 笔数 | ΔPnL | 改善 | 变差 |`);
lines.push(`|------|------|------|------|------|`);
for (const [kind, s] of [...byKind.entries()].sort((a, b) => b[1].n - a[1].n)) {
  const name = kind === 'interval' ? '0.85 目标' : kind === 'pullback' ? `回落 ${PULLBACK * 100}%` : '未触发';
  lines.push(`| ${name} | ${s.n} | ${s.delta >= 0 ? '+' : ''}$${s.delta.toFixed(2)} | ${s.up} | ${s.down} |`);
}
lines.push('');

// ---- 分城市统计 ----
lines.push('## 四、分城市统计');
lines.push('');
lines.push(`| 城市 | 笔数 | 最新PnL | Δ |`);
lines.push(`|------|------|---------|------|`);
for (const [city, s] of [...cityAgg.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
  lines.push(`| ${CITY_CN[city] ?? city} | ${s.n} | ${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)} | ${s.delta >= 0 ? '+' : ''}$${s.delta.toFixed(2)} |`);
}
lines.push('');

// ---- 买入规则判定 ----
lines.push('## 五、买入规则判定');
lines.push('');
lines.push(`- 🟢 D2/D3 可重选（${reEligible.length} 笔）：${reEligible.join('、') || '无'}`);
lines.push(`- 🔴 D1/D0 永久黑名单（${banned.length} 笔）：${banned.join('、') || '无'}`);
lines.push('');
lines.push('> 大白话：平仓发生在**结算前一天以内（D1/D0）**的桶对，说明市场已经把信息吃透了、再去重买同一对桶等于追一个快定死的结果，所以永久拉黑；**提前 2 天以上（D2/D3）**平仓的还可以按正常流程重新考虑。');
lines.push('');

// ---- 盈亏结构分析 ----
const winners = rows.filter((r) => (r.replayPnl as number) > 0);
const losers = rows.filter((r) => (r.replayPnl as number) <= 0);
const winSum = winners.reduce((s, r) => s + (r.replayPnl as number), 0);
const loseSum = losers.reduce((s, r) => s + (r.replayPnl as number), 0);
const intervalPnl = rows.filter((r) => r.trigger === '0.85目标').reduce((s, r) => s + (r.replayPnl as number), 0);
const pullbackPnl = rows.filter((r) => r.trigger !== '0.85目标' && r.trigger !== '未触发').reduce((s, r) => s + (r.replayPnl as number), 0);

lines.push('## 六、盈亏结构');
lines.push('');
lines.push(`- 盈利 ${winners.length} 笔，合计 **+$${winSum.toFixed(2)}**`);
lines.push(`- 亏损 ${losers.length} 笔，合计 **$${loseSum.toFixed(2)}**`);
lines.push(`- 0.85 目标平仓合计：**${intervalPnl >= 0 ? '+' : ''}$${intervalPnl.toFixed(2)}**（${intervalN} 笔）`);
lines.push(`- 见顶回落平仓合计：**${pullbackPnl >= 0 ? '+' : ''}$${pullbackPnl.toFixed(2)}**（${pullbackN} 笔）`);
lines.push('');
lines.push('---');
lines.push(`> 自动生成：npx tsx scripts/backtest-report.ts（参数与生产一致：PULLBACK=${PULLBACK}、STOP_LOSS_K=${STOP_LOSS_K}）`);

const outDir = path.join('data', 'processed');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `backtest-report-${today}.md`);
fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
console.log(`✅ 报告已生成：${outFile}`);
console.log(`样本 ${n} 笔 | 实际 ${actualTotal.toFixed(2)} → 最新 ${replayTotal.toFixed(2)}（Δ${totalDelta >= 0 ? '+' : ''}${totalDelta.toFixed(2)}）| interval ${intervalN} / pullback ${pullbackN} / baseline ${baselineN}`);
