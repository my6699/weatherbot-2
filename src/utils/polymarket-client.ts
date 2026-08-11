// 这个文件负责对接 Polymarket 的市场数据接口。
//
// 当前阶段是 paper trading，所以这里专注"读取市场数据"，不涉及真实下单：
//   1. 发现指定日期的上海温度市场。
//   2. 读取每个温度桶的 YES/NO 价格、成交量。
//   3. 读取订单簿深度，计算"订单簿失衡"，用于 TradingDecisionEngine 的情绪因子。
//
// 注意：真实下单的功能放在后续 live 模式才接入的模块里，
// 这套客户端保持只读，降低纸面交易阶段的复杂度。

import { execSync } from 'child_process';
import type { MarketSnapshot, TemperatureBucket } from '../common/types.js';

const GAMMA_API_BASE =
  process.env.POLYMARKET_GAMMA_API_URL ?? 'https://gamma-api.polymarket.com';

// ---------------------------------------------------------------------------
// HTTP 代理探测（复用旧项目验证过的逻辑）：
// Polymarket API 需要非美国 IP 才能稳定访问。国内/受限网络下通常靠
// 系统代理（127.0.0.1:10808 之类的 v2ray/clash）出网。
// 顺序：HTTPS_PROXY/HTTP_PROXY 环境变量 -> Windows 注册表系统代理。
// 生产 VPS 无代理时返回 null，直接直连。
// ---------------------------------------------------------------------------
function detectProxy(): string | null {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const v = process.env[key];
    if (v && v.length > 0) return v;
  }
  if (process.platform === 'win32') {
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
  }
  return null;
}

// 使用 Node.js 20+ 内置 fetch，避免依赖 undici（其版本与 Node 18/20 有兼容问题）。
import type { Dispatcher } from 'undici';

let proxyAgent: Dispatcher | null = null;

async function getProxyAgent(): Promise<Dispatcher | null> {
  const proxy = detectProxy();
  if (!proxy) return null;
  // 只有探测到代理才动态加载 undici（本地开发 Windows 代理场景），服务器直连不需要。
  if (proxyAgent) return proxyAgent;
  try {
    const { ProxyAgent } = await import('undici');
    proxyAgent = new ProxyAgent(proxy) as Dispatcher;
    return proxyAgent;
  } catch {
    return null;
  }
}

async function requestJson<T>(url: string, timeoutMs: number): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const opts: Record<string, unknown> = {
      signal: ac.signal,
      headers: { Accept: 'application/json' },
    };
    const agent = await getProxyAgent();
    if (agent) {
      // 有代理时用 undici 自身的 fetch + ProxyAgent（同一份 undici）。
      // 不能把外部 undici 的 ProxyAgent 传给 Node 内置 fetch：Node 25 内置 undici
      // 与 node_modules 的 undici 是两份实现，dispatcher 校验不兼容
      // （InvalidArgumentError: invalid onRequestStart method），代理请求必失败。
      const { fetch: undiciFetch } = await import('undici');
      const res = await undiciFetch(url, { ...opts, dispatcher: agent });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    }
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// Slug 里的月份用全称（旧项目生产验证过，例如 aug 缩写在 Gamma API 查不到）：
//   highest-temperature-in-shanghai-on-august-7-2026
const MONTHS_FULL = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

export interface GammaMarket {
  id?: string | number;
  question?: string;
  outcomePrices?: string;
  bestAsk?: number | string;
  bestBid?: number | string;
  volume?: number | string;
  clobTokenIds?: string;
}

export interface GammaEvent {
  id?: string;
  endDate?: string;
  markets?: GammaMarket[];
}

function safeNum(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

export class PolymarketClient {
  constructor(
    private readonly apiBase: string = GAMMA_API_BASE,
    private readonly timeoutMs = 10_000,
  ) {}

  /**
   * 通过标准 slug 查找指定城市、指定日期的温度市场事件。
   *
   * Polymarket 的温度市场 slug 格式：
   *   highest-temperature-in-<citySlug>-on-<month>-<day>-<year>
   *
   * 例如：highest-temperature-in-shanghai-on-aug-7-2026
   */
  async findEventBySlug(
    citySlug: string,
    year: number,
    month: number, // 1-12
    day: number,
  ): Promise<GammaEvent | null> {
    const monthName = MONTHS_FULL[month - 1];
    if (!monthName) return null;

    const slug = `highest-temperature-in-${citySlug}-on-${monthName}-${day}-${year}`;

    try {
      const events = await requestJson<GammaEvent[]>(
        `${this.apiBase}/events?slug=${encodeURIComponent(slug)}`,
        this.timeoutMs,
      );
      if (Array.isArray(events) && events.length > 0) {
        return events[0] ?? null;
      }
      return null;
    } catch {
      // 网络失败返回 null，由调用方决定是否降权或告警。
      return null;
    }
  }

  /**
   * 读取某个市场的最新快照（YES/NO 价格、成交量、买卖报价）。
   *
   * 返回的 bucket 字段需要调用方自行填充（这里只填 marketId 和价格数据）。
   */
  async fetchMarketSnapshot(market: GammaMarket): Promise<MarketSnapshot | null> {
    const marketId = String(market.id ?? '');
    if (!marketId) return null;

    try {
      const data = await requestJson<{
        outcomePrices?: string;
        bestAsk?: number | string;
        bestBid?: number | string;
        volume?: number | string;
        clobTokenIds?: string;
      }>(`${this.apiBase}/markets/${marketId}`, this.timeoutMs);

      // 优先用 detail 接口的 outcomePrices，没有再用列表里的 market.outcomePrices。
      const pricesRaw = parseOutcomePrices(data.outcomePrices ?? market.outcomePrices);
      const yesPrice = pricesRaw[0] ?? 0.5;
      const noPrice = pricesRaw[1] ?? 1 - yesPrice;

      // 有 bestAsk/bestBid 时优先使用（市场快照更实时）。
      const bestAsk = safeNum(data.bestAsk ?? market.bestAsk);
      const bestBid = safeNum(data.bestBid ?? market.bestBid);

      const snapshot: MarketSnapshot = {
        marketId,
        city: 'shanghai', // 调用方可以覆盖
        targetDate: '', // 调用方可以覆盖
        bucket: { label: '', minTempC: null, maxTempC: null }, // 调用方可以覆盖
        yesPrice: bestAsk ?? yesPrice,
        noPrice: bestBid ?? noPrice,
        volumeUsd: safeNum(data.volume ?? market.volume) ?? 0,
        orderBookImbalance: 0, // 需要单独请求订单簿，默认 0
        capturedAt: new Date(),
      };
      return snapshot;
    } catch {
      return null;
    }
  }

  /**
   * 计算订单簿失衡（order book imbalance）。
   *
   * 订单簿失衡 = (bid 总挂单量 - ask 总挂单量) / (bid 总挂单量 + ask 总挂单量)
   * 范围 -1 到 1。
   *   正数：买单多于卖单，市场情绪偏多。
   *   负数：卖单多于买单，市场情绪偏空。
   *
   * 这是 TradingDecisionEngine 的"订单流/情绪强度"因子数据来源之一。
   * 当前 paper 阶段如果拿不到订单簿，返回 0（中性）。
   */
  async fetchOrderBookImbalance(tokenId: string): Promise<number> {
    try {
      const data = await requestJson<{ bids?: unknown; asks?: unknown }>(
        `https://clob.polymarket.com/book?token_id=${tokenId}`,
        this.timeoutMs,
      );

      const bidTotal = sumBookLevels(data?.bids);
      const askTotal = sumBookLevels(data?.asks);
      const total = bidTotal + askTotal;

      if (total <= 0) return 0;
      return (bidTotal - askTotal) / total;
    } catch {
      return 0;
    }
  }

  /** 从 question 文本里判断它是否属于某个温度桶（简化匹配）。 */
  isTempMatchesBucket(question: string, bucket: TemperatureBucket): boolean {
    // 简化策略：先尝试 label，再尝试桶边界数字。
    if (bucket.label && question.includes(bucket.label)) return true;

    if (bucket.minTempC !== null && question.includes(String(bucket.minTempC))) return true;
    if (bucket.maxTempC !== null && question.includes(String(bucket.maxTempC))) return true;
    return false;
  }
}

function parseOutcomePrices(raw?: string): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map(Number).filter((n) => Number.isFinite(n));
    }
  } catch {
    /* ignore */
  }
  return [];
}

function sumBookLevels(rows: unknown): number {
  if (!Array.isArray(rows)) return 0;
  let total = 0;
  for (const row of rows) {
    if (Array.isArray(row)) {
      // CLOB book 可能返回 [price, size] 数组
      const size = Number(row[1]);
      if (Number.isFinite(size)) total += size;
    } else if (row && typeof row === 'object') {
      const size = Number((row as { size?: unknown }).size);
      if (Number.isFinite(size)) total += size;
    }
  }
  return total;
}

export function getCurrentTempBucketFromLabel(
  label: string,
  buckets: TemperatureBucket[],
): TemperatureBucket | undefined {
  return buckets.find((b) => b.label === label);
}