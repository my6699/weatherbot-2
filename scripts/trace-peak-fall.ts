// 分析曾超成本的持仓：开仓→见顶→回落10%→跌破成本→平仓 的时间线
// 回答："这些桶价格是在持仓多久开始回落的？"
import fs from 'node:fs';
import path from 'node:path';

// 9 笔曾超成本的亏损单
const targets: Array<{ city: string; date: string; buckets: string; cost: number }> = [
  { city: 'london', date: '2026-08-11', buckets: '25+26', cost: 0.24 },
  { city: 'tokyo', date: '2026-08-11', buckets: '28+29', cost: 0.17 },
  { city: 'wellington', date: '2026-08-11', buckets: '12+13', cost: 0.41 },
  { city: 'paris', date: '2026-08-11', buckets: '31+32', cost: 0.45 },
  { city: 'chicago', date: '2026-08-11', buckets: '31+32', cost: 0.26 },
  { city: 'atlanta', date: '2026-08-11', buckets: '34+35', cost: 0.57 },
  { city: 'tel-aviv', date: '2026-08-11', buckets: '35+36', cost: 0.65 },
  { city: 'nyc', date: '2026-08-11', buckets: '31+32', cost: 0.62 },
  { city: 'singapore', date: '2026-08-11', buckets: '32+33', cost: 0.65 },
];

const logFile = path.join('logs', 'pm2-strategy-out.log');
const lines = fs.readFileSync(logFile, 'utf8').split('\n');

function findTradeId(city: string, date: string, buckets: string): string | null {
  const file = path.join('data', `trades-${city}.json`);
  if (!fs.existsSync(file)) return null;
  const trades = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
  const hit = trades.find((t) => {
    if (t.status !== 'closed') return false;
    if (t.targetDate !== date) return false;
    const bs = (t.buckets as string[]).map((b) => b.replace(/\s/g, '')).join('+');
    return bs === buckets;
  });
  return (hit?.id as string) ?? null;
}

const rowRe = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}):.*positionId":"([^"]+)".*sumBid":([0-9.]+)/;

const H = 3_600_000;
const fmt = (ms: number): string => `${(ms / H).toFixed(1)}h`;
const short = (iso: string): string => iso.slice(5, 16).replace('T', ' ');

console.log('===== 9 笔曾超成本持仓：冲高→回落时间线 =====');
for (const t of targets) {
  const id = findTradeId(t.city, t.date, t.buckets);
  if (!id) continue;
  const series: Array<{ t: number; iso: string; sumBid: number }> = [];
  for (const line of lines) {
    const m = rowRe.exec(line);
    if (m && m[2] === id) series.push({ t: new Date(m[1]!).getTime(), iso: m[1]!, sumBid: Number(m[3]) });
  }
  if (series.length < 3) continue;

  const first = series[0]!;
  let peak = series[0]!;
  for (const s of series) if (s.sumBid > peak.sumBid) peak = s;
  const last = series[series.length - 1]!;
  const peakIdx = series.indexOf(peak);

  // 见顶后首个回落 >=10% 的采样点
  const fall10 = series.find((s) => s.t > peak.t && s.sumBid <= peak.sumBid * 0.9);
  // 见顶后首次跌破成本的采样点（曾超成本才可能有）
  const belowCost = series.find((s) => s.t > peak.t && s.sumBid < t.cost);
  // 见顶后首次跌破成本 80%（深跌）
  const deepFall = series.find((s) => s.t > peak.t && s.sumBid <= t.cost * 0.8);

  const line1 = `${t.city} [${t.buckets}] 成本 ${t.cost.toFixed(2)} 平仓价 ${last.sumBid.toFixed(2)}`;
  const line2 = `  开仓 ${short(first.iso)} sumBid ${first.sumBid.toFixed(2)} → 见顶 ${short(peak.iso)} ${peak.sumBid.toFixed(2)}（${fmt(peak.t - first.t)} 后）`;
  const line3 = fall10
    ? `  → 回落10% ${short(fall10.iso)} ${fall10.sumBid.toFixed(2)}（距见顶 ${fmt(fall10.t - peak.t)}）`
    : '  → 见顶后未出现回落10%（一路阴跌）';
  const line4 = belowCost
    ? `  → 跌破成本 ${short(belowCost.iso)} ${belowCost.sumBid.toFixed(2)}（距见顶 ${fmt(belowCost.t - peak.t)}，距开仓 ${fmt(belowCost.t - first.t)}）`
    : '';
  const line5 = deepFall
    ? `  → 跌破成本80% ${short(deepFall.iso)} ${deepFall.sumBid.toFixed(2)}（距见顶 ${fmt(deepFall.t - peak.t)}）`
    : '';
  const line6 = `  → 平仓 ${short(last.iso)} ${last.sumBid.toFixed(2)}（距见顶 ${fmt(last.t - peak.t)}，持仓总时长 ${fmt(last.t - first.t)}）`;
  console.log(`${line1}\n${line2}\n${line3}${line4 ? '\n' + line4 : ''}${line5 ? '\n' + line5 : ''}\n${line6}`);
}
