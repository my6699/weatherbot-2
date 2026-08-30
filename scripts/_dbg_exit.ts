import fs from 'node:fs';
import path from 'node:path';

// 最小复现：复刻 findExitPrice 对 singapore_2026-08-04 的行为
const marketId = 'singapore_2026-08-04';
const entryTs = '2026-08-02T04:07:18.709Z';
const EXIT_SUM = 0.85;

const file = path.join(process.cwd(), 'data', 'price-history', `${marketId}.json`);
const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { buckets: Record<string, Array<{ t: number; p: number }>> };

const entryMs = new Date(entryTs).getTime();
console.log('entryTs', entryTs, 'entryMs', entryMs);

const s1 = raw.buckets['32-32'] ?? [];
const s2 = raw.buckets['33-33'] ?? [];
console.log('s1 len', s1.length, 's2 len', s2.length);

const p1At = new Map(s1.map((p) => [p.t, p.p]));
const p2At = new Map(s2.map((p) => [p.t, p.p]));
const times = [...new Set<number>([...s1, ...s2].map((p) => p.t))].sort((a, b) => a - b);
let found = null;
for (const t of times) {
  if (t * 1000 < entryMs) continue;
  const p1 = p1At.get(t);
  const p2 = p2At.get(t);
  if (p1 != null && p2 != null && p1 + p2 >= EXIT_SUM) {
    found = { t, sum: p1 + p2 };
    break;
  }
}
console.log('findExitPrice returned:', found);