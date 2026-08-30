// 每 2 小时持仓状态报告脚本（PM2 cron: '0 */2 * * *'）。
//
// 职责（2026-08-11 精简：取消每日总结，只保留 2 小时持仓报告）：
//   1. 未结算持仓明细：城市、桶对、开仓价、当前价、单笔浮盈。
//   2. 持仓汇总：总成本、当前市值、总浮盈。
//   3. 今日已平仓明细：城市、桶对、成本、平仓价、利润。
//   4. 今日平仓利润合计。
//
// 口径说明（2026-08-11 原生单位改造）：
//   - 桶 label 用市场原生单位（°C 城市 "25C"、°F 城市 "76-77F"），不做温度换算。
//   - 新记录带精确 °C 边界（bucketBounds/switchBucketBounds）→ 按边界匹配实时价；
//     旧记录无边界 → 回退"温度距离最近"匹配（仅展示）。
//   - 平仓（closed）交易结算逻辑不会再次触发（内存持仓已移除），其最终盈亏 =
//     退出时已实现部分，报告直接按退出价计算落地收益。
//
// 部署方式（PM2，每 2 小时整点运行）：
//   cron_restart: '0 */2 * * *'
//
// 也可以手动运行：
//   npx tsx scripts/status-report.ts

import 'dotenv/config';
import { readAllTrades } from '../src/utils/trade-recorder.js';
import { sendWeComMarkdown } from '../src/utils/wecom-notifier.js';
import { PolymarketClient } from '../src/utils/polymarket-client.js';
import type { GammaMarket } from '../src/utils/polymarket-client.js';
import type { TradeRecord } from '../src/common/types.js';
import { createModuleLogger } from '../src/common/logger.js';
import { parseMarketQuestion } from '../src/utils/market-buckets.js';

const logger = createModuleLogger('StatusReport');

// 城市中文名（企业微信消息用大白话）。
const CITY_CN: Record<string, string> = {
  shanghai: '上海',
  nyc: '纽约',
  chicago: '芝加哥',
  miami: '迈阿密',
  dallas: '达拉斯',
  seattle: '西雅图',
  atlanta: '亚特兰大',
  london: '伦敦',
  paris: '巴黎',
  munich: '慕尼黑',
  ankara: '安卡拉',
  seoul: '首尔',
  tokyo: '东京',
  singapore: '新加坡',
  lucknow: '勒克瑙',
  'tel-aviv': '特拉维夫',
  toronto: '多伦多',
  'sao-paulo': '圣保罗',
  'buenos-aires': '布宜诺斯艾利斯',
  wellington: '惠灵顿',
};

interface HoldingRow {
  trade: TradeRecord;
  cityCn: string;
  holdKeys: string[]; // 当前持仓桶（换仓后 = switchKeys，否则 = 开仓桶）
  holdBounds?: Array<{ minTempC: number | null; maxTempC: number | null }>; // 对应 holdKeys 的精确 °C 边界（旧记录可能缺失）
  basePrice: number; // 成本基准（换仓后 = switchBuy，否则 = entryPrice）
  sumBid: number | null; // 当前持仓桶 bid 之和（实时）
  curValue: number | null; // 按 bid 比例估算的当前市值
}

function parseOutcome(raw?: string): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return Number(parsed[0]) || 0;
  } catch {
    /* ignore */
  }
  return 0;
}

function marketBid(m: GammaMarket): number {
  return Number(m.bestBid) || parseOutcome(m.outcomePrices);
}

/**
 * 给持仓桶 label 匹配 market question 里的实时 bid（2026-08-11 起市场原生单位）。
 * 新记录带精确 °C 边界（bounds）→ 按边界匹配市场原生桶（与生产引擎
 * parseMarketPrices 同一套解析，°F 区间桶 76-77F / °C 单值桶 25C 都能精确对上）。
 * 旧记录无边界（历史 trades，config 摄氏网格 label）→ 回退"温度距离最近"匹配。
 */
function matchBucketBid(
  markets: GammaMarket[],
  bucketLabel: string,
  bounds?: { minTempC: number | null; maxTempC: number | null } | null,
): number | null {
  // 新记录：按精确 °C 边界匹配。
  if (bounds) {
    for (const m of markets) {
      const parsed = parseMarketQuestion(m.question ?? '');
      if (!parsed) continue;
      const b = parsed.bucket;
      const same =
        bounds.minTempC === null
          ? b.minTempC === null &&
            Math.abs((b.maxTempC ?? 0) - (bounds.maxTempC ?? 0)) < 0.01
          : bounds.maxTempC === null
            ? b.maxTempC === null &&
              Math.abs((b.minTempC ?? 0) - (bounds.minTempC ?? 0)) < 0.01
            : b.minTempC !== null &&
              b.maxTempC !== null &&
              Math.abs(b.minTempC - bounds.minTempC) < 0.01 &&
              Math.abs(b.maxTempC - bounds.maxTempC) < 0.01;
      if (same) return marketBid(m);
    }
    return null;
  }
  // 旧记录（无持久化边界）：按温度距离最近匹配（覆盖历史 trades）。
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
    if (low || high) continue; // label 开放但市场桶类型不对应
    const d = Math.abs(tempC - numC);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  if (!best || bestD > 2) return null;
  return marketBid(best);
}

/**
 * 已平仓交易的已落地收益（美元）。closed 是最终态（结算逻辑不会再跑），
 * 所以退出价 − 成本就是这笔交易最终的实现盈亏。
 *   - 换仓过：旧桶段已实现 (switchSell−entryPrice) + 新桶段离场 (exitPrice−switchBuy)
 *   - 双桶：两桶各半仓按各自退出价
 *   - 单桶：sizeUsd × (exitPrice − entryPrice)
 */
function realizedPnL(t: TradeRecord): number | null {
  if (t.status !== 'closed' || t.exitPrice === null) return null;
  if (t.switched && t.switchSell !== undefined && t.switchBuy !== undefined) {
    return t.sizeUsd * (t.switchSell - t.entryPrice + t.exitPrice - t.switchBuy);
  }
  if (t.buckets.length >= 2 && t.exitPriceA !== null && t.exitPriceB !== null) {
    const half = t.sizeUsd / 2;
    return half * (t.exitPriceA - t.entryPriceA) + half * (t.exitPriceB - t.entryPriceB);
  }
  return t.sizeUsd * (t.exitPrice - t.entryPrice);
}

async function main(): Promise<void> {
  const all = readAllTrades();
  const holdings = all.filter((t) => t.status === 'open');
  // 今日已平仓：closed 且今天离场（closedAt 的 UTC 日期）。
  const today = new Date().toISOString().slice(0, 10);
  const todayClosed = all.filter(
    (t) => t.status === 'closed' && t.closedAt && t.closedAt.slice(0, 10) === today,
  );

  // 拉实时行情：每个持仓找到对应市场，取两桶 bid 之和。
  const client = new PolymarketClient();
  const rows: HoldingRow[] = [];
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
          if (bids.length === holdKeys.length) {
            sumBid = bids.reduce((a, b) => a + b, 0);
          }
        }
      }
    } catch {
      sumBid = null;
    }
    const curValue =
      sumBid !== null && basePrice > 0 ? (t.sizeUsd * sumBid) / basePrice : null;
    const row: HoldingRow = {
      trade: t,
      cityCn: CITY_CN[t.city] ?? t.city,
      holdKeys,
      basePrice,
      sumBid,
      curValue,
    };
    if (holdBounds?.length) row.holdBounds = holdBounds;
    rows.push(row);
  }

  // 汇总只统计成本正常（>=5 分钱）的持仓：成本 <5 分钱是历史价格解析 bug 的占位价，
  // 市值会被公式放大几十倍，混入汇总会把总浮盈算虚高（表格里这类持仓浮盈显示 '—'）。
  const normalRows = rows.filter((r) => r.basePrice >= 0.05);
  const abnormalCount = rows.length - normalRows.length;
  const costTotal = normalRows.reduce((s, r) => s + r.trade.sizeUsd, 0);
  const valueTotal = normalRows.reduce((s, r) => s + (r.curValue ?? 0), 0);
  const valueDelta = valueTotal - costTotal;

  // 今日已平仓利润合计（换仓笔 = 旧桶段已实现 + 新桶段离场）。
  const realizedToday = todayClosed
    .map((t) => realizedPnL(t))
    .filter((p): p is number => p !== null)
    .reduce((s, p) => s + p, 0);

  // ==================== 生成 Markdown ====================
  const nowCn = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());

  let msg = `# 🌤 天气策略持仓报告\n\n`;
  msg += `**⏰ 北京时间**：${nowCn}\n\n`;
  msg += `---\n\n`;

  msg += `## 📌 当前持仓（${rows.length} 笔）\n\n`;
  if (rows.length === 0) {
    msg += `当前无持仓。\n\n`;
  } else {
    msg += `| 城市 | 桶对 | 开仓价 | 当前价 | 浮盈 | 备注 |\n`;
    msg += `|------|------|--------|--------|------|------|\n`;
    for (const r of rows) {
      const bucket = r.holdKeys.join('+');
      const entry = r.basePrice.toFixed(2);
      const cur = r.sumBid !== null ? r.sumBid.toFixed(2) : '—';
      // 成本异常（<5 分钱占位价）或行情缺失时浮盈不可信，显示 '—' 并标注。
      const costAbnormal = r.basePrice < 0.05;
      const pnl =
        r.curValue !== null && !costAbnormal
          ? `${r.curValue - r.trade.sizeUsd >= 0 ? '+' : ''}$${(r.curValue - r.trade.sizeUsd).toFixed(2)}`
          : '—';
      const remark = costAbnormal ? ' ⚠️成本异常' : '';
      msg += `| ${r.cityCn} | ${bucket} | ${entry} | ${cur} | ${pnl} | ${remark} |\n`;
    }
    msg += `\n`;
    msg += `💰 总成本：**$${costTotal.toFixed(2)}**\n`;
    const pct = costTotal > 0 ? `（${valueDelta / costTotal * 100 >= 0 ? '+' : ''}${((valueDelta / costTotal) * 100).toFixed(1)}%）` : '';
    const arrow = valueDelta >= 0 ? '📈' : '📉';
    msg += `${arrow} 当前市值：**$${valueTotal.toFixed(2)}**\n`;
    msg += `${valueDelta >= 0 ? '🟢' : '🔴'} 总浮盈：**${valueDelta >= 0 ? '+' : ''}$${valueDelta.toFixed(2)}** ${pct}\n`;
    if (abnormalCount > 0) {
      msg += `> ⚠️ ${abnormalCount} 笔持仓成本异常（<5 分钱占位价），未计入总成本/总浮盈\n\n`;
    } else {
      msg += `\n`;
    }
  }

  msg += `## 💵 今日已平仓（${todayClosed.length} 笔）\n\n`;
  if (todayClosed.length === 0) {
    msg += `今日暂无已平仓交易。\n\n`;
  } else {
    msg += `| 城市 | 桶对 | 成本 | 平仓价 | 利润 |\n`;
    msg += `|------|------|------|--------|------|\n`;
    for (const t of todayClosed) {
      const isSwitched = !!t.switched && !!t.switchKeys?.length;
      const keys = isSwitched ? t.switchKeys! : t.buckets;
      const cost = isSwitched && t.switchBuy ? t.switchBuy : t.entryPrice;
      const pnl = realizedPnL(t);
      const pnlStr = pnl !== null ? `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}` : '—';
      msg += `| ${CITY_CN[t.city] ?? t.city} | ${keys.join('+')} | ${cost.toFixed(2)} | ${t.exitPrice?.toFixed(2) ?? '—'} | ${pnlStr} |\n`;
    }
    const realizedSign = realizedToday >= 0 ? '+' : '';
    msg += `\n`;
    msg += `💰 今日平仓利润合计：**${realizedSign}$${realizedToday.toFixed(2)}**\n\n`;
  }

  msg += `---\n`;
  msg += `> 每 2 小时自动推送，由 Polymarket 天气策略系统生成\n`;

  logger.info('持仓状态报告生成完成', {
    holdings: rows.length,
    closedToday: todayClosed.length,
    realizedToday: Math.round(realizedToday * 100) / 100,
    costTotal: Math.round(costTotal * 100) / 100,
    valueTotal: Math.round(valueTotal * 100) / 100,
    valueDelta: Math.round(valueDelta * 100) / 100,
  });

  // STATUS_DEBUG=1 时把消息全文打印到控制台（本地预览用，不依赖 webhook）。
  if ((process.env.STATUS_DEBUG ?? '') === '1') {
    console.log('\n===== 报告内容预览 =====\n' + msg + '\n==========================');
  }

  const sent = await sendWeComMarkdown(msg);
  if (sent) {
    logger.info('企业微信持仓状态发送成功');
  } else {
    logger.warn('企业微信持仓状态发送失败（可能未配置 WECOM_WEBHOOK_URL）');
  }
}

main().catch((error) => {
  logger.error('持仓状态报告生成失败', {
    errorMessage: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
