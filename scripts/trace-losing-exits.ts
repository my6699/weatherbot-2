// 追踪 14 笔亏损单的持有期 bid 轨迹（策略日志 '继续持有' 的 sumBid 序列，按 positionId 匹配）
import fs from 'node:fs';
import path from 'node:path';

// 14 笔亏损单：city + targetDate + buckets（与 analyze-exits.ts 对齐）
const targets: Array<{ city: string; date: string; buckets: string; cost: number; exitPrice: number; closedAt: string }> = [
  { city: 'lucknow', date: '2026-08-11', buckets: '33+34', cost: 0.65, exitPrice: 0.18, closedAt: '08-10 18:32' },
  { city: 'toronto', date: '2026-08-11', buckets: '27+28', cost: 0.57, exitPrice: 0.132, closedAt: '08-11 04:03' },
  { city: 'paris', date: '2026-08-11', buckets: '31+32', cost: 0.45, exitPrice: 0.12, closedAt: '08-10 22:02' },
  { city: 'nyc', date: '2026-08-11', buckets: '31+32', cost: 0.62, exitPrice: 0.39, closedAt: '08-11 04:03' },
  { city: 'seattle', date: '2026-08-10', buckets: '27+28', cost: 0.47, exitPrice: 0.26, closedAt: '08-10 07:01' },
  { city: 'tel-aviv', date: '2026-08-11', buckets: '35+36', cost: 0.65, exitPrice: 0.52, closedAt: '08-10 21:02' },
  { city: 'ankara', date: '2026-08-11', buckets: '31+32', cost: 0.56, exitPrice: 0.46, closedAt: '08-10 21:02' },
  { city: 'sao-paulo', date: '2026-08-11', buckets: '22+23', cost: 0.47, exitPrice: 0.37, closedAt: '08-11 03:03' },
  { city: 'london', date: '2026-08-11', buckets: '25+26', cost: 0.24, exitPrice: 0.143, closedAt: '08-10 23:02' },
  { city: 'tokyo', date: '2026-08-11', buckets: '28+29', cost: 0.169, exitPrice: 0.109, closedAt: '08-10 15:02' },
  { city: 'singapore', date: '2026-08-11', buckets: '32+33', cost: 0.65, exitPrice: 0.61, closedAt: '08-10 16:02' },
  { city: 'atlanta', date: '2026-08-11', buckets: '34+35', cost: 0.57, exitPrice: 0.54, closedAt: '08-11 04:03' },
  { city: 'wellington', date: '2026-08-11', buckets: '12+13', cost: 0.41, exitPrice: 0.38, closedAt: '08-10 12:01' },
  { city: 'chicago', date: '2026-08-11', buckets: '31+32', cost: 0.26, exitPrice: 0.25, closedAt: '08-11 05:03' },
];

const logFile = path.join('logs', 'pm2-strategy-out.log');
const lines = fs.readFileSync(logFile, 'utf8').split('\n');

// 从 trades 找每笔的持仓 id（positionId）
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

// 日志行解析：pm2 前缀 ISO 时间 + JSON（positionId + sumBid）
const rowRe = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}):.*positionId":"([^"]+)".*sumBid":([0-9.]+)/;

console.log('===== 14 笔亏损单持有期 bid 轨迹（sumBid = 双桶 bid 之和） =====');
for (const t of targets) {
  const id = findTradeId(t.city, t.date, t.buckets);
  if (!id) {
    console.log(`❌ ${t.city} [${t.buckets}]：trades 中找不到持仓 id`);
    continue;
  }
  const series: Array<{ t: string; sumBid: number }> = [];
  for (const line of lines) {
    const m = rowRe.exec(line);
    if (m && m[2] === id) series.push({ t: m[1]!, sumBid: Number(m[3]) });
  }
  if (series.length === 0) {
    console.log(`❌ ${t.city} [${t.buckets}] (id=${id})：日志无该持仓的 '继续持有' 记录`);
    continue;
  }
  const first = series[0]!;
  let max = series[0]!;
  for (const s of series) if (s.sumBid > max.sumBid) max = s;
  const last = series[series.length - 1]!;
  const overCost = max.sumBid > t.cost;
  const overRatio = t.cost > 0 ? ((max.sumBid / t.cost) * 100).toFixed(0) : '-';
  // 超过成本的时段（若存在）：第一次和最后一次超过的时间
  const overSpans = series.filter((s) => s.sumBid > t.cost);
  const overInfo =
    overSpans.length > 0
      ? `超成本时段: ${overSpans[0]!.t} ~ ${overSpans[overSpans.length - 1]!.t} (${overSpans.length} 次)`
      : '从未超过成本';
  console.log(
    `${overCost ? '🟢' : '🔴'} ${t.city} [${t.buckets}] 成本 ${t.cost.toFixed(2)} 平仓价 ${t.exitPrice.toFixed(2)}（${t.closedAt} UTC）\n` +
      `     持有期 ${series.length} 次采样 | 首见 ${first.t} sumBid=${first.sumBid.toFixed(2)} | 最高 ${max.sumBid.toFixed(2)}（${max.t}，成本的 ${overRatio}%）| 末见 ${last.t} sumBid=${last.sumBid.toFixed(2)} | ${overInfo}`,
  );
}
