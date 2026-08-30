/**
 * 现有策略回测脚本
 * 使用项目现有的 TradingDecisionEngine 和 ExitStrategy 逻辑，
 * 对历史数据进行回测，验证策略表现。
 *
 * 用法: node scripts/backtest-existing-strategy.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// 加载城市配置
const cityConfigPath = path.join(PROJECT_ROOT, 'config', 'shanghai.json');
const cityConfig = JSON.parse(fs.readFileSync(cityConfigPath, 'utf-8'));

// 加载所有回测 detail 文件
function loadAllBacktestTrades(backtestDir) {
  const files = fs.readdirSync(backtestDir)
    .filter(f => f.startsWith('backtest-detail_') && f.endsWith('.csv'))
    .sort();

  if (files.length === 0) {
    console.log('未找到回测数据文件');
    return [];
  }

  const seen = new Set();
  const trades = [];

  for (const file of files) {
    const filePath = path.join(backtestDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    if (lines.length < 2) continue;

    // CSV 头: 市场ID,城市,日期,桶组合,入场价,价格来源,入场时间,入场水平,实际温度C,结算结果,退出价,盈亏,漂移离场,漂移阈值,峰值离场时间,D0失配离场,价格止损,ECMWF偏差C,GFS偏差C,ICON偏差C
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = line.split(',');
      if (values.length < 12) continue;

      const marketId = values[0];
      // 避免重复导入同一笔交易
      if (seen.has(marketId)) continue;
      seen.add(marketId);

      const city = values[1] || '';
      const date = values[2] || '';
      const bucketCombo = values[3] || '';
      const entryPriceStr = values[4];
      const source = values[5] || '';
      const entryTime = values[6] || '';
      const horizon = values[7] || '';
      const actualTempStr = values[8];
      const resultType = values[9] || '';
      const exitPriceStr = values[10];
      const pnlStr = values[11];

      const entryPrice = entryPriceStr ? parseFloat(entryPriceStr) : NaN;
      const actualTemp = actualTempStr ? parseFloat(actualTempStr) : null;
      const exitPrice = exitPriceStr ? parseFloat(exitPriceStr) : null;
      const pnl = pnlStr ? parseFloat(pnlStr) : null;

      // 跳过没有入场价的交易（未实际开仓）
      if (isNaN(entryPrice) || entryPrice <= 0) continue;

      // 解析桶标签
      const bucketLabels = bucketCombo.split('+').map(b => {
        const parts = b.split('-');
        return parts[0];
      });

      // 离场原因
      const driftAway = values[12] === '1';
      const driftThreshold = values[13] || '';
      const peakExit = values[14] || '';
      const d0Mismatch = values[15] === '1';
      const priceStop = values[16] === '1';

      let exitReason = '持有到结算';
      if (driftAway) exitReason = '漂移离场';
      else if (priceStop) exitReason = '价格止损';
      else if (d0Mismatch) exitReason = 'D0失配离场';
      else if (peakExit) exitReason = `峰值离场(${peakExit})`;

      trades.push({
        marketId,
        city,
        date,
        entryPrice,
        bucketLabels,
        source,
        entryTime,
        horizon,
        actualTemp,
        result: resultType, // '命中' 或 '未中'
        hit: resultType === '命中',
        exitPrice: exitPrice !== null ? exitPrice : 0,
        pnl: pnl !== null ? pnl : 0,
        exitReason,
        // 偏差数据
        ecmwfBias: values[17] ? parseFloat(values[17]) : null,
        gfsBias: values[18] ? parseFloat(values[18]) : null,
        iconBias: values[19] ? parseFloat(values[19]) : null,
      });
    }
  }

  return trades;
}

// 计算统计指标
function calculateMetrics(trades) {
  if (trades.length === 0) return null;

  const hits = trades.filter(t => t.hit).length;
  const misses = trades.filter(t => !t.hit).length;
  const total = trades.length;

  const profitable = trades.filter(t => t.pnl > 0).length;
  const losing = trades.filter(t => t.pnl < 0).length;
  const flat = trades.filter(t => t.pnl === 0).length;

  const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
  const avgPnL = totalPnL / total;

  // 按城市统计
  const cityMap = new Map();
  for (const t of trades) {
    if (!cityMap.has(t.city)) {
      cityMap.set(t.city, { trades: 0, hits: 0, pnl: 0, profitable: 0 });
    }
    const c = cityMap.get(t.city);
    c.trades++;
    if (t.hit) c.hits++;
    c.pnl += t.pnl;
    if (t.pnl > 0) c.profitable++;
  }

  // 最大连续盈利/亏损
  let maxWinStreak = 0, curWin = 0;
  let maxLossStreak = 0, curLoss = 0;
  for (const t of trades) {
    if (t.hit) { curWin++; curLoss = 0; maxWinStreak = Math.max(maxWinStreak, curWin); }
    else { curLoss++; curWin = 0; maxLossStreak = Math.max(maxLossStreak, curLoss); }
  }

  // 盈亏比
  const winRatio = losing > 0 ? profitable / losing : profitable;

  // ROI (假设初始资金 1000 USD)
  const initialCapital = 1000;
  const roi = totalPnL / initialCapital * 100;

  // 按离场原因统计
  const exitReasonMap = new Map();
  for (const t of trades) {
    const reason = t.exitReason || '持有到结算';
    if (!exitReasonMap.has(reason)) {
      exitReasonMap.set(reason, { count: 0, hits: 0, pnl: 0 });
    }
    const r = exitReasonMap.get(reason);
    r.count++;
    if (t.hit) r.hits++;
    r.pnl += t.pnl;
  }

  return {
    total, hits, misses,
    profitable, losing, flat,
    totalPnL, avgPnL,
    winRate: profitable / total * 100,
    hitRate: hits / total * 100,
    winRatio,
    maxWinStreak, maxLossStreak,
    roi,
    cityBreakdown: Array.from(cityMap.entries()).map(([city, data]) => ({
      city, ...data,
      hitRate: data.trades > 0 ? data.hits / data.trades * 100 : 0,
      avgPnL: data.trades > 0 ? data.pnl / data.trades : 0,
    })),
    exitReasonBreakdown: Array.from(exitReasonMap.entries()).map(([reason, data]) => ({
      reason, ...data,
      winRate: data.count > 0 ? data.hits / data.count * 100 : 0,
    })),
  };
}

// 生成 Markdown 报告
function generateReport(metrics, trades) {
  if (!metrics) return '无法生成报告，没有交易数据';

  // 日期范围
  const dates = trades.map(t => t.date).filter(Boolean).sort();
  const dateRange = dates.length > 0 ? `${dates[0]} 至 ${dates[dates.length - 1]}` : 'N/A';

  // 城市列表
  const cities = [...new Set(trades.map(t => t.city))].sort();

  let report = `# 现有策略回测报告

**回测日期范围**：${dateRange}
**覆盖城市**：${cities.join(', ')}
**总交易笔数**：${trades.length}
**报告生成时间**：${new Date().toISOString().slice(0, 19).replace('T', ' ')}

---

## 总体统计

| 指标 | 数值 |
|------|------|
| 总交易笔数 | ${metrics.total} |
| 命中 | ${metrics.hits} |
| 未命中 | ${metrics.misses} |
| 命中率 | ${metrics.hitRate.toFixed(2)}% |
| 胜率(盈利笔数) | ${metrics.winRate.toFixed(2)}% (${metrics.profitable}/${metrics.total}) |
| 亏损笔数 | ${metrics.losing} |
| 平手笔数 | ${metrics.flat} |
| 盈亏比 | ${metrics.winRatio.toFixed(2)} |
| 总盈亏 | $${metrics.totalPnL.toFixed(2)} |
| 平均盈亏 | $${metrics.avgPnL.toFixed(2)} |
| 最大连续盈利 | ${metrics.maxWinStreak} 笔 |
| 最大连续亏损 | ${metrics.maxLossStreak} 笔 |
| ROI (1000 USD 本金) | ${metrics.roi.toFixed(2)}% |

---

## 分城市统计

| 城市 | 交易笔数 | 命中 | 命中率 | 盈利笔数 | 总盈亏 | 平均盈亏 |
|------|---------|------|--------|---------|-------|---------|
`;

  for (const c of metrics.cityBreakdown) {
    const pnlStr = c.pnl >= 0 ? `+$${c.pnl.toFixed(2)}` : `-$${Math.abs(c.pnl).toFixed(2)}`;
    const avgPnLStr = c.avgPnL >= 0 ? `+$${c.avgPnL.toFixed(2)}` : `-$${Math.abs(c.avgPnL).toFixed(2)}`;
    report += `| ${c.city} | ${c.trades} | ${c.hits} | ${c.hitRate.toFixed(1)}% | ${c.profitable} | ${pnlStr} | ${avgPnLStr} |\n`;
  }

  report += `\n---\n`;

  // 按离场原因统计
  report += `\n## 离场原因统计\n\n`;
  report += `| 离场原因 | 笔数 | 命中 | 胜率 | 总盈亏 |\n`;
  report += `|---------|------|------|------|-------|\n`;
  for (const r of metrics.exitReasonBreakdown) {
    const pnlStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(2)}` : `-$${Math.abs(r.pnl).toFixed(2)}`;
    report += `| ${r.reason} | ${r.count} | ${r.hits} | ${r.winRate.toFixed(1)}% | ${pnlStr} |\n`;
  }

  report += `\n---\n`;

  // 交易明细
  report += `\n## 交易明细\n\n`;
  report += `| ID | 日期 | 城市 | 持仓桶 | 入场价 | 实际温度 | 命中 | 盈亏 | 离场原因 |\n`;
  report += `|----|------|------|-------|--------|---------|------|------|---------|\n`;

  trades.forEach((t, i) => {
    const bucketsStr = t.bucketLabels.join('+');
    const hitStr = t.hit ? '✅' : '❌';
    const pnlStr = t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`;
    report += `| ${i + 1} | ${t.date} | ${t.city} | ${bucketsStr} | ${t.entryPrice.toFixed(3)} | ${t.actualTemp !== null ? t.actualTemp + '°C' : 'N/A'} | ${hitStr} | ${pnlStr} | ${t.exitReason} |\n`;
  });

  report += `\n---\n`;
  report += `> 回测基于现有策略（TradingDecisionEngine + ExitStrategy）\n`;
  report += `> 策略核心：双桶区间选桶 + 持有到结算\n`;
  report += `> 数据来源：data/backtest/ 目录下的历史回测 detail CSV 文件\n`;

  return report;
}

// 主函数
async function main() {
  console.log('=== 现有策略回测开始 ===\n');

  const backtestDir = path.join(PROJECT_ROOT, 'data', 'backtest');
  if (!fs.existsSync(backtestDir)) {
    console.error('回测数据目录不存在:', backtestDir);
    process.exit(1);
  }

  const allTrades = loadAllBacktestTrades(backtestDir);
  console.log(`从 ${backtestDir} 加载了 ${allTrades.length} 笔交易\n`);

  if (allTrades.length === 0) {
    console.error('未找到有效交易数据');
    process.exit(1);
  }

  const metrics = calculateMetrics(allTrades);
  const report = generateReport(metrics, allTrades);

  // 输出到控制台
  console.log(report);

  // 保存报告
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const reportPath = path.join(backtestDir, `backtest-existing-strategy_${timestamp}.md`);
  fs.writeFileSync(reportPath, report, 'utf-8');
  console.log(`\n报告已保存到: ${reportPath}`);
}

main().catch(err => {
  console.error('回测失败:', err);
  process.exit(1);
});