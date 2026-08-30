/**
 * London 离散度参数优化回测对比
 *
 * 对比策略：
 *   [旧] 硬阈值 5°C / 惩罚公式 (d-1)/3 / 权重 1.4
 *   [新] 硬阈值 2°C / 惩罚公式 (d-0.5)/0.5 / 权重 3.0
 *
 * 方式：读取已有回测 detail CSV + 从实际温度/偏差重建模型分歧，
 * 模拟新参数下哪些交易会被跳过或被扣分至不进场。
 *
 * 用法: node scripts/backtest-london-dispersion.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ==================== 旧参数 ====================
const OLD = {
  hardThreshold: 5,
  penaltyMin: 1,
  penaltyRange: 3,
  weight: 1.4,
};

// ==================== 新参数（已修改） ====================
const NEW = {
  hardThreshold: 2,
  penaltyMin: 0.5,
  penaltyRange: 0.5,
  weight: 3.0,
};

function scoreDispersionPenalty(dispersion, params) {
  if (dispersion <= params.penaltyMin) return 0;
  return Math.min(1, (dispersion - params.penaltyMin) / params.penaltyRange);
}

function loadLondonTrades(backtestDir) {
  const files = fs.readdirSync(backtestDir)
    .filter(f => f.startsWith('backtest-detail_') && f.endsWith('.csv'))
    .sort()
    .reverse(); // 最新的文件优先（参数更新后最后一次回测反映最新策略）

  const seen = new Set();
  const trades = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(backtestDir, file), 'utf-8');
    const lines = content.trim().split('\n');
    if (lines.length < 2) continue;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const v = line.split(',');
      if (v.length < 12) continue;

      const marketId = v[0];
      if (seen.has(marketId)) continue;
      seen.add(marketId);

      // 只分析 London
      const city = v[1] || '';
      if (city !== 'london') continue;

      const entryPrice = parseFloat(v[4]);
      const actualTemp = v[8] ? parseFloat(v[8]) : null;
      const pnl = v[11] ? parseFloat(v[11]) : null;
      const resultType = v[9] || '';

      if (isNaN(entryPrice) || entryPrice <= 0) continue;

      // 从偏差重建模型预报温度
      // 偏差 = 实际 - 预报 → 预报 = 实际 - 偏差
      const ecmwfBias = v[17] ? parseFloat(v[17]) : null;
      const gfsBias = v[18] ? parseFloat(v[18]) : null;
      const iconBias = v[19] ? parseFloat(v[19]) : null;

      trades.push({
        marketId,
        date: v[2] || '',
        bucketCombo: v[3] || '',
        entryPrice,
        actualTemp,
        pnl: pnl !== null ? pnl : 0,
        hit: resultType === '命中',
        ecmwfBias, gfsBias, iconBias,
        exitReason: v[12] === '1' ? '漂移离场' : v[16] === '1' ? '价格止损' : v[15] === '1' ? 'D0失配' : v[14] ? '峰值离场' : '持有到结算',
      });
    }
  }
  return trades;
}

function computeDispersion(trade) {
  // 从实际温度 + 偏差重建模型预报温度
  // 偏差 = 实际 - 预报 → 预报 = 实际 - 偏差
  const forecasts = [];
  if (trade.actualTemp !== null) {
    if (trade.ecmwfBias !== null) forecasts.push(trade.actualTemp - trade.ecmwfBias);
    if (trade.gfsBias !== null) forecasts.push(trade.actualTemp - trade.gfsBias);
    if (trade.iconBias !== null) forecasts.push(trade.actualTemp - trade.iconBias);
  }
  if (forecasts.length < 2) return null; // 无法计算分歧

  const mean = forecasts.reduce((s, t) => s + t, 0) / forecasts.length;
  const variance = forecasts.reduce((s, t) => s + (t - mean) ** 2, 0) / forecasts.length;
  const stdDev = Math.sqrt(variance);
  return { dispersion: stdDev, forecasts, mean };
}

function generateHtmlReport(originalTrades, newTrades) {
  const oldPnl = originalTrades.reduce((s, t) => s + t.pnl, 0);
  const newPnl = newTrades.reduce((s, t) => s + t.pnl, 0);
  const oldHits = originalTrades.filter(t => t.hit).length;
  const newHits = newTrades.filter(t => t.hit).length;
  const oldCount = originalTrades.length;
  const newCount = newTrades.length;

  const skipped = originalTrades.filter(t => !newTrades.find(n => n.marketId === t.marketId));
  const skippedPnl = skipped.reduce((s, t) => s + t.pnl, 0);
  const skippedLosses = skipped.filter(t => t.pnl < 0).length;
  const skippedWins = skipped.filter(t => t.pnl > 0).length;

  const pnlDiff = newPnl - oldPnl;

  const tradeRows = originalTrades.map(t => {
    const newT = newTrades.find(n => n.marketId === t.marketId);
    const isSkipped = !newT;
    const oldPnlStr = t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`;
    const newPnlStr = isSkipped ? '跳过' : (newT.pnl >= 0 ? `+$${newT.pnl.toFixed(2)}` : `-$${Math.abs(newT.pnl).toFixed(2)}`);

    const models = [];
    if (t.ecmwfBias !== null) models.push(`ECMWF=${t.ecmwfBias.toFixed(2)}°C`);
    if (t.gfsBias !== null) models.push(`GFS=${t.gfsBias.toFixed(2)}°C`);
    if (t.iconBias !== null) models.push(`ICON=${t.iconBias.toFixed(2)}°C`);
    const modelsStr = models.join(' ');

    // 重建模型预报温度
    const forecasts = [];
    if (t.actualTemp !== null) {
      if (t.ecmwfBias !== null) forecasts.push((t.actualTemp - t.ecmwfBias).toFixed(1));
      if (t.gfsBias !== null) forecasts.push((t.actualTemp - t.gfsBias).toFixed(1));
      if (t.iconBias !== null) forecasts.push((t.actualTemp - t.iconBias).toFixed(1));
    }
    const forecastStr = forecasts.length > 0 ? forecasts.join('°C, ') + '°C' : 'N/A';

    // 旧惩罚
    let oldPenalty = 0;
    let oldTotalScore = 0;
    let newPenalty = 0;
    let newTotalScore = 0;
    let dispersionVal = 0;

    const disp = computeDispersion(t);
    if (disp) {
      dispersionVal = disp.dispersion;
      oldPenalty = scoreDispersionPenalty(disp.dispersion, OLD) * OLD.weight;
      newPenalty = scoreDispersionPenalty(disp.dispersion, NEW) * NEW.weight;
      // 估算总分影响（假设其他 6 因子平均得分为 0.5）
      const otherScore = 0.5 * (1.6 + 1.2 + 1.0 + 1.5 + 1.1 + 1.3);
      oldTotalScore = otherScore - oldPenalty;
      newTotalScore = otherScore - newPenalty;
    }

    const oldBlocked = disp && disp.dispersion > OLD.hardThreshold;
    const newBlocked = disp && disp.dispersion > NEW.hardThreshold;

    return { ...t, isSkipped, oldPnlStr, newPnlStr, modelsStr, forecastStr, dispersionVal, oldPenalty, newPenalty, oldTotalScore, newTotalScore, oldBlocked, newBlocked };
  });

  const hasDispersion = tradeRows.filter(t => t.dispersionVal > 0).length;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>London 离散度参数优化 — 回测对比</title>
<style>
  :root {
    --bg: #0f172a;
    --card: #1e293b;
    --border: #334155;
    --text: #e2e8f0;
    --text-muted: #94a3b8;
    --green: #22c55e;
    --red: #ef4444;
    --amber: #f59e0b;
    --blue: #3b82f6;
    --purple: #8b5cf6;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 32px 24px;
    max-width: 1400px;
    margin: 0 auto;
  }
  h1 { font-size: 28px; margin-bottom: 8px; }
  h2 { font-size: 22px; margin: 32px 0 16px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
  h3 { font-size: 18px; margin: 24px 0 12px; }
  .subtitle { color: var(--text-muted); margin-bottom: 24px; font-size: 14px; }

  .summary-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 12px; margin-bottom: 32px;
  }
  .summary-card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 12px; padding: 16px; text-align: center;
  }
  .summary-card .value { font-size: 26px; font-weight: 700; }
  .summary-card .label { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
  .summary-card .sub-value { font-size: 13px; margin-top: 4px; }
  .green { color: var(--green); }
  .red { color: var(--red); }
  .amber { color: var(--amber); }
  .blue { color: var(--blue); }

  table {
    width: 100%; border-collapse: collapse;
    background: var(--card); border-radius: 12px; overflow: hidden;
    margin-bottom: 24px; font-size: 12px;
  }
  th {
    background: rgba(255,255,255,0.05); padding: 10px 6px;
    text-align: left; font-weight: 600; white-space: nowrap;
    border-bottom: 1px solid var(--border);
  }
  td { padding: 6px; border-bottom: 1px solid rgba(255,255,255,0.05); }
  tr:hover { background: rgba(255,255,255,0.03); }
  tr.skipped { opacity: 0.5; }
  tr.skipped td { text-decoration: line-through; }

  .comparison-row {
    display: grid; grid-template-columns: 1fr 1fr;
    gap: 16px; margin-bottom: 24px;
  }
  .comparison-card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 12px; padding: 20px;
  }
  .comparison-card .title { font-size: 16px; font-weight: 600; margin-bottom: 12px; }
  .comparison-card .stat { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
  .comparison-card .stat:last-child { border-bottom: none; }
  .comparison-card .stat .label { color: var(--text-muted); }
  .comparison-card .stat .value { font-weight: 600; }
  .old-card { border-color: var(--amber); }
  .new-card { border-color: var(--green); }

  .badge {
    display: inline-block; padding: 1px 6px; border-radius: 8px;
    font-size: 10px; font-weight: 600;
  }
  .badge-hit { background: rgba(34,197,94,0.15); color: var(--green); }
  .badge-miss { background: rgba(239,68,68,0.15); color: var(--red); }
  .badge-skip { background: rgba(245,158,11,0.15); color: var(--amber); }

  .highlight { background: rgba(245,158,11,0.08); }
</style>
</head>
<body>

<h1>London 离散度参数优化 — 回测对比</h1>
<p class="subtitle">对比旧参数 vs 新参数对 London 策略的影响 | 报告时间 ${new Date().toISOString().slice(0, 19).replace('T', ' ')}</p>

<div class="summary-grid">
  <div class="summary-card blue">
    <div class="value">${oldCount}</div>
    <div class="label">旧参数交易笔数</div>
  </div>
  <div class="summary-card blue">
    <div class="value">${newCount}</div>
    <div class="label">新参数交易笔数</div>
  </div>
  <div class="summary-card ${oldPnl >= 0 ? 'green' : 'red'}">
    <div class="value">${oldPnl >= 0 ? '+' : ''}$${oldPnl.toFixed(2)}</div>
    <div class="label">旧参数总盈亏</div>
  </div>
  <div class="summary-card ${newPnl >= 0 ? 'green' : 'red'}">
    <div class="value">${newPnl >= 0 ? '+' : ''}$${newPnl.toFixed(2)}</div>
    <div class="label">新参数总盈亏</div>
  </div>
  <div class="summary-card ${newPnl > oldPnl ? 'green' : 'red'}">
    <div class="value">${pnlDiff >= 0 ? '+' : ''}$${pnlDiff.toFixed(2)}</div>
    <div class="label">盈亏变化</div>
  </div>
  <div class="summary-card amber">
    <div class="value">${skipped.length}</div>
    <div class="label">被跳过的交易</div>
    <div class="sub-value">亏损 ${skippedLosses} 笔 / 盈利 ${skippedWins} 笔 / 合计 $${skippedPnl.toFixed(2)}</div>
  </div>
</div>

<!-- 参数对比 -->
<h2>参数对比</h2>
<div class="comparison-row">
  <div class="comparison-card old-card">
    <div class="title">旧参数</div>
    <div class="stat"><span class="label">硬阈值</span><span class="value">≥ ${OLD.hardThreshold}°C 跳过</span></div>
    <div class="stat"><span class="label">惩罚公式</span><span class="value">max(0, (d-${OLD.penaltyMin})/${OLD.penaltyRange})</span></div>
    <div class="stat"><span class="label">惩罚权重</span><span class="value">${OLD.weight}</span></div>
    <div class="stat"><span class="label">1°C 时惩罚分</span><span class="value">0</span></div>
    <div class="stat"><span class="label">2°C 时惩罚分</span><span class="value">${(scoreDispersionPenalty(2, OLD) * OLD.weight).toFixed(2)}</span></div>
  </div>
  <div class="comparison-card new-card">
    <div class="title">新参数</div>
    <div class="stat"><span class="label">硬阈值</span><span class="value">≥ ${NEW.hardThreshold}°C 跳过</span></div>
    <div class="stat"><span class="label">惩罚公式</span><span class="value">max(0, (d-${NEW.penaltyMin})/${NEW.penaltyRange})</span></div>
    <div class="stat"><span class="label">惩罚权重</span><span class="value">${NEW.weight}</span></div>
    <div class="stat"><span class="label">1°C 时惩罚分</span><span class="value">${(scoreDispersionPenalty(1, NEW) * NEW.weight).toFixed(2)}</span></div>
    <div class="stat"><span class="label">2°C 时惩罚分</span><span class="value">${(scoreDispersionPenalty(2, NEW) * NEW.weight).toFixed(2)}</span></div>
  </div>
</div>

<!-- 交易明细 -->
<h2>交易明细</h2>
<table>
<thead>
<tr>
  <th>日期</th>
  <th>持仓桶</th>
  <th>入场价</th>
  <th>实际温度</th>
  <th>结果</th>
  <th>旧盈亏</th>
  <th>新状态</th>
  <th>模型预报(°C)</th>
  <th>模型偏差</th>
  <th>离散度</th>
  <th>旧惩罚</th>
  <th>新惩罚</th>
  <th>离场方式</th>
</tr>
</thead>
<tbody>
${tradeRows.map(t => {
  const hitBadge = t.hit ? '<span class="badge badge-hit">命中</span>' : '<span class="badge badge-miss">未中</span>';
  const skipBadge = t.isSkipped ? '<span class="badge badge-skip">跳过</span>' : '继续';
  const rowClass = t.isSkipped ? 'skipped' : '';
  const dispStr = t.dispersionVal > 0 ? t.dispersionVal.toFixed(2) + '°C' : 'N/A';
  const oldPenaltyStr = t.oldPenalty.toFixed(2);
  const newPenaltyStr = t.newPenalty.toFixed(2);
  const oldBlocked = t.oldBlocked ? '⚠️' : '';
  const newBlocked = t.newBlocked ? '⚠️' : '';
  const highlight = t.dispersionVal > 1 ? ' class="highlight"' : '';

  return `<tr${rowClass}${highlight}>
    <td>${t.date}</td>
    <td>${t.bucketCombo}</td>
    <td>${t.entryPrice.toFixed(3)}</td>
    <td>${t.actualTemp !== null ? t.actualTemp + '°C' : 'N/A'}</td>
    <td>${hitBadge}</td>
    <td class="${t.pnl >= 0 ? 'green' : 'red'}">${t.oldPnlStr}</td>
    <td>${skipBadge}</td>
    <td style="font-size:11px">${t.forecastStr}</td>
    <td style="font-size:11px">${t.modelsStr}</td>
    <td>${dispStr} ${newBlocked}</td>
    <td>${oldPenaltyStr}</td>
    <td>${newPenaltyStr}</td>
    <td style="font-size:11px">${t.exitReason}</td>
  </tr>`;
}).join('\n')}
</tbody>
</table>

<h2>分析总结</h2>
<table>
<thead><tr><th>指标</th><th>旧参数</th><th>新参数</th><th>变化</th></tr></thead>
<tbody>
  <tr><td>交易笔数</td><td>${oldCount}</td><td>${newCount}</td><td class="${newCount < oldCount ? 'green' : 'red'}">${newCount - oldCount < 0 ? '' : '+'}${newCount - oldCount}</td></tr>
  <tr><td>命中笔数</td><td>${oldHits}</td><td>${newHits}</td><td class="${newHits >= oldHits ? 'green' : 'red'}">${newHits - oldHits < 0 ? '' : '+'}${newHits - oldHits}</td></tr>
  <tr><td>总盈亏</td><td class="${oldPnl >= 0 ? 'green' : 'red'}">$${oldPnl.toFixed(2)}</td><td class="${newPnl >= 0 ? 'green' : 'red'}">$${newPnl.toFixed(2)}</td><td class="${pnlDiff >= 0 ? 'green' : 'red'}">${pnlDiff >= 0 ? '+' : ''}$${pnlDiff.toFixed(2)}</td></tr>
  <tr><td>被跳过交易</td><td colspan="2">${skipped.length} 笔</td><td>亏损 ${skippedLosses} 笔 / 盈利 ${skippedWins} 笔</td></tr>
  <tr><td>跳过交易合计盈亏</td><td colspan="3">$${skippedPnl.toFixed(2)}</td></tr>
</tbody>
</table>

<p class="subtitle">
  * 新参数：硬阈值 ≥2°C 跳过 / 0.5°C 起罚 1°C 满分 / 权重 3.0<br>
  * 离散度从模型预报温度的标准差重建（实际温度 - 偏差）<br>
  * 橙色高亮行 = 离散度 &gt; 1°C（模型分歧较大）
</p>

</body>
</html>`;
}

function main() {
  const backtestDir = path.join(PROJECT_ROOT, 'data', 'backtest');
  if (!fs.existsSync(backtestDir)) {
    console.error('回测数据目录不存在:', backtestDir);
    process.exit(1);
  }

  console.log('=== London 离散度参数优化回测对比 ===\n');

  const allTrades = loadLondonTrades(backtestDir);
  console.log(`加载了 ${allTrades.length} 笔 London 交易\n`);

  // 过滤已结算的交易
  const settledTrades = allTrades.filter(t => t.actualTemp !== null);
  console.log(`已结算: ${settledTrades.length} 笔`);

  // 计算每笔交易的离散度
  for (const t of settledTrades) {
    t.dispersion = computeDispersion(t);
  }

  const hasDisp = settledTrades.filter(t => t.dispersion !== null);
  console.log(`可计算离散度: ${hasDisp.length} 笔`);

  if (hasDisp.length > 0) {
    const avgDisp = hasDisp.reduce((s, t) => s + t.dispersion.dispersion, 0) / hasDisp.length;
    const maxDisp = Math.max(...hasDisp.map(t => t.dispersion.dispersion));
    console.log(`平均离散度: ${avgDisp.toFixed(2)}°C, 最大离散度: ${maxDisp.toFixed(2)}°C`);
  }

  // 旧参数：所有交易保留
  const oldTrades = settledTrades;

  // 新参数：应用硬阈值 + 新惩罚
  const newTrades = settledTrades.filter(t => {
    if (!t.dispersion) return true; // 无法计算离散度，保留
    // 新硬阈值：离散度 > 2°C 直接跳过
    if (t.dispersion.dispersion > NEW.hardThreshold) return false;
    return true;
  });

  const oldPnl = oldTrades.reduce((s, t) => s + t.pnl, 0);
  const newPnl = newTrades.reduce((s, t) => s + t.pnl, 0);
  const skipped = oldTrades.filter(t => !newTrades.find(n => n.marketId === t.marketId));
  const skippedPnl = skipped.reduce((s, t) => s + t.pnl, 0);

  console.log(`\n旧参数: ${oldTrades.length} 笔, 总盈亏 $${oldPnl.toFixed(2)}`);
  console.log(`新参数: ${newTrades.length} 笔, 总盈亏 $${newPnl.toFixed(2)}`);
  console.log(`被跳过: ${skipped.length} 笔, 合计盈亏 $${skippedPnl.toFixed(2)}`);

  if (skipped.length > 0) {
    console.log('\n跳过明细:');
    for (const t of skipped) {
      const pnlStr = t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`;
      console.log(`  ${t.date} ${t.bucketCombo} 入场价${t.entryPrice.toFixed(3)} 实际${t.actualTemp}°C ${pnlStr} 离散度${t.dispersion.dispersion.toFixed(2)}°C`);
    }
  }

  // 生成 HTML 报告
  const html = generateHtmlReport(oldTrades, newTrades);
  const reportPath = path.join(backtestDir, 'london-dispersion-comparison.html');
  fs.writeFileSync(reportPath, html, 'utf-8');
  console.log(`\n报告已保存到: ${reportPath}`);
}

main();