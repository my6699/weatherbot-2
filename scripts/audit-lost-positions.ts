// 审计：原生单位改造前失联持仓（无 bucketBounds）与 Gamma 真实桶的映射，
// 判断能否安全补边界恢复监控（恢复后止损/换仓/结算口径会切到原生桶）。
import fs from 'node:fs';
import path from 'node:path';
import { PolymarketClient } from '../src/utils/polymarket-client.js';
import { parseMarketQuestion } from '../src/utils/market-buckets.js';

const CITIES = ['nyc', 'seattle', 'chicago', 'toronto'];

const client = new PolymarketClient();

for (const city of CITIES) {
  const file = path.join('data', `trades-${city}.json`);
  if (!fs.existsSync(file)) continue;
  const trades = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
  const lost = trades.filter((t) => t.status === 'open' && !t.bucketBounds);
  if (lost.length === 0) {
    console.log(`\n[${city}] 无失联持仓`);
    continue;
  }
  console.log(`\n[${city}] 失联持仓 ${lost.length} 笔：`);
  for (const t of lost) {
    const targetDate = t.targetDate as string;
    const [y, m, d] = targetDate.split('-').map(Number);
    let realLabels: string[] = [];
    try {
      const event = await client.findEventBySlug(city, y!, m!, d!);
      realLabels = ((event?.markets ?? []) as Array<{ question: string }>)
        .map((mk) => parseMarketQuestion(mk.question)?.label)
        .filter((x): x is string => Boolean(x));
    } catch (e) {
      realLabels = [`拉取失败: ${(e as Error).message}`];
    }
    const oldLabels = (t.switched && (t.switchKeys as string[])?.length
      ? t.switchKeys
      : t.buckets) as string[];
    // 匹配判定：旧标签去空格后与真实桶互为前缀或完全相等（容忍 "32" vs "32C" / "32-33C" 差异）。
    const inReal = oldLabels.every((lb) =>
      realLabels.some((r) => {
        const a = lb.replace(/\s/g, '');
        const b = r.replace(/\s/g, '');
        return a === b || a.startsWith(b) || b.startsWith(a);
      }),
    );
    console.log(
      `  目标日 ${targetDate} 旧桶 [${oldLabels.join(', ')}] 成本 ${t.entryPrice ?? t.switchBuy} 规模 $${t.sizeUsd} → Gamma 真实桶 [${realLabels.join(', ')}] 匹配: ${inReal ? '✅' : '❌'}`,
    );
  }
}
