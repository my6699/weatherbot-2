// 临时验证脚本：以凯利动态投注模式回测"目前持仓"（status=open 的 trades）。
// 运行：npx tsx scripts/backtest-holdings-kelly.ts
//
// 两个视角：
//   1. 静态：每笔独立按"初始 bankroll=100"算凯利 sizeUsd（不收敛 → 合计会超资金池）
//   2. 重放（收敛）：按 openedAt 时序逐笔重放，每笔用"当前剩余 bankroll"算 sizeUsd，
//      买入后 bankroll 递减 —— 模拟生产代码的全局余额保护，验证总敞口收敛 ≤ 资金池。
//
// 对每笔 open 持仓：
//   从 reason 解析模型概率 p（双桶=区间概率，单桶=模型概率）；成本 c = entryPrice。
//   凯利 f* = (N×p − c) / (N − c)，sizeUsd = min(bankroll × f* × 0.25, 30)，
//   f* ≤ 0 → 不开仓；sizeUsd < 5×c（不足 5 股）→ 不开仓。

import fs from 'node:fs';
import path from 'node:path';

const TRADES_DIR = path.resolve(process.cwd(), 'data');
const BANKROLL_USD = Number(process.env.BANKROLL_USD ?? '100');
const KELLY_FRACTION = Number(process.env.KELLY_FRACTION ?? '0.25');
const MAX_POSITION_USD = 30; // 与 config/*.json 的 maxPositionUsd 一致
const MIN_SHARES = 5; // CLOB 最小下单股数

interface Trade {
  id: string;
  city: string;
  horizon?: string;
  buckets?: string[];
  entryPrice: number;
  sizeUsd: number;
  side: string;
  status: string;
  targetDate?: string;
  openedAt?: string;
  exitPrice?: number | null;
  reason?: string;
}

interface Parsed {
  p: number | null; // 模型总概率
  nBuckets: number;
  c: number; // 买入总成本
  source: string;
}

// 从 reason 解析模型概率：
//   单桶："选中桶 31（模型 19%，市场 38%...）"
//   双桶："选中相邻桶 32-33C+33-34C（区间概率 62%，买入成本 60%）"
function parseProb(t: Trade): Parsed {
  const nBuckets = t.buckets && t.buckets.length >= 2 ? 2 : 1;
  const c = t.entryPrice;
  const reason = t.reason ?? '';

  const pairMatch = /区间概率\s*(\d+)%/.exec(reason);
  if (pairMatch) {
    return { p: Number(pairMatch[1]) / 100, nBuckets: 2, c, source: 'reason-区间概率' };
  }
  const modelMatch = /模型\s*(\d+)%/.exec(reason);
  if (modelMatch) {
    return { p: Number(modelMatch[1]) / 100, nBuckets, c, source: 'reason-模型' };
  }
  return { p: null, nBuckets, c, source: 'reason-未解析' };
}

function rawKellyFraction(p: number, nBuckets: number, c: number): number {
  const denom = nBuckets - c;
  return denom > 0 ? (nBuckets * p - c) / denom : 0;
}

function main(): void {
  const files = fs.readdirSync(TRADES_DIR).filter((f) => f.startsWith('trades-') && f.endsWith('.json'));
  const opens: Array<{ trade: Trade; parsed: Parsed }> = [];

  for (const file of files) {
    const trades = JSON.parse(fs.readFileSync(path.join(TRADES_DIR, file), 'utf8')) as Trade[];
    for (const t of trades) {
      if (t.status !== 'open') continue;
      opens.push({ trade: t, parsed: parseProb(t) });
    }
  }

  console.log('=== 目前持仓（status=open）凯利模式回测 ===');
  console.log(`参数：初始资金池=${BANKROLL_USD}U, 凯利系数=${KELLY_FRACTION}, 单笔上限=${MAX_POSITION_USD}U, 最小=${MIN_SHARES}股\n`);

  if (opens.length === 0) {
    console.log('没有 open 持仓。');
    return;
  }

  // ============ 1. 静态：每笔按初始 bankroll 独立算（不收敛） ============
  const staticTotal = opens.reduce((s, { trade: t, parsed }) => {
    if (parsed.p == null) return s;
    const f = rawKellyFraction(parsed.p, parsed.nBuckets, parsed.c);
    if (f <= 0) return s;
    return s + Math.min(BANKROLL_USD * f * KELLY_FRACTION, MAX_POSITION_USD);
  }, 0);

  // ============ 2. 重放：按 openedAt 时序，bankroll 逐笔递减（收敛） ============
  const sorted = [...opens].sort(
    (a, b) =>
      new Date(a.trade.openedAt ?? 0).getTime() - new Date(b.trade.openedAt ?? 0).getTime(),
  );

  let bankroll = BANKROLL_USD;
  let totalInvested = 0;
  let blocked = 0; // f*≤0 拦截
  let skippedMin = 0; // 不足 5 股跳过
  let skippedUnparsed = 0;

  interface ReplayRow {
    seq: number;
    city: string;
    bucket: string;
    openedAt: string;
    c: number;
    p: number | null;
    f: number;
    sizeUsd: number;
    cumInvested: number;
    remaining: number;
    note: string;
  }
  const rows: ReplayRow[] = [];

  for (const { trade: t, parsed } of sorted) {
    const bucketStr = t.buckets?.join('+') ?? '?';
    const c = parsed.c;

    if (parsed.p == null) {
      skippedUnparsed += 1;
      rows.push({
        seq: rows.length + 1, city: t.city, bucket: bucketStr,
        openedAt: t.openedAt ?? '?', c, p: null, f: 0, sizeUsd: 0,
        cumInvested: totalInvested, remaining: bankroll, note: 'p未解析',
      });
      continue;
    }
    const p = parsed.p;
    const f = rawKellyFraction(p, parsed.nBuckets, c);
    if (f <= 0) {
      blocked += 1;
      rows.push({
        seq: rows.length + 1, city: t.city, bucket: bucketStr,
        openedAt: t.openedAt ?? '?', c, p, f, sizeUsd: 0,
        cumInvested: totalInvested, remaining: bankroll, note: 'f*≤0 拦截（负期望）',
      });
      continue;
    }

    const sizeUsd = Math.min(bankroll * f * KELLY_FRACTION, MAX_POSITION_USD);
    const minOrderUsd = MIN_SHARES * c;
    if (sizeUsd < minOrderUsd) {
      skippedMin += 1;
      rows.push({
        seq: rows.length + 1, city: t.city, bucket: bucketStr,
        openedAt: t.openedAt ?? '?', c, p, f, sizeUsd: 0,
        cumInvested: totalInvested, remaining: bankroll,
        note: `资金不足 5 股（需≥${minOrderUsd.toFixed(1)}U，只剩${bankroll.toFixed(1)}U 算出${sizeUsd.toFixed(1)}U）`,
      });
      continue;
    }

    bankroll -= sizeUsd;
    totalInvested += sizeUsd;
    rows.push({
      seq: rows.length + 1, city: t.city, bucket: bucketStr,
      openedAt: t.openedAt ?? '?', c, p, f, sizeUsd,
      cumInvested: totalInvested, remaining: bankroll, note: '',
    });
  }

  // 输出表
  const header = ['序', '城市', '桶', '开仓时间', '成本', '模型p', 'f*', '凯利投入', '累计投入', '剩余资金', '备注'];
  const data = rows.map((r) => [
    String(r.seq),
    r.city,
    r.bucket,
    (r.openedAt ?? '').slice(5, 16),
    r.c.toFixed(3),
    r.p != null ? `${(r.p * 100).toFixed(0)}%` : '?',
    r.p != null ? r.f.toFixed(3) : '—',
    r.sizeUsd > 0 ? r.sizeUsd.toFixed(1) : '不开',
    r.cumInvested.toFixed(1),
    r.remaining.toFixed(1),
    r.note,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((r) => r[i]!.length)));
  const fmt = (cells: string[]) => cells.map((x, i) => x.padEnd(widths[i]!)).join(' | ');
  console.log(fmt(header));
  console.log('-'.repeat(widths.reduce((a, b) => a + b, 0) + (widths.length - 1) * 3));
  for (const r of data) console.log(fmt(r));

  // 汇总
  const origTotal = opens.reduce((s, { trade: t }) => s + t.sizeUsd, 0);
  console.log('\n=== 汇总 ===');
  console.log(`open 持仓 ${opens.length} 笔，原固定投入合计 ${origTotal}U`);
  console.log(`静态凯利（每笔按初始 ${BANKROLL_USD}U 算，不递减）：${staticTotal.toFixed(1)}U  ← 会超资金池`);
  console.log(`重放收敛（bankroll 逐笔递减）：${totalInvested.toFixed(1)}U，剩余 ${bankroll.toFixed(1)}U`);
  console.log(`  → 总敞口 ${totalInvested.toFixed(1)}U ${totalInvested <= BANKROLL_USD + 0.01 ? '≤ 100U ✅ 已收敛' : '> 100U ❌ 未收敛'}`);
  console.log(`  → 拦 f*≤0：${blocked} 笔；资金不足 5 股：${skippedMin} 笔；p 未解析：${skippedUnparsed} 笔`);

  if (blocked > 0 || skippedMin > 0) {
    console.log('\n说明：被拦截/跳过的持仓 = 该笔按模型与成本无正期望，或资金已耗尽，凯利判定不该投。');
  }
}

main();
