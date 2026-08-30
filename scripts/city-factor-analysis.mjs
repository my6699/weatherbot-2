/**
 * 按城市深入分析每笔交易的因子得分
 * 从历史回测 detail CSV 中提取每笔交易数据，按城市分组，
 * 计算因子得分并生成可视化 HTML 报告。
 *
 * 用法: node scripts/city-factor-analysis.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ==================== 数据加载 ====================

function loadAllTrades(backtestDir) {
  const files = fs.readdirSync(backtestDir)
    .filter(f => f.startsWith('backtest-detail_') && f.endsWith('.csv'))
    .sort();

  const seen = new Set();
  const all = [];

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

      const entryPrice = parseFloat(v[4]);
      const actualTemp = v[8] ? parseFloat(v[8]) : null;
      const pnl = v[11] ? parseFloat(v[11]) : null;
      const resultType = v[9] || '';

      if (isNaN(entryPrice) || entryPrice <= 0) continue;

      const bucketCombo = v[3] || '';
      const bucketLabels = bucketCombo.split('+').map(b => b.split('-')[0]);

      // 离场原因
      const driftAway = v[12] === '1';
      const peakExitTime = v[14] || '';
      const d0Mismatch = v[15] === '1';
      const priceStop = v[16] === '1';

      let exitReason = '持有到结算';
      if (driftAway) exitReason = '漂移离场';
      else if (priceStop) exitReason = '价格止损';
      else if (d0Mismatch) exitReason = 'D0失配离场';
      else if (peakExitTime) exitReason = `峰值离场`;

      // 模型偏差
      const ecmwfBias = v[17] ? parseFloat(v[17]) : null;
      const gfsBias = v[18] ? parseFloat(v[18]) : null;
      const iconBias = v[19] ? parseFloat(v[19]) : null;

      all.push({
        marketId: v[0],
        city: v[1] || '',
        date: v[2] || '',
        bucketLabels,
        entryPrice,
        source: v[5] || '',
        entryTime: v[6] || '',
        horizon: v[7] || '',
        actualTemp,
        hit: resultType === '命中',
        exitPrice: v[10] ? parseFloat(v[10]) : null,
        pnl: pnl !== null ? pnl : 0,
        exitReason,
        ecmwfBias, gfsBias, iconBias,
        // 离场标志
        driftAway, peakExitTime, d0Mismatch, priceStop,
      });
    }
  }
  return all;
}

// ==================== 因子计算 ====================

function computeFactorScores(trade) {
  // 因子1: 入场效率 (越低越好 → 性价比越高)
  // entryPrice 0-1 范围，越低表示越便宜买
  const entryEfficiency = Math.max(0, 1 - trade.entryPrice);

  // 因子2: 模型偏差 (abs偏差越小，模型越准确)
  const biases = [trade.ecmwfBias, trade.gfsBias, trade.iconBias].filter(b => b !== null);
  const avgAbsBias = biases.length > 0
    ? biases.reduce((s, b) => s + Math.abs(b), 0) / biases.length
    : null;

  // 因子3: 温度预测准确度
  let tempAccuracy = null;
  if (trade.actualTemp !== null) {
    // 从桶标签估算预测温度
    const bucketNums = trade.bucketLabels
      .map(l => parseInt(l))
      .filter(n => !isNaN(n));
    if (bucketNums.length > 0) {
      const predictedTemp = bucketNums.reduce((s, n) => s + n, 0) / bucketNums.length;
      tempAccuracy = Math.max(0, 1 - Math.abs(trade.actualTemp - predictedTemp) / 10);
    }
  }

  // 因子4: 盈亏效率
  let pnlEfficiency = 0;
  if (trade.pnl !== 0 && trade.entryPrice > 0) {
    pnlEfficiency = trade.pnl / trade.entryPrice;
  }

  // 因子5: 命中得分
  const hitScore = trade.hit ? 1 : 0;

  // 因子6: 退出时机 (持有到结算 = 中性, 提前止损 = 差, 峰值离场 = 中性偏正)
  let exitTiming = 0;
  if (trade.exitReason === '价格止损') exitTiming = -1;
  else if (trade.exitReason === '持有到结算' && trade.hit) exitTiming = 1;
  else if (trade.exitReason === '持有到结算' && !trade.hit) exitTiming = -0.5;
  else if (trade.exitReason.includes('峰值离场') && trade.hit) exitTiming = 0.5;
  else if (trade.exitReason.includes('峰值离场') && !trade.hit) exitTiming = -0.3;

  // 综合因子得分 (加权)
  const totalScore =
    entryEfficiency * 0.20 +
    (avgAbsBias !== null ? Math.max(0, 1 - avgAbsBias / 3) * 0.15 : 0.10) +
    (tempAccuracy !== null ? tempAccuracy * 0.15 : 0.10) +
    Math.min(1, Math.max(-1, pnlEfficiency)) * 0.20 +
    hitScore * 0.20 +
    (exitTiming + 1) / 2 * 0.10;

  return {
    entryEfficiency: Math.round(entryEfficiency * 1000) / 1000,
    avgAbsBias: avgAbsBias !== null ? Math.round(avgAbsBias * 100) / 100 : null,
    tempAccuracy: tempAccuracy !== null ? Math.round(tempAccuracy * 100) / 100 : null,
    pnlEfficiency: Math.round(pnlEfficiency * 100) / 100,
    hitScore,
    exitTiming: Math.round(exitTiming * 100) / 100,
    totalScore: Math.round(totalScore * 1000) / 1000,
  };
}

// ==================== HTML 报告生成 ====================

function generateHtmlReport(cityData, allTrades) {
  const cities = Object.keys(cityData).sort();
  const settledTrades = allTrades.filter(t => t.actualTemp !== null);

  const cityRows = cities.map(city => {
    const d = cityData[city];
    const hitRate = d.settled > 0 ? (d.hits / d.settled * 100).toFixed(1) : 'N/A';
    const avgPnl = d.settled > 0 ? (d.totalPnl / d.settled).toFixed(2) : 'N/A';
    const avgScore = d.settled > 0 ? (d.totalScore / d.settled).toFixed(3) : 'N/A';
    const pnlStr = d.totalPnl >= 0 ? `+$${d.totalPnl.toFixed(2)}` : `-$${Math.abs(d.totalPnl).toFixed(2)}`;
    return { city, ...d, hitRate, avgPnl, avgScore, pnlStr };
  });

  cityRows.sort((a, b) => b.totalPnl - a.totalPnl);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>现有策略回测 — 按城市因子分析</title>
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
  h2 {
    font-size: 22px; margin: 32px 0 16px;
    padding-bottom: 8px; border-bottom: 1px solid var(--border);
  }
  h3 { font-size: 18px; margin: 24px 0 12px; }
  .subtitle { color: var(--text-muted); margin-bottom: 24px; font-size: 14px; }
  .stats-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px; margin-bottom: 32px;
  }
  .stat-card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 12px; padding: 16px; text-align: center;
  }
  .stat-card .value { font-size: 28px; font-weight: 700; }
  .stat-card .label { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
  .stat-card.green .value { color: var(--green); }
  .stat-card.red .value { color: var(--red); }
  .stat-card.blue .value { color: var(--blue); }
  .stat-card.amber .value { color: var(--amber); }

  table {
    width: 100%; border-collapse: collapse;
    background: var(--card); border-radius: 12px; overflow: hidden;
    margin-bottom: 24px; font-size: 13px;
  }
  th {
    background: rgba(255,255,255,0.05); padding: 10px 8px;
    text-align: left; font-weight: 600; white-space: nowrap;
    border-bottom: 1px solid var(--border);
  }
  td { padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); }
  tr:hover { background: rgba(255,255,255,0.03); }
  .hit { color: var(--green); }
  .miss { color: var(--red); }
  .profit { color: var(--green); }
  .loss { color: var(--red); }
  .flat { color: var(--text-muted); }

  .city-header {
    display: flex; align-items: center; gap: 12px; cursor: pointer;
    padding: 12px 16px; background: var(--card); border-radius: 12px;
    margin-bottom: 8px; border: 1px solid var(--border);
  }
  .city-header:hover { background: rgba(255,255,255,0.05); }
  .city-header .city-name { font-size: 18px; font-weight: 600; flex: 1; }
  .city-header .city-pnl { font-size: 16px; font-weight: 700; }
  .city-header .city-hits { font-size: 13px; color: var(--text-muted); }
  .city-detail { display: none; }
  .city-detail.open { display: block; }

  .bar-container { display: flex; align-items: center; gap: 8px; }
  .bar { height: 18px; border-radius: 4px; min-width: 4px; transition: width 0.3s; }
  .bar-green { background: var(--green); }
  .bar-red { background: var(--red); }
  .bar-blue { background: var(--blue); }
  .bar-amber { background: var(--amber); }
  .bar-label { font-size: 12px; color: var(--text-muted); white-space: nowrap; }

  .score-bar { display: inline-block; height: 8px; border-radius: 4px; margin-right: 4px; }
  .factor-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 16px; margin: 16px 0;
  }
  .factor-card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 10px; padding: 14px;
  }
  .factor-card .factor-name { font-size: 13px; color: var(--text-muted); margin-bottom: 4px; }
  .factor-card .factor-value { font-size: 20px; font-weight: 700; }
  .factor-card .factor-desc { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 11px; font-weight: 600;
  }
  .badge-hit { background: rgba(34,197,94,0.15); color: var(--green); }
  .badge-miss { background: rgba(239,68,68,0.15); color: var(--red); }
  .badge-settle { background: rgba(59,130,246,0.15); color: var(--blue); }
  .badge-stop { background: rgba(245,158,11,0.15); color: var(--amber); }
  .badge-peak { background: rgba(139,92,246,0.15); color: var(--purple); }
  .badge-drift { background: rgba(99,102,241,0.15); color: #6366f1; }
</style>
</head>
<body>

<h1>📊 现有策略回测 — 按城市因子分析</h1>
<p class="subtitle">
  总交易 ${allTrades.length} 笔 | 已结算 ${settledTrades.length} 笔 |
  覆盖 ${cities.length} 个城市 | 报告时间 ${new Date().toISOString().slice(0, 19).replace('T', ' ')}
</p>

<div class="stats-grid">
  <div class="stat-card blue">
    <div class="value">${settledTrades.length}</div>
    <div class="label">已结算笔数</div>
  </div>
  <div class="stat-card green">
    <div class="value">${settledTrades.filter(t => t.hit).length}</div>
    <div class="label">命中笔数</div>
  </div>
  <div class="stat-card red">
    <div class="value">${settledTrades.filter(t => !t.hit).length}</div>
    <div class="label">未命中笔数</div>
  </div>
  <div class="stat-card amber">
    <div class="value">${settledTrades.length > 0 ? (settledTrades.filter(t => t.hit).length / settledTrades.length * 100).toFixed(1) : 'N/A'}%</div>
    <div class="label">命中率</div>
  </div>
  <div class="stat-card ${settledTrades.reduce((s, t) => s + t.pnl, 0) >= 0 ? 'green' : 'red'}">
    <div class="value">${settledTrades.reduce((s, t) => s + t.pnl, 0) >= 0 ? '+' : ''}$${settledTrades.reduce((s, t) => s + t.pnl, 0).toFixed(2)}</div>
    <div class="label">总盈亏</div>
  </div>
  <div class="stat-card green">
    <div class="value">${settledTrades.filter(t => t.pnl > 0).length}</div>
    <div class="label">盈利笔数</div>
  </div>
</div>

<!-- 城市总览表 -->
<h2>🏙️ 城市总览</h2>
<table>
<thead>
<tr>
  <th>城市</th>
  <th>已结算</th>
  <th>命中</th>
  <th>命中率</th>
  <th>盈利</th>
  <th>总盈亏</th>
  <th>平均盈亏</th>
  <th>平均因子得分</th>
  <th>最佳交易</th>
  <th>最差交易</th>
</tr>
</thead>
<tbody>
${cityRows.map(r => {
  const best = r.bestPnl !== null ? `$${r.bestPnl.toFixed(2)}` : 'N/A';
  const worst = r.worstPnl !== null ? `$${r.worstPnl.toFixed(2)}` : 'N/A';
  return `<tr>
    <td><strong>${r.city}</strong></td>
    <td>${r.settled}</td>
    <td>${r.hits}</td>
    <td>${r.hitRate}</td>
    <td>${r.profitable}</td>
    <td class="${r.totalPnl >= 0 ? 'profit' : 'loss'}">${r.pnlStr}</td>
    <td>${r.avgPnl}</td>
    <td>${r.avgScore}</td>
    <td class="profit">${best}</td>
    <td class="loss">${worst}</td>
  </tr>`;
}).join('\n')}
</tbody>
</table>

<!-- 按城市展开 -->
<h2>🔍 按城市交易明细</h2>
${cityRows.map(r => {
  const trades = r.trades;
  const avgScore = r.avgScore;
  const avgEntry = trades.reduce((s, t) => s + t.entryPrice, 0) / trades.length;
  const avgBias = trades
    .map(t => [t.ecmwfBias, t.gfsBias, t.iconBias].filter(b => b !== null))
    .flat()
    .reduce((s, b) => s + Math.abs(b), 0) / Math.max(1, trades.filter(t => t.ecmwfBias !== null).length);

  const tradeRows = trades.map((t, i) => {
    const factors = t.factors;
    const hitBadge = t.hit
      ? '<span class="badge badge-hit">✅ 命中</span>'
      : '<span class="badge badge-miss">❌ 未中</span>';

    const exitBadge = t.exitReason === '持有到结算'
      ? '<span class="badge badge-settle">持有到结算</span>'
      : t.exitReason === '价格止损'
        ? '<span class="badge badge-stop">止损</span>'
        : t.exitReason.includes('峰值')
          ? '<span class="badge badge-peak">峰值离场</span>'
          : t.exitReason === '漂移离场'
            ? '<span class="badge badge-drift">漂移</span>'
            : `<span class="badge">${t.exitReason}</span>`;

    const pnlClass = t.pnl > 0 ? 'profit' : t.pnl < 0 ? 'loss' : 'flat';
    const pnlStr = t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`;

    const scoreBar = Math.round(factors.totalScore * 100);
    const scoreColor = factors.totalScore >= 0.6 ? 'var(--green)' : factors.totalScore >= 0.3 ? 'var(--amber)' : 'var(--red)';

    const bucketStr = t.bucketLabels.join('+');

    return `<tr>
      <td>${t.date}</td>
      <td>${bucketStr}</td>
      <td>${t.entryPrice.toFixed(3)}</td>
      <td>${t.actualTemp !== null ? t.actualTemp + '°C' : 'N/A'}</td>
      <td>${hitBadge}</td>
      <td class="${pnlClass}">${pnlStr}</td>
      <td>${exitBadge}</td>
      <td>
        <div class="bar-container">
          <div class="bar" style="width:${scoreBar}%;background:${scoreColor}"></div>
          <span class="bar-label">${factors.totalScore.toFixed(3)}</span>
        </div>
      </td>
    </tr>`;
  }).join('\n');

  return `<div class="city-section">
    <div class="city-header">
      <span class="city-name">${r.city}</span>
      <span class="city-hits">${r.hits}/${r.settled} 命中 · ${r.profitable} 盈利</span>
      <span class="city-pnl ${r.totalPnl >= 0 ? 'profit' : 'loss'}">${r.pnlStr}</span>
    </div>
    <div class="city-detail open">
      <div class="factor-grid">
        <div class="factor-card">
          <div class="factor-name">平均入场效率</div>
          <div class="factor-value" style="color:${avgEntry < 0.4 ? 'var(--green)' : 'var(--amber)'}">${(avgEntry * 100).toFixed(1)}%</div>
          <div class="factor-desc">入场价格越低 → 性价比越高</div>
        </div>
        <div class="factor-card">
          <div class="factor-name">平均模型偏差</div>
          <div class="factor-value" style="color:${avgBias < 1 ? 'var(--green)' : 'var(--red)'}">${avgBias.toFixed(2)}°C</div>
          <div class="factor-desc">ECMWF/GFS/ICON 平均绝对偏差</div>
        </div>
        <div class="factor-card">
          <div class="factor-name">平均因子得分</div>
          <div class="factor-value" style="color:${parseFloat(avgScore) >= 0.5 ? 'var(--green)' : 'var(--amber)'}">${avgScore}</div>
          <div class="factor-desc">综合因子得分 (0-1)</div>
        </div>
        <div class="factor-card">
          <div class="factor-name">平均盈亏</div>
          <div class="factor-value ${r.totalPnl >= 0 ? 'profit' : 'loss'}">${r.avgPnl}</div>
          <div class="factor-desc">每笔交易平均盈亏</div>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>日期</th>
            <th>持仓桶</th>
            <th>入场价</th>
            <th>实际温度</th>
            <th>结果</th>
            <th>盈亏</th>
            <th>离场方式</th>
            <th>因子得分</th>
          </tr>
        </thead>
        <tbody>
          ${tradeRows}
        </tbody>
      </table>
    </div>
  </div>`;
}).join('\n')}

<script>
  document.querySelectorAll('.city-header').forEach(header => {
    header.addEventListener('click', () => {
      const detail = header.nextElementSibling;
      detail.classList.toggle('open');
    });
  });
</script>

</body>
</html>`;
}

// ==================== 主函数 ====================

async function main() {
  console.log('=== 按城市因子分析 ===\n');

  const backtestDir = path.join(PROJECT_ROOT, 'data', 'backtest');
  if (!fs.existsSync(backtestDir)) {
    console.error('回测数据目录不存在:', backtestDir);
    process.exit(1);
  }

  const allTrades = loadAllTrades(backtestDir);
  console.log(`加载了 ${allTrades.length} 笔交易`);

  if (allTrades.length === 0) {
    console.error('未找到交易数据');
    process.exit(1);
  }

  // 过滤已结算的交易
  const settledTrades = allTrades.filter(t => t.actualTemp !== null);
  console.log(`已结算交易: ${settledTrades.length} 笔\n`);

  // 按城市分组
  const cityMap = {};
  for (const t of settledTrades) {
    const factors = computeFactorScores(t);
    t.factors = factors;

    if (!cityMap[t.city]) {
      cityMap[t.city] = {
        trades: [],
        settled: 0, hits: 0, totalPnl: 0, profitable: 0,
        totalScore: 0, bestPnl: -Infinity, worstPnl: Infinity,
      };
    }
    const d = cityMap[t.city];
    d.trades.push(t);
    d.settled++;
    if (t.hit) d.hits++;
    d.totalPnl += t.pnl;
    if (t.pnl > 0) d.profitable++;
    d.totalScore += factors.totalScore;
    if (t.pnl > d.bestPnl) d.bestPnl = t.pnl;
    if (t.pnl < d.worstPnl) d.worstPnl = t.pnl;
  }

  // 按城市排序（按盈亏降序）
  const cityData = Object.fromEntries(
    Object.entries(cityMap).sort((a, b) => b[1].totalPnl - a[1].totalPnl)
  );

  console.log('城市统计:');
  for (const [city, d] of Object.entries(cityData)) {
    const hitRate = (d.hits / d.settled * 100).toFixed(1);
    const pnlStr = d.totalPnl >= 0 ? `+$${d.totalPnl.toFixed(2)}` : `-$${Math.abs(d.totalPnl).toFixed(2)}`;
    const avgScore = (d.totalScore / d.settled).toFixed(3);
    console.log(`  ${city.padEnd(10)} ${d.settled}笔 命中率${hitRate}% 盈亏${pnlStr} 因子得分${avgScore}`);
  }

  // 生成 HTML 报告
  const html = generateHtmlReport(cityData, allTrades);
  const reportPath = path.join(backtestDir, 'city-factor-analysis.html');
  fs.writeFileSync(reportPath, html, 'utf-8');
  console.log(`\n报告已保存到: ${reportPath}`);
}

main().catch(err => {
  console.error('分析失败:', err);
  process.exit(1);
});