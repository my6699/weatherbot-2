// ==================== Polymarket 真实交易模块（live CLOB） ====================
//
// 职责：通过 @polymarket/clob-client 对 CLOB 下单/撤单/查单。
// 开关：TRADING_MODE=live 且配置了 POLYMARKET_PRIVATE_KEY + POLYMARKET_FUNDER_ADDRESS
//   时启用真实交易；TRADING_MODE=paper 或缺少密钥时 isLiveEnabled() 返回 false，
//   调用方保持 paper 模拟记录（recordOpenTrade/recordCloseTrade），不触碰真实资金。
//
// 执行策略（与旧项目生产验证一致）：
//   - 开仓优先 maker-first：post-only GTC 限价单挂在对手价上等成交（不抢价、省 maker 费），
//     超时未成交则撤单回退 taker 市价单（FAK/FOK）。
//   - 平仓同样 maker-first，滑点风险可控。
//
// 安全：私钥只从环境变量读取，绝不写入代码/Git。

import { Chain, ClobClient, OrderType, Side, SignatureType } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { polygon, polygonAmoy } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import dotenv from 'dotenv';
import { createModuleLogger, logError } from '../common/logger.js';

dotenv.config();

const logger = createModuleLogger('LiveClob');

const CLOB_HOST = process.env.POLYMARKET_CLOB_API_URL ?? 'https://clob.polymarket.com';

// 真实下单开关：
//   1. TRADING_MODE=live（总开关，与 config-loader 的 paper/live 一致）
//   2. POLYMARKET_PRIVATE_KEY 非空（真实钱包私钥）
//   3. POLYMARKET_FUNDER_ADDRESS 非空（Polymarket 代理钱包地址）
// 三者同时满足才视为"真实交易已开启"。
export function isLiveEnabled(): boolean {
  if ((process.env.TRADING_MODE ?? 'paper') !== 'live') return false;
  return Boolean(process.env.POLYMARKET_PRIVATE_KEY && process.env.POLYMARKET_FUNDER_ADDRESS);
}

/** 真实交易开关的详细状态（用于启动日志 / 安全提示）。 */
export function liveStatus(): { enabled: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if ((process.env.TRADING_MODE ?? 'paper') !== 'live') {
    reasons.push('TRADING_MODE 不是 live（当前 paper）');
  }
  if (!process.env.POLYMARKET_PRIVATE_KEY) reasons.push('缺少 POLYMARKET_PRIVATE_KEY');
  if (!process.env.POLYMARKET_FUNDER_ADDRESS) reasons.push('缺少 POLYMARKET_FUNDER_ADDRESS');
  return { enabled: reasons.length === 0, reasons };
}

function assertLiveConfig(): void {
  if (!process.env.POLYMARKET_PRIVATE_KEY) {
    throw new Error('live 模式需要 POLYMARKET_PRIVATE_KEY（真实钱包私钥）');
  }
  if (!process.env.POLYMARKET_FUNDER_ADDRESS) {
    throw new Error('live 模式需要 POLYMARKET_FUNDER_ADDRESS（Polymarket 代理钱包地址）');
  }
}

function clobChainId(): Chain {
  return process.env.POLYMARKET_CHAIN_ID === '80002' ? Chain.AMOY : Chain.POLYGON;
}

function viemChain() {
  return process.env.POLYMARKET_CHAIN_ID === '80002' ? polygonAmoy : polygon;
}

let cached: ClobClient | null = null;

/** 获取（并缓存）CLOB 客户端。首次调用会校验密钥并派生 API key。 */
export async function getClobClient(): Promise<ClobClient> {
  if (cached) return cached;
  assertLiveConfig();

  const rawPk = process.env.POLYMARKET_PRIVATE_KEY;
  if (!rawPk) {
    throw new Error('live 模式需要 POLYMARKET_PRIVATE_KEY（真实钱包私钥）');
  }
  const pk = rawPk.startsWith('0x') ? rawPk : `0x${rawPk}`;
  const account = privateKeyToAccount(pk as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: viemChain(),
    transport: http(),
  });

  const sigRaw = process.env.POLYMARKET_SIGNATURE_TYPE;
  const sigParsed = sigRaw != null && sigRaw !== '' ? Number(sigRaw) : NaN;
  const signatureType = Number.isFinite(sigParsed)
    ? (sigParsed as SignatureType)
    : SignatureType.POLY_PROXY;

  let creds;
  if (
    process.env.POLYMARKET_CLOB_API_KEY &&
    process.env.POLYMARKET_CLOB_API_SECRET &&
    process.env.POLYMARKET_CLOB_API_PASSPHRASE
  ) {
    creds = {
      key: process.env.POLYMARKET_CLOB_API_KEY,
      secret: process.env.POLYMARKET_CLOB_API_SECRET,
      passphrase: process.env.POLYMARKET_CLOB_API_PASSPHRASE,
    };
  } else {
    // 没有预置 API key 时，用钱包在链上派生一份（旧项目生产验证可用）。
    const temp = new ClobClient(CLOB_HOST, clobChainId(), walletClient);
    creds = await temp.createOrDeriveApiKey();
  }

  cached = new ClobClient(
    CLOB_HOST,
    clobChainId(),
    walletClient,
    creds,
    signatureType,
    process.env.POLYMARKET_FUNDER_ADDRESS,
  );
  logger.info('CLOB 客户端已就绪', {
    host: CLOB_HOST,
    chainId: clobChainId(),
    funder: process.env.POLYMARKET_FUNDER_ADDRESS,
    credsSource: creds.key ? 'env' : 'derived',
  });
  return cached;
}

/** 释放缓存的 CLOB 客户端（测试/重启场景用）。 */
export function resetClobClient(): void {
  cached = null;
}

function assertOrderOk(resp: unknown): void {
  if (resp == null) throw new Error('empty CLOB response');
  if (typeof resp === 'object') {
    const r = resp as Record<string, unknown>;
    if (r.error) throw new Error(String(r.error));
    if (r.success === false) throw new Error(String(r.errorMsg ?? 'order rejected'));
  }
}

function entryOrderType(): OrderType.FOK | OrderType.FAK {
  const t = (process.env.POLYMARKET_ENTRY_ORDER_TYPE ?? 'FAK').toUpperCase();
  return t === 'FOK' ? OrderType.FOK : OrderType.FAK;
}

function exitOrderType(): OrderType.FOK | OrderType.FAK {
  const t = (process.env.POLYMARKET_EXIT_ORDER_TYPE ?? 'FAK').toUpperCase();
  return t === 'FOK' ? OrderType.FOK : OrderType.FAK;
}

/** 市价买入 YES：`usdAmount` 是 USDC 名义金额（CLOB client 约定）。 */
export async function clobBuyYesUsd(yesTokenId: string, usdAmount: number): Promise<unknown> {
  const client = await getClobClient();
  const ot = entryOrderType();
  const resp = await client.createAndPostMarketOrder(
    { tokenID: yesTokenId, amount: usdAmount, side: Side.BUY, orderType: ot },
    {},
    ot,
  );
  assertOrderOk(resp);
  return resp;
}

/** 市价卖出 YES：`shareAmount` 是条件代币股数。 */
export async function clobSellYesShares(yesTokenId: string, shareAmount: number): Promise<unknown> {
  const client = await getClobClient();
  const ot = exitOrderType();
  const resp = await client.createAndPostMarketOrder(
    { tokenID: yesTokenId, amount: shareAmount, side: Side.SELL, orderType: ot },
    {},
    ot,
  );
  assertOrderOk(resp);
  return resp;
}

export interface MakerFill {
  filled: boolean;
  fillPrice: number | null;
  orderId: string | null;
}

/**
 * Maker-first 填单尝试：以对手价挂 post-only GTC 限价单
 * （买挂 best bid / 卖挂 best ask），轮询 CLOB_MAKER_WAIT_MS 等成交，
 * 超时未成交则撤单返回 unfilled，由调用方回退 taker 市价单。
 * POLYMARKET_MAKER_MODE=false 时直接返回 unfilled（走纯 taker 路径）。
 */
async function clobTryMakerFill(
  yesTokenId: string,
  size: number,
  limitPrice: number,
  side: Side,
): Promise<MakerFill> {
  const makerMode = (process.env.POLYMARKET_MAKER_MODE ?? 'true') !== 'false';
  if (!makerMode) return { filled: false, fillPrice: null, orderId: null };
  const client = await getClobClient();
  const safeSize = Math.max(0.01, Math.round(size * 100) / 100);
  const safePrice = Math.max(0.001, Math.min(0.999, Math.round(limitPrice * 1000) / 1000));
  const resp = await client.createAndPostOrder(
    { tokenID: yesTokenId, price: safePrice, size: safeSize, side },
    {},
    OrderType.GTC,
    false,
    true, // postOnly：绝不抢价成交，只挂单等吃
  );
  assertOrderOk(resp);
  const orderId =
    (resp as { orderID?: string } | null)?.orderID ??
    (resp as { id?: string } | null)?.id ??
    null;
  if (!orderId) return { filled: false, fillPrice: null, orderId: null };

  const waitMs = Number(process.env.POLYMARKET_MAKER_WAIT_MS ?? '8000');
  const pollMs = Number(process.env.POLYMARKET_MAKER_POLL_MS ?? '1500');
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    try {
      const o = (await client.getOrder(orderId)) as {
        size_matched?: string | number;
        original_size?: string | number;
        status?: string;
      } | null;
      const matched = Number(o?.size_matched ?? 0);
      const orig = Number(o?.original_size ?? size);
      const status = o?.status;
      if (status === 'MATCHED' || (orig > 0 && matched >= orig * 0.999)) {
        return { filled: true, fillPrice: safePrice, orderId };
      }
    } catch {
      /* 继续轮询到超时 */
    }
  }
  // 超时未成交 → 撤单，让调用方回退 taker。
  try {
    await client.cancelOrder({ orderID: orderId });
  } catch {
    /* 已成交或已消失 */
  }
  return { filled: false, fillPrice: null, orderId };
}

/** Maker-first 买入 YES：`usdAmount` 名义金额，`limitPrice` 为对手价（best bid）。 */
export async function clobTryMakerBuy(
  yesTokenId: string,
  usdAmount: number,
  limitPrice: number,
): Promise<MakerFill> {
  const size = usdAmount / Math.max(0.001, limitPrice);
  return clobTryMakerFill(yesTokenId, size, limitPrice, Side.BUY);
}

/** Maker-first 卖出 YES 股数：`shareAmount` 为持仓股数，`limitPrice` 为对手价（best ask）。 */
export async function clobTryMakerSell(
  yesTokenId: string,
  shareAmount: number,
  limitPrice: number,
): Promise<MakerFill> {
  return clobTryMakerFill(yesTokenId, shareAmount, limitPrice, Side.SELL);
}

/** 从 Gamma market 详情解析 YES token id（clobTokenIds[0] 即 YES outcome）。 */
export async function resolveYesTokenId(marketId: string): Promise<string | null> {
  try {
    const res = await fetch(`${process.env.POLYMARKET_GAMMA_API_URL ?? 'https://gamma-api.polymarket.com'}/markets/${marketId}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const detail = (await res.json()) as { clobTokenIds?: string };
    const raw = detail.clobTokenIds;
    if (!raw) return null;
    const ids = JSON.parse(raw) as string[];
    return ids[0] ?? null;
  } catch (error) {
    logError(logger, `解析市场 ${marketId} 的 YES token id 失败`, error);
    return null;
  }
}

interface OrderLevel {
  price: number;
  size: number;
}

function toLevels(rows: unknown): OrderLevel[] {
  if (!Array.isArray(rows)) return [];
  const out: OrderLevel[] = [];
  for (const row of rows) {
    if (Array.isArray(row)) {
      const p = Number(row[0]);
      const s = Number(row[1]);
      if (Number.isFinite(p) && Number.isFinite(s)) out.push({ price: p, size: s });
    } else if (row && typeof row === 'object') {
      const p = Number((row as { price?: unknown }).price);
      const s = Number((row as { size?: unknown }).size);
      if (Number.isFinite(p) && Number.isFinite(s)) out.push({ price: p, size: s });
    }
  }
  return out;
}

/**
 * YES bid 侧前 `levels` 档挂单总名义金额（$）。返回 null 表示订单簿不可用
 * （API 失败 / 未开 live）。用于"离场深度检查"：bid 深度不足时不平仓、继续持有。
 */
export async function getYesBidDepth(yesTokenId: string, levels = 2): Promise<number | null> {
  try {
    const client = await getClobClient();
    const book = (await client.getOrderBook(yesTokenId)) as { bids?: unknown };
    const bids = toLevels(book?.bids);
    let total = 0;
    let i = 0;
    for (const b of bids) {
      if (i >= levels) break;
      total += b.price * b.size;
      i += 1;
    }
    return total;
  } catch (error) {
    logError(logger, `读取 ${yesTokenId} 订单簿深度失败`, error);
    return null;
  }
}
