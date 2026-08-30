// 每 2 小时持仓状态报告脚本。
//
// 职责：
//   1. 读取所有持久化的交易记录，列出未结算持仓明细
//      （城市、桶对、买入价、当前实时价、目标日期）。
//   2. 汇总：持仓数、买入成本合计、当前市值合计、今日结算、累计盈亏。
//   3. 通过企业微信机器人通知用户。
//
// 部署方式（PM2，每 2 小时整点运行）：
//   cron_restart: '0 */2 * * *'
//
// 也可以手动运行：
//   npx tsx src/scripts/status-report.ts

import 'dotenv/config';
import { readAllTrades, getTodaySettledTrades, getTotalPnL } from '../utils/trade-recorder.js';
import { sendWeComMarkdown } from '../utils/wecom-notifier.js';
import { PolymarketClient } from '../utils/polymarket-client.js';
import type { GammaMarket } from '../utils/polymarket-client.js';
import type { TradeRecord } from '../common/types.js';
import { createModuleLogger } from '../common/logger.js';

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
  basePrice: number; // 成本基准（换仓后 = switchBuy，否则 = entryPrice）
  sumBid: number | null; // 当前持仓桶 bid 之和（实时）
  curValue: number | null; // 按 bid 比例估算的当前市值
  warning: string; // "已换仓" / "⚠️成本异常" / 空
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
 * 给持仓桶 label 匹配 market question 里的实时 bid。
 * label 是 config 桶（摄氏），market 有华氏（°F）和摄氏（°C），统一转摄氏后
 * 按"温度差最小"匹配（对齐生产引擎 marketPriceFor）：
 *   - 开放桶 label（<=/>=）→ 市场对应 "or below"/"or higher" 桶
 *   - 闭合桶 label → 市场里温度最接近的桶（含边界开放桶，如伦敦 24 vs "24°C or below"）
 * 距离 > 2°C 视为无匹配（覆盖 1°C / 2°F 步长 + 转换误差）。
 */
function matchBucketBid(markets: GammaMarket[], bucketLabel: string): number | null {
  const isOpenLow = bucketLabel.startsWith('<=');
  const isOpenHigh = bucketLabel.startsWith('>=');
  const numC = Number(bucketLabel.replace(/[^\d.-]/g, ''));
  let best: GammaMarket | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const m of markets) {
    const q = m.question ?? '';
    const mm = q.match(/(\d+)\s*°([CF])/);
    if (!mm) continue;
    const isF = mm[2] === 'F';
    const tempC = isF ? ((Number(mm[1]) - 32) * 5) / 9 : Number(mm[1]);
    const isLow = /or below/i.test(q);
    const isHigh = /or higher/i.test(q);
    if (isOpenLow && isLow) return marketBid(m);
    if (isOpenHigh && isHigh) return marketBid(m);
    if (isOpenLow || isOpenHigh) continue; // label 开放但市场桶类型不对应
    const d = Math.abs(tempC - numC);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  if (!best || bestD > 2) return null;
  return marketBid(best);
}

async function main(): Promise<void> {
  const all = readAllTrades();
  const holdings = all.filter((t) => t.status === 'open');
  const todaySettled = getTodaySettledTrades();

  // 拉实时行情：每个持仓找到对应市场，取当前持仓桶 bid 之和。
  // 换仓后的持仓用新桶（switchKeys）+ 换仓后成本（switchBuy），不再用开仓桶/开仓成本。
  const client = new PolymarketClient();
  const rows: HoldingRow[] = [];
  for (const t of holdings) {
    const holdKeys = t.switched && t.switchKeys?.length ? t.switchKeys : t.buckets;
    const basePrice = t.switched && t.switchBuy ? t.switchBuy : t.entryPrice;
    let sumBid: number | null = null;
    try {
      if (t.targetDate) {
        const [y, m, d] = t.targetDate.split('-').map(Number);
        const event = await client.findEventBySlug(t.city, y!, m!, d!);
        if (event) {
          const markets = event.markets ?? [];
          const bids = holdKeys
            .map((label) => matchBucketBid(markets, label))
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
    let warning = '';
    if (t.switched) warning = '已换仓';
    // 成本 < 5 分钱：极可能是历史价格解析 bug 的占位价（如布宜诺斯艾利斯 0.02），
    // 市值会被公式放大几十倍，必须标注出来避免误读。
    if (basePrice < 0.05) warning += (warning ? '，' : '') + '⚠️成本异常';
    rows.push({ trade: t, cityCn: CITY_CN[t.city] ?? t.city, holdKeys, basePrice, sumBid, curValue, warning });
  }

  // 汇总只算"正常持仓"：成本异常单（<0.05 的历史假账）剔除，避免市值被放大。
  // 明细表仍完整展示全部持仓，异常单带 ⚠️ 标记。
  const abnormal = rows.filter((r) => r.warning.includes('成本异常'));
  const normal = rows.filter((r) => !r.warning.includes('成本异常'));
  const costTotal = normal.reduce((s, r) => s + r.trade.sizeUsd, 0);
  const valueTotal = normal.reduce((s, r) => s + (r.curValue ?? 0), 0);
  const valueDelta = valueTotal - costTotal;
  const abnormalCost = abnormal.reduce((s, r) => s + r.trade.sizeUsd, 0);
  const abnormalValue = abnormal.reduce((s, r) => s + (r.curValue ?? 0), 0);
  const todayPnL = todaySettled
    .filter((t) => t.pnl !== null)
    .reduce((s, t) => s + (t.pnl ?? 0), 0);
  const hits = todaySettled.filter((t) => t.hit === true).length;
  const cumPnl = getTotalPnL();
  const settledCount = all.filter((t) => t.status === 'settled').length;

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

  let msg = `# 🌤 天气策略持仓状态\n\n`;
  msg += `**⏰ 北京时间**：${nowCn}\n\n`;
  msg += `---\n\n`;

  msg += `## 📌 未结算持仓（${rows.length} 笔）\n\n`;
  if (rows.length === 0) {
    msg += `当前无持仓。\n\n`;
  } else {
    msg += `| 城市 | 桶对 | 成本 | 当前价 | 备注 | 目标日期 |\n`;
    msg += `|------|------|------|--------|------|----------|\n`;
    for (const r of rows) {
      const bucket = r.holdKeys.join('+');
      const entry = r.basePrice.toFixed(2);
      const cur = r.sumBid !== null ? r.sumBid.toFixed(2) : '—';
      const remark = r.warning || '—';
      const target = r.trade.targetDate ? r.trade.targetDate.slice(5).replace('-', '-') : '—';
      msg += `| ${r.cityCn} | ${bucket} | ${entry} | ${cur} | ${remark} | ${target} |\n`;
    }
    msg += `\n`;
    msg += `💰 买入成本合计（正常单）：**$${costTotal.toFixed(2)}**\n`;
    const pct = costTotal > 0 ? `（${(valueDelta / costTotal) * 100 >= 0 ? '+' : ''}${((valueDelta / costTotal) * 100).toFixed(1)}%）` : '';
    const arrow = valueDelta >= 0 ? '📈' : '📉';
    msg += `${arrow} 账面市值（未结算浮盈）：**$${valueTotal.toFixed(2)}** ${pct}\n`;
    msg += `> 浮盈是"如果现在按 bid 全卖能拿回多少"的账面数，**结算后才落袋**\n`;
    if (abnormal.length > 0) {
      msg += `🧹 已剔除 ${abnormal.length} 笔假账单（成本 $${abnormalCost.toFixed(2)}，账面 $${abnormalValue.toFixed(2)}），不计入上面汇总\n`;
    }
    msg += `\n`;
    const cumSign = cumPnl >= 0 ? '+' : '';
    msg += `✅ 已实现盈亏（落袋真钱）：**${cumSign}$${cumPnl.toFixed(2)}**（${settledCount} 笔已结算）\n\n`;
  }

  msg += `## 📊 今日概览\n\n`;
  msg += `- 今日结算：**${todaySettled.length}** 笔（命中 ${hits}/${todaySettled.length}）\n`;
  const todayPnlSign = todayPnL >= 0 ? '+' : '';
  const todayEmoji = todayPnL >= 0 ? '✅' : '❌';
  msg += `- 今日已实现盈亏：**${todayEmoji} ${todayPnlSign}$${todayPnL.toFixed(2)}**\n\n`;
  msg += `---\n`;
  msg += `> 每 2 小时自动推送，由 Polymarket 天气策略系统生成\n`;

  logger.info('持仓状态报告生成完成', {
    holdings: rows.length,
    costTotal: Math.round(costTotal * 100) / 100,
    valueTotal: Math.round(valueTotal * 100) / 100,
    todayPnL: Math.round(todayPnL * 100) / 100,
    cumulativePnL: Math.round(cumPnl * 100) / 100,
  });

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
