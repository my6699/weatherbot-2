// 实时持仓浮盈亏监控：逐笔拉 Gamma 实时 bid，算当前市值与浮盈亏，
// 并对照凯利模型期望（reason 解析模型概率，f* 与 5 股判定该笔是否"凯利可开"）。
// 运行（服务器）：npx tsx scripts/holdings-pnl.ts

import 'dotenv/config';
import { readAllTrades } from '../src/utils/trade-recorder.js';
import { PolymarketClient } from '../src/utils/polymarket-client.js';
import type { GammaMarket } from '../src/utils/polymarket-client.js';
import type { TradeRecord } from '../src/common/types.js';
import { parseMarketQuestion } from '../src/utils/market-buckets.js';

const CITY_CN: Record<string, string> = {
  shanghai: '上海', nyc: '纽约', chicago: '芝加哥', miami: '迈阿密', dallas: '达拉斯',
  seattle: '西雅图', atlanta: '亚特兰大', london: '伦敦', paris: '巴黎', munich: '慕尼黑',
  ankara: '安卡拉', seoul: '首尔', tokyo: '东京', singapore: '新加坡', lucknow: '勒克瑙',
  'tel-aviv': '特拉维夫', toronto: '多伦多', 'sao-paulo': '圣保罗',
  'buenos-aires': '布宜诺斯艾利斯', wellington: '惠灵顿',
};

function parseOutcome(raw?: string): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return Number(parsed[0]) || 0;
  } catch { /* ignore */ }
  return 0;
}

function marketBid(m: GammaMarket): number {
  return Number(m.bestBid) || parseOutcome(m.outcomePrices);
}

function matchBucketBid(
  markets: GammaMarket[],
  bucketLabel: string,
  bounds?: { minTempC: number | null; maxTempC: number | null } | null,
): number | null {
  if (bounds) {
    for (const m of markets) {
      const parsed = parseMarketQuestion(m.question ?? '');
      if (!parsed) continue;
      const b = parsed.bucket;
      const same =
        bounds.minTempC === null
          ? b.minTempC === null && Math.abs((b.maxTempC ?? 0) - (bounds.maxTempC ?? 0)) < 0.01
          : bounds.maxTempC === null
            ? b.maxTempC === null && Math.abs((b.minTempC ?? 0) - (bounds.minTempC ?? 0)) < 0.01
            : b.minTempC !== null && b.maxTempC !== null &&
              Math.abs(b.minTempC - bounds.minTempC) < 0.01 &&
              Math.abs(b.maxTempC - bounds.maxTempC) < 0.01;
      if (same) return marketBid(m);
    }
    return null;
  }
  const low = bucketLabel.startsWith('<=');
  const high = bucketLabel.startsWith('>=');
  const numC = Number(bucketLabel.replace(/[^\d.-]/g, ''));
  let best: GammaMarket | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const m of markets) {
    const q = m.question ?? '';
    const mm = q.match(/(\d+)\s*[-–]?\s*(\d+)?\s*°([CF])/);
    if (!mm) continue;
    const isF = mm[3] === 'F';
    const lo = Number(mm[1]);
    const hi = mm[2] ? Number(mm[2]) : lo;
    const tempF = (lo + hi) / 2;
    const tempC = isF ? ((tempF - 32) * 5) / 9 : tempF;
    const isLow = /or below/i.test(q);
    const isHigh = /or higher/i.test(q);
    if (low && isLow) return marketBid(m);
    if (high && isHigh) return marketBid(m);
    if (low || high) continue;
    const d = Math.abs(tempC - numC);
    if (d < bestD) { bestD = d; best = m; }
  }
  if (!best || bestD > 2) return null;
  return marketBid(best);
}

/** 从 reason 解析模型总概率（与 backtest-holdings-kelly 同一套）。 */
function parseProb(reason: string | undefined, n: number): number | null {
  const r = reason ?? '';
  const pair = /区间概率\s*(\d+)%/.exec(r);
  if (pair) return Number(pair[1]) / 100;
  const model = /模型\s*(\d+)%/.exec(r);
  if (model) return Number(model[1]) / 100;
  return null;
}

function rawKellyFraction(n: number, p: number, c: number): number {
  const denom = n - c;
  return denom > 0 ? (n * p - c) / denom : 0;
}

interface Row {
  city: string;
  keys: string;
  target: string;
  basePrice: number;
  sizeUsd: number;
  sumBid: number | null;
  curValue: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  p: number | null;
  kellyOk: boolean; // 凯利口径可开（f*>0 且 5×c 可满足）
  note: string;
}

async function main(): Promise<void> {
  const all = readAllTrades();
  const holdings = all.filter((t) => t.status === 'open');
  const client = new PolymarketClient();
  const rows: Row[] = [];

  for (const t of holdings) {
    const isSwitched = !!t.switched && !!t.switchKeys?.length;
    const holdKeys = isSwitched ? t.switchKeys! : t.buckets;
    const holdBounds = isSwitched ? t.switchBucketBounds : t.bucketBounds;
    const basePrice = isSwitched && t.switchBuy ? t.switchBuy : t.entryPrice;

    let sumBid: number | null = null;
    try {
      if (t.targetDate) {
        const [y, m, d] = t.targetDate.split('-').map(Number);
        const event = await client.findEventBySlug(t.city, y!, m!, d!);
        if (event) {
          const markets = event.markets ?? [];
          const bids = holdKeys
            .map((label, i) => matchBucketBid(markets, label, holdBounds?.[i]))
            .filter((b): b is number => b !== null && b > 0);
          if (bids.length === holdKeys.length) sumBid = bids.reduce((a, b) => a + b, 0);
        }
      }
    } catch { sumBid = null; }

    const curValue = sumBid !== null && basePrice > 0 ? (t.sizeUsd * sumBid) / basePrice : null;
    const pnlUsd = curValue !== null ? curValue - t.sizeUsd : null;
    const pnlPct = sumBid !== null && basePrice > 0 ? (sumBid - basePrice) / basePrice : null;

    const n = Math.max(holdKeys.length, 1);
    const p = parseProb(t.reason, n);
    const f = p != null ? rawKellyFraction(n, p, basePrice) : 0;
    const kellyOk = p != null && f > 0 && 5 * basePrice <= Math.min(100 * f * 0.25, 30);

    let note = '';
    if (isSwitched) note = '已换仓';
    if (basePrice < 0.05) note += (note ? '，' : '') + '⚠️成本异常';
    if (p != null && f <= 0) note += (note ? '，' : '') + '凯利f*≤0';

    rows.push({
      city: CITY_CN[t.city] ?? t.city,
      keys: holdKeys.join('+'),
      target: t.targetDate ? t.targetDate.slice(5) : '—',
      basePrice,
      sizeUsd: t.sizeUsd,
      sumBid,
      curValue,
      pnlUsd,
      pnlPct,
      p,
      kellyOk,
      note,
    });
  }

  console.log('\n===== 实时持仓浮盈亏（' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '） =====');
  console.log(`持仓 ${holdings.length} 笔（凯利口径可开 ${rows.filter((r) => r.kellyOk).length} 笔）\n`);

  const header = ['城市', '桶对', '目标', '成本', '实时bid', '浮盈亏', '浮盈%', '模型p', '凯利可开', '备注'];
  const data = rows.map((r) => [
    r.city,
    r.keys,
    r.target,
    r.basePrice.toFixed(3),
    r.sumBid != null ? r.sumBid.toFixed(3) : '—',
    r.pnlUsd != null ? `${r.pnlUsd >= 0 ? '+' : ''}$${r.pnlUsd.toFixed(2)}` : '—',
    r.pnlPct != null ? `${(r.pnlPct * 100).toFixed(1)}%` : '—',
    r.p != null ? `${(r.p * 100).toFixed(0)}%` : '?',
    r.kellyOk ? '✅' : (r.p == null ? '?' : ''),
    r.note,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((r) => r[i]!.length)));
  const fmt = (cells: string[]) => cells.map((x, i) => x.padEnd(widths[i]!)).join(' | ');
  console.log(fmt(header));
  console.log('-'.repeat(widths.reduce((a, b) => a + b, 0) + (widths.length - 1) * 3));
  for (const r of data) console.log(fmt(r));

  const withVal = rows.filter((r) => r.curValue != null);
  const costTotal = rows.reduce((s, r) => s + r.sizeUsd, 0);
  const valueTotal = withVal.reduce((s, r) => s + (r.curValue ?? 0), 0);
  const pnlTotal = valueTotal - costTotal;
  console.log('\n===== 汇总 =====');
  console.log(`买入成本合计：$${costTotal.toFixed(2)}`);
  console.log(`当前市值合计：$${valueTotal.toFixed(2)}（${withVal.length}/${rows.length} 笔有实时价）`);
  console.log(`浮盈亏：${pnlTotal >= 0 ? '+' : ''}$${pnlTotal.toFixed(2)}（${((pnlTotal / Math.max(costTotal, 0.0001)) * 100).toFixed(1)}%）`);
  console.log('\n说明：实时浮盈亏是市场当前定价，结算/离场才落地；凯利可开列是模型期望口径（f*>0 且 ≥5股）。');
}

main().catch((err) => {
  console.error('监控失败：', err);
  process.exit(1);
});
