// 修复验证脚本（2026-08-10）：读服务器 Redis 分布 + Polymarket 实时行情，不写任何 trades。
// 推荐在服务器上运行（本地网络访问不了 Polymarket API）。
// 验证三件事：
//   1. 开放桶排除后，上海等城市是否还会选中开放桶（<=x / >=y）
//   2. trades 里是否还有"同城市同目标日期多个 open"的重复持仓
//   3. 对当前 open 持仓模拟换仓，卖旧回收 vs 买新成本是否够用（资金缺口）
// 用法：npx tsx scripts/verify-fixes.ts
import fs from 'node:fs';
import { TradingDecisionEngine } from '../src/strategies/TradingDecisionEngine.js';
import { PolymarketClient } from '../src/utils/polymarket-client.js';
import { createRedisClient, buildWeatherKey } from '../src/data/redis-config.js';
import { loadAllCityConfigs } from '../src/common/config-loader.js';

function parseRows(markets: any[]): any[] {
  const rows: any[] = [];
  for (const m of markets) {
    const q = m.question ?? '';
    const match = q.match(/(\d+)\s*°([CF])/);
    if (!match) continue;
    const temp = Number(match[1]);
    const tempC = match[2] === 'F' ? ((temp - 32) * 5) / 9 : temp;
    let yes = Number(m.bestAsk);
    if (!(yes > 0 && yes < 1)) {
      try {
        yes = Number(JSON.parse(m.outcomePrices)[0]);
      } catch {
        yes = 0;
      }
    }
    if (!(yes > 0 && yes < 1)) continue;
    rows.push({
      tempC,
      yesPrice: yes,
      bid: Number(m.bestBid) || 0,
      volumeUsd: Number(m.volume) || 0,
      isLow: /or below/i.test(q),
      isHigh: /or higher/i.test(q),
    });
  }
  return rows;
}

function priceFor(bucket: any, rows: any[]) {
  if (bucket.minTempC === null) return rows.find((r) => r.isLow) ?? null;
  if (bucket.maxTempC === null) return rows.find((r) => r.isHigh) ?? null;
  let best: any = null;
  let bd = Infinity;
  const center = (bucket.minTempC + bucket.maxTempC) / 2;
  for (const r of rows) {
    if (r.isLow || r.isHigh) continue;
    const d = Math.abs(r.tempC - center);
    if (d < bd) {
      bd = d;
      best = r;
    }
  }
  return best;
}

function buildCandidates(dist: any, markets: any[], excludeOpen: boolean) {
  const rows = parseRows(markets);
  return dist.buckets
    .filter((b: any) => b.probability > 0.15)
    .filter(
      (b: any) =>
        !excludeOpen ||
        (b.bucket.minTempC !== null && b.bucket.maxTempC !== null),
    )
    .map((b: any) => {
      const r = priceFor(b.bucket, rows);
      return {
        bucket: b.bucket,
        modelProbability: b.probability,
        yesPrice: r?.yesPrice ?? 0.5,
        noPrice: r?.noPrice ?? 0.5,
        volumeUsd: r?.volumeUsd ?? 0,
        orderBookImbalance: 0,
        spatialConfidence: 0.5,
      };
    });
}

const CITY_CN: Record<string, string> = {
  shanghai: '上海', nyc: '纽约', chicago: '芝加哥', miami: '迈阿密', dallas: '达拉斯',
  seattle: '西雅图', atlanta: '亚特兰大', london: '伦敦', paris: '巴黎', munich: '慕尼黑',
  ankara: '安卡拉', seoul: '首尔', tokyo: '东京', singapore: '新加坡', lucknow: '勒克瑙',
  'tel-aviv': '特拉维夫', toronto: '多伦多', 'sao-paulo': '圣保罗', 'buenos-aires': '布宜诺斯艾利斯',
  wellington: '惠灵顿',
};

async function main() {
  const redis = createRedisClient();
  await redis.connect();
  const cityConfigMap = new Map(loadAllCityConfigs().map((c) => [c.city, c]));
  const client = new PolymarketClient();

  const getDist = async (city: string, horizon: string) => {
    try {
      const raw = await redis.get(buildWeatherKey('weather', city as any, horizon as any));
      if (!raw) return null;
      return JSON.parse(raw).probability;
    } catch {
      return null;
    }
  };

  const cityToday = (tz: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

  const dayDiffCity = (targetDate: string, tz: string) =>
    Math.round(
      (new Date(`${targetDate}T00:00:00Z`).getTime() -
        new Date(`${cityToday(tz)}T00:00:00Z`).getTime()) /
        86400000,
    );

  const horizonOf = (targetDate: string, city: string) => {
    const cfg = cityConfigMap.get(city);
    let diff: number;
    if (cfg) {
      diff = dayDiffCity(targetDate, cfg.timezone);
    } else {
      diff = Math.round(
        (new Date(`${targetDate}T00:00:00Z`).getTime() - Date.now()) / 86400000,
      );
    }
    return `d${Math.max(0, Math.min(3, diff))}`;
  };

  // ============ 1. 开放桶排除验证（上海 08-11） ============
  console.log('===== 1. 开放桶排除验证（上海 08-11） =====');
  let shDist = await getDist('shanghai', 'd1');
  let shHorizon = 'd1';
  if (!shDist) {
    shDist = await getDist('shanghai', 'd2');
    shHorizon = 'd2';
  }
  if (shDist) {
    const event = await client.findEventBySlug('shanghai', 2026, 8, 11);
    if (event) {
      const markets = event.markets ?? [];
      const before = buildCandidates(shDist, markets, false);
      const after = buildCandidates(shDist, markets, true);
      console.log(`修复前候选（含开放桶）: ${before.map((c: any) => c.bucket.label + '@' + c.yesPrice.toFixed(2)).join(', ') || '无'}`);
      console.log(`修复后候选（排除开放桶）: ${after.map((c: any) => c.bucket.label + '@' + c.yesPrice.toFixed(2)).join(', ') || '无'}`);
      const engine = new TradingDecisionEngine(cityConfigMap.get('shanghai')!);
      const dec = after.length
        ? engine.decide({ city: 'shanghai', horizon: shHorizon as any, distribution: shDist, candidates: after, tradingMode: 'paper' })
        : null;
      console.log(
        dec
          ? `修复后选桶: ${dec.buckets.map((b) => b.label).join('+')}（成本 ${dec.entryPrice.toFixed(2)}）`
          : '修复后无交易（候选为空或 edge 不足）',
      );
    } else {
      console.log('未找到上海 08-11 市场');
    }
  } else {
    console.log('Redis 无 shanghai d1/d2 分布');
  }
  console.log('');

  // ============ 2. 重复开仓检查 ============
  console.log('===== 2. 重复开仓检查（同城市同目标日期多个 open） =====');
  const dupes: string[] = [];
  const seen = new Map<string, string[]>();
  for (const f of fs.readdirSync('data').filter((x) => /^trades-.*\.json$/.test(x))) {
    const city = f.replace('trades-', '').replace('.json', '');
    const arr = JSON.parse(fs.readFileSync(`data/${f}`, 'utf8'));
    for (const t of arr) {
      if (t.status !== 'open' || !t.targetDate) continue;
      const k = `${city}|${t.targetDate}`;
      if (!seen.has(k)) seen.set(k, []);
      seen.get(k)!.push(t.id);
    }
  }
  for (const [k, ids] of seen) {
    if (ids.length > 1) dupes.push(`${k} → ${ids.length} 笔`);
  }
  console.log(dupes.length ? `发现重复: ${dupes.join('; ')}` : '无重复开仓 ✓');
  console.log('');

  // ============ 3. 换仓资金缺口检查 ============
  console.log('===== 3. 换仓资金检查（卖旧回收 vs 买新成本） =====');
  const THRESHOLD = 0.3;
  let triggered = 0;
  let deficit = 0;
  for (const f of fs.readdirSync('data').filter((x) => /^trades-.*\.json$/.test(x))) {
    const city = f.replace('trades-', '').replace('.json', '');
    const arr = JSON.parse(fs.readFileSync(`data/${f}`, 'utf8'));
    for (const t of arr) {
      if (t.status !== 'open' || !t.targetDate) continue;
      const horizon = horizonOf(t.targetDate, city);
      const dist = await getDist(city, horizon);
      if (!dist) continue;
      const curKeys: string[] = t.switched && t.switchKeys?.length ? t.switchKeys : t.buckets;
      const oldPSum = dist.buckets
        .filter((b: any) => curKeys.includes(b.bucket.label))
        .reduce((s: number, b: any) => s + b.probability, 0);
      if (oldPSum > THRESHOLD) continue;
      const [y, m, d] = t.targetDate.split('-').map(Number);
      const event = await client.findEventBySlug(city, y, m, d);
      if (!event) continue;
      const markets = event.markets ?? [];
      const rows = parseRows(markets);
      const sell = curKeys
        .map((k) => {
          const b = dist.buckets.find((x: any) => x.bucket.label === k)?.bucket;
          if (!b) return 0;
          return priceFor(b, rows)?.bid ?? priceFor(b, rows)?.yesPrice ?? 0;
        })
        .reduce((s: number, x: number) => s + x, 0);
      const candidates = buildCandidates(dist, markets, true);
      const engine = new TradingDecisionEngine(cityConfigMap.get(city)!);
      const dec = candidates.length
        ? engine.decide({ city, horizon: horizon as any, distribution: dist, candidates, tradingMode: 'paper' })
        : null;
      if (!dec) continue;
      const newKeys = dec.buckets.map((b) => b.label);
      const same =
        newKeys.length === curKeys.length && newKeys.every((k, i) => k === curKeys[i]);
      if (same) continue;
      const buy = newKeys
        .map((k) => {
          const b = dist.buckets.find((x: any) => x.bucket.label === k)?.bucket;
          if (!b) return 0;
          return priceFor(b, rows)?.yesPrice ?? 0;
        })
        .reduce((s: number, x: number) => s + x, 0);
      triggered++;
      const gap = buy - sell;
      if (gap > 0.001) deficit++;
      console.log(
        `[${CITY_CN[city] ?? city}] 换 ${curKeys.join('+')} → ${newKeys.join('+')} | 卖旧 $${sell.toFixed(2)} 买新 $${buy.toFixed(2)} | 缺口 ${gap >= 0 ? '+' : ''}${gap.toFixed(2)} ${gap > 0.001 ? '⚠️ 不够' : '✓ 够'}`,
      );
    }
  }
  console.log(`触发换仓 ${triggered} 笔，其中资金不够 ${deficit} 笔`);
  await redis.quit();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
