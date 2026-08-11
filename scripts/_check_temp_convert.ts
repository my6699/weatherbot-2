// 一次性验证：seattle 08-12（°F 区间桶市场）修复后桶归属是否正确。
// 模拟生产 marketPriceFor 的中心距离匹配：对每个 config 桶找 tempC 最接近的市场行。
// 跑完即删。
import { PolymarketClient } from '../src/utils/polymarket-client.js';

const client = new PolymarketClient();

// 生产修复后的转换：区间桶取中心值
function marketTempC(q: string): { tempC: number; isLow: boolean; isHigh: boolean } | null {
  const m = q.match(/(\d+)\s*[-–]?\s*(\d+)?\s*°([CF])/);
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = m[2] ? Number(m[2]) : lo;
  const tempF = (lo + hi) / 2;
  return {
    tempC: m[3] === 'F' ? ((tempF - 32) * 5) / 9 : tempF,
    isLow: /or below/i.test(q),
    isHigh: /or higher/i.test(q),
  };
}

// seattle config 桶（1°C 步长 0..35）：label N → [N-1, N)
const configBuckets = Array.from({ length: 35 }, (_, i) => ({
  label: String(i + 1),
  min: i,
  max: i + 1,
  center: i + 0.5,
}));

const event = await client.findEventBySlug('seattle', 2026, 8, 12);
if (!event) {
  console.log('seattle 08-12 无市场');
  process.exit(0);
}
const markets = event.markets ?? [];
console.log(`=== seattle 08-12 市场数=${markets.length} ===`);

// 市场行集合（模拟 parseMarketPrices 输出）
const rows: { q: string; tempC: number; isLow: boolean; isHigh: boolean }[] = [];
for (const m of markets) {
  const q = m.question ?? '';
  const c = marketTempC(q);
  if (!c) continue;
  rows.push({ q, ...c });
}

// 对每个 config 闭合桶，模拟 marketPriceFor：找 tempC 中心距离最小的市场行
for (const b of configBuckets) {
  let best: (typeof rows)[number] | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    if (r.isLow || r.isHigh) continue;
    const d = Math.abs(r.tempC - b.center);
    if (d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  if (!best) continue;
  console.log(
    `桶 ${b.label.padStart(2)} [${b.min}-${b.max}℃] 中心${b.center} → 匹配 "${best.q.slice(35, 78)}" (tempC=${best.tempC.toFixed(2)}℃，距离${bestDist.toFixed(2)})`,
  );
}
console.log('\n验证完成');
