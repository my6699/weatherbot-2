// 这个脚本从 Polymarket API 补拉已结算市场的逐桶 YES 价格历史，
// 解决模拟回测"只有 top1/top2 快照、拿不到全量逐桶价格"的数据缺口。
//
// 流程：
//   1. 读旧项目 data/markets/ 下的 <city>_*.json（status == resolved）
//   2. 每个 all_outcomes 桶：gamma /markets/{market_id} → clobTokenIds 取 YES token
//   3. clob /prices-history?market={token}&interval=max&fidelity=60 → 逐小时价格曲线
//   4. 存到 weather-2 的 data/price-history/<city>_<date>.json
//
// 运行方式（在 weather-bot 目录下）：
//   npx tsx scripts/fetch-price-history.ts            # 默认只抓 shanghai
//   npx tsx scripts/fetch-price-history.ts nyc london # 指定城市（可选）
//
// 注意：使用 undici 配合系统代理（UWP/注册表代理），与旧项目 http.ts 相同机制。

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fetch, ProxyAgent, type Dispatcher } from 'undici';

const OLD_DATA_DIR = path.resolve(
  process.cwd(),
  '..', '..', 'weather-bot', 'polymarket-weather-bot', 'data', 'markets',
);
const OUT_DIR = path.resolve(process.cwd(), 'data', 'price-history');

const REQ_GAP_MS = 150; // 请求间隔，避免触发限流

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ==================== 系统代理检测（与旧项目 http.ts 相同） ====================

function detectProxy(): string | null {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const v = process.env[key];
    if (v) return v;
  }
  try {
    const reg = execSync(
      `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (/0x1/.test(reg)) {
      const server = execSync(
        `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const m = server.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
      if (m?.[1]) {
        const p = m[1]!.trim();
        if (p.startsWith('http://') || p.startsWith('https://') || p.startsWith('socks')) return p;
        return `http://${p}`;
      }
    }
  } catch {
    /* no registry proxy */
  }
  return null;
}

let proxyAgent: Dispatcher | null = null;

function getDispatcher(): Dispatcher | undefined {
  if (proxyAgent) return proxyAgent;
  const proxy = detectProxy();
  if (!proxy) return undefined;
  try {
    proxyAgent = new ProxyAgent(proxy);
    return proxyAgent;
  } catch {
    return undefined;
  }
}

// ==================== HTTP 请求 ====================

async function fetchJson<T>(url: string, retries = 3): Promise<T | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        dispatcher: getDispatcher(),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' },
      });
      if (!res.ok) {
        if (res.status === 404) return null;
        await sleep(500 * (i + 1));
        continue;
      }
      return (await res.json()) as T;
    } catch {
      await sleep(800 * (i + 1));
    }
  }
  return null;
}

// ==================== 旧数据映射 ====================

// 通用桶 key（不分摄氏度/华氏度，直接按 range 数值）：
//   -999-28 → "<=28"；28-999 → ">=28"；31-31 → "31-31"；82-83 → "82-83"
// 摄氏城市的 label（31-36、<=30、>=37）能与此格式对应（31 → "31-31"）。
function bucketKey(lo: number, hi: number): string {
  if (lo <= -900) return `<=${hi}`;
  if (hi >= 900) return `>=${lo}`;
  return `${lo}-${hi}`;
}

interface OldMarketFile {
  city: string;
  date: string;
  status: string;
  all_outcomes?: Array<{
    market_id: string;
    range: [number, number];
  }>;
}

interface GammaMarket {
  clobTokenIds?: string;
}

interface PriceHistoryResp {
  history?: Array<{ t: number; p: number }>;
}

// ==================== API 调用 ====================

/** gamma /markets/{id} → YES token（clobTokenIds[0]）。 */
async function getYesToken(marketId: string): Promise<string | null> {
  const m = await fetchJson<GammaMarket>(`https://gamma-api.polymarket.com/markets/${marketId}`);
  if (!m?.clobTokenIds) return null;
  try {
    const ids = JSON.parse(m.clobTokenIds) as string[];
    return ids[0] ?? null;
  } catch {
    return null;
  }
}

/** clob /prices-history → 逐小时 [{t, p}]（t 为 Unix 秒）。 */
async function getPriceHistory(token: string): Promise<Array<{ t: number; p: number }>> {
  const r = await fetchJson<PriceHistoryResp>(
    `https://clob.polymarket.com/prices-history?market=${token}&interval=max&fidelity=60`,
  );
  return r?.history ?? [];
}

// ==================== 主逻辑 ====================

async function main(): Promise<void> {
  const cityFilter = new Set(process.argv.slice(2));
  if (cityFilter.size === 0) cityFilter.add('shanghai');

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = fs
    .readdirSync(OLD_DATA_DIR)
    .filter((f) => f.endsWith('.json') && cityFilter.has(f.split('_')[0] ?? ''));
  files.sort();

  let okCount = 0;
  let skipCount = 0;
  let bucketCount = 0;

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(OLD_DATA_DIR, file), 'utf8')) as OldMarketFile;
    if (raw.status !== 'resolved') {
      skipCount += 1;
      continue;
    }
    if (!raw.all_outcomes || raw.all_outcomes.length === 0) {
      skipCount += 1;
      continue;
    }

    const fileLabel = `${raw.city}_${raw.date}`;
    const buckets: Record<string, Array<{ t: number; p: number }>> = {};

    for (const outcome of raw.all_outcomes) {
      const key = bucketKey(outcome.range[0], outcome.range[1]);
      if (!outcome.market_id) continue;

      console.log(`  [FETCH] ${fileLabel} 桶 ${key}（market ${outcome.market_id}）`);
      const token = await getYesToken(outcome.market_id);
      await sleep(REQ_GAP_MS);
      if (!token) {
        console.warn(`  [SKIP] ${fileLabel} 桶 ${key}：拿不到 YES token`);
        continue;
      }
      const history = await getPriceHistory(token);
      await sleep(REQ_GAP_MS);
      if (history.length === 0) {
        console.warn(`  [SKIP] ${fileLabel} 桶 ${key}：价格历史为空`);
        continue;
      }
      buckets[key] = history;
      bucketCount += 1;
    }

    if (Object.keys(buckets).length === 0) {
      console.warn(`  [SKIP] ${fileLabel}：所有桶都拿不到价格历史`);
      skipCount += 1;
      continue;
    }

    const outFile = path.join(OUT_DIR, `${raw.city}_${raw.date}.json`);
    fs.writeFileSync(
      outFile,
      JSON.stringify({ city: raw.city, date: raw.date, buckets }, null, 2),
      'utf8',
    );
    console.log(`  [OK] ${outFile}（${Object.keys(buckets).length} 个桶）`);
    okCount += 1;
  }

  console.log(`完成：成功 ${okCount} 个市场 / 跳过 ${skipCount} 个 / 共 ${bucketCount} 个桶价格曲线`);
}

main().catch((error) => {
  console.error('抓取失败', error);
  process.exit(1);
});