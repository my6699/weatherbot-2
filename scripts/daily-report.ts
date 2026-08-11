// 每日结算报告脚本。
//
// 职责：
//   1. 读取所有持久化的交易记录。
//   2. 统计今日已结算交易的盈亏。
//   3. 生成 Markdown 报告。
//   4. 通过企业微信机器人通知用户。
//
// 部署方式（PM2 定时任务，每天 UTC 13:00 运行，即北京时间 21:00）：
//   pm2 start dist/scripts/daily-report.js --name daily-report --cron "0 13 * * *"
//
// 也可以手动运行：
//   npx tsx scripts/daily-report.ts

import 'dotenv/config';
import { readAllTrades, getTodaySettledTrades, getOpenPositions, getTotalPnL } from '../src/utils/trade-recorder.js';
import { sendWeComMarkdown } from '../src/utils/wecom-notifier.js';
import { logger } from '../src/common/logger.js';

interface DailyReport {
  date: string;
  totalTrades: number;
  settledToday: number;
  hits: number;
  misses: number;
  pending: number;
  todayPnL: number;
  cumulativePnL: number;
  hitRate: string;
  cityBreakdown: Array<{
    city: string;
    trades: number;
    hits: number;
    pnl: number;
  }>;
}

function generateReport(): DailyReport {
  const allTrades = readAllTrades();
  const todaySettled = getTodaySettledTrades();
  const openPositions = getOpenPositions();

  const today = new Date().toISOString().slice(0, 10);

  // 今日结算统计
  const hits = todaySettled.filter((t) => t.hit === true).length;
  const misses = todaySettled.filter((t) => t.hit === false).length;
  const todayPnL = todaySettled
    .filter((t) => t.pnl !== null)
    .reduce((sum, t) => sum + (t.pnl ?? 0), 0);

  // 分城市统计
  const cityMap = new Map<string, { trades: number; hits: number; pnl: number }>();
  for (const t of todaySettled) {
    const entry = cityMap.get(t.city) ?? { trades: 0, hits: 0, pnl: 0 };
    entry.trades++;
    if (t.hit) entry.hits++;
    entry.pnl += t.pnl ?? 0;
    cityMap.set(t.city, entry);
  }

  const cityBreakdown = Array.from(cityMap.entries()).map(([city, data]) => ({
    city,
    ...data,
  }));

  const settledCount = todaySettled.length;
  const hitRate = settledCount > 0 ? `${(hits / settledCount * 100).toFixed(1)}%` : 'N/A';

  return {
    date: today,
    totalTrades: allTrades.length,
    settledToday: settledCount,
    hits,
    misses,
    pending: openPositions.length,
    todayPnL,
    cumulativePnL: getTotalPnL(),
    hitRate,
    cityBreakdown,
  };
}

function formatReport(report: DailyReport): string {
  const pnlEmoji = report.todayPnL >= 0 ? '✅' : '❌';
  const pnlSign = report.todayPnL >= 0 ? '+' : '';
  const cumPnlSign = report.cumulativePnL >= 0 ? '+' : '';

  let msg = `# 🌤 天气策略每日结算报告\n\n`;
  msg += `**日期**：${report.date}\n\n`;
  msg += `---\n\n`;

  // 今日概览
  msg += `## 📊 今日概览\n\n`;
  msg += `- 总交易笔数：**${report.totalTrades}**\n`;
  msg += `- 今日结算：**${report.settledToday}** 笔\n`;
  msg += `- 命中/未命中：**${report.hits}** / **${report.misses}**\n`;
  msg += `- 命中率：**${report.hitRate}**\n`;
  msg += `- 今日盈亏：**${pnlEmoji} ${pnlSign}$${report.todayPnL.toFixed(2)}**\n`;
  msg += `- 累计盈亏：**${cumPnlSign}$${report.cumulativePnL.toFixed(2)}**\n`;
  msg += `- 未结算持仓：**${report.pending}** 笔\n\n`;

  // 分城市明细
  if (report.cityBreakdown.length > 0) {
    msg += `## 🏙 分城市明细\n\n`;
    msg += `| 城市 | 交易 | 命中 | 盈亏 |\n`;
    msg += `|------|------|------|------|\n`;
    for (const c of report.cityBreakdown) {
      const cPnl = c.pnl >= 0 ? `+$${c.pnl.toFixed(2)}` : `-$${Math.abs(c.pnl).toFixed(2)}`;
      msg += `| ${c.city} | ${c.trades} | ${c.hits}/${c.trades} | ${cPnl} |\n`;
    }
    msg += `\n`;
  }

  // 策略状态
  msg += `## ⚙ 策略状态\n\n`;
  msg += `- 交易模式：**paper**（模拟交易）\n`;
  msg += `- 运行状态：**自动运行中**\n`;
  msg += `- 入场策略：D-3/D-2 市场发现入场\n`;
  msg += `- 离场策略：峰值前 0.85 目标 / 硬性 $14:00$ 清仓\n\n`;

  msg += `---\n`;
  msg += `> 自动报告，由 Polymarket 天气策略系统生成\n`;

  return msg;
}

async function main(): Promise<void> {
  logger.info('每日结算报告开始生成');

  const report = generateReport();
  const markdown = formatReport(report);

  logger.info('报告生成完成', {
    settledToday: report.settledToday,
    todayPnL: report.todayPnL,
    cumulativePnL: report.cumulativePnL,
    hitRate: report.hitRate,
    pending: report.pending,
  });

  // 发送到企业微信
  const sent = await sendWeComMarkdown(markdown);
  if (sent) {
    logger.info('企业微信报告发送成功');
  } else {
    logger.warn('企业微信报告发送失败（可能未配置 WECOM_WEBHOOK_URL）');
  }

  // 如果今天没有结算，也发一条简短通知
  if (report.settledToday === 0) {
    const shortMsg = `🌤 ${report.date} 天气策略报告：今日无结算，累计盈亏 ${report.cumulativePnL >= 0 ? '+' : ''}$${report.cumulativePnL.toFixed(2)}，${report.pending} 笔持仓未结算。`;
    await sendWeComMarkdown(shortMsg);
  }
}

main().catch((error) => {
  logger.error('每日结算报告生成失败', {
    errorMessage: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});