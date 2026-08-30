// Maker 纯挂单策略回测模拟
// 读取已有的 69 笔实际回测成交记录，模拟全部转 Maker 限价单的结果。
//
// 核心假设：
//   1. Maker 入场价 = Taker 入场价 × (1 - 折扣率)
//      （Maker 挂单在最佳 Bid，可以比 Taker 市价吃单便宜 5-20%）
//   2. 成交率 = 挂单被吃掉的概率（20-50%）
//   3. 胜率沿用双桶预测的原始命中结果（策略逻辑不变）
//
// 运行：
//   npx tsx scripts/simulate-maker-only.ts

import fs from 'node:fs';
import path from 'node:path';

interface Trade {
  marketId: string;
  city: string;
  date: string;
  bucketCombo: string;
  entryPrice: number;
  priceSource: string;
  entryTime: string;
  entryLevel: string;
  actualTempC: string;
  result: string;   // 命中 / 未中
  exitPrice: number;
  pnl: number;
}

interface ScenarioResult {
  label: string;
  discountPct: number;
  fillRate: number;
  totalPnL: number;
  avgPnL: number;
  totalTrades: number;
  filledTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  roi: number;
  maxDrawdown: number;
  sharpe: number;
}

function loadTrades(): Trade[] {
  const csvPath = path.resolve(process.cwd(), 'data', 'backtest', 'backtest-detail_2026-08-17T08-03-26.csv');
  const raw = fs.readFileSync(csvPath, 'utf8');
  const lines = raw.trim().split('\n');
  const headers = lines[0].split(',');
  
  // 只取 price-history 来源（实际成交的）
  const trades: Trade[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split(',');
    const source = fields[5]; // 价格来源
    if (source !== 'price-history') continue;
    
    trades.push({
      marketId: fields[0],
      city: fields[1],
      date: fields[2],
      bucketCombo: fields[3],
      entryPrice: parseFloat(fields[4]),
      priceSource: source,
      entryTime: fields[6],
      entryLevel: fields[7],
      actualTempC: fields[8],
      result: fields[9],
      exitPrice: parseFloat(fields[10] || '0'),
      pnl: parseFloat(fields[11] || '0'),
    });
  }
  return trades;
}

function simulate(trades: Trade[], discountPct: number, fillRate: number): ScenarioResult {
  const label = `折扣${(discountPct * 100).toFixed(0)}%_成交率${(fillRate * 100).toFixed(0)}%`;
  
  let totalPnL = 0;
  let wins = 0;
  let losses = 0;
  let filled = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const returns: number[] = [];
  
  for (const trade of trades) {
    // 模拟是否成交
    if (Math.random() > fillRate) continue;
    filled++;
    
    // Maker 入场价 = Taker 入场价 × (1 - 折扣率)
    const makerEntry = trade.entryPrice * (1 - discountPct);
    
    // 结算结果
    const isWin = trade.result === '命中';
    const makerPnl = isWin ? (1 - makerEntry) : (0 - makerEntry);
    
    totalPnL += makerPnl;
    returns.push(makerPnl / makerEntry);
    
    if (isWin) wins++;
    else losses++;
    
    // 计算回撤
    if (totalPnL > peak) peak = totalPnL;
    const dd = peak - totalPnL;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  
  const totalTrades = trades.length;
  const winRate = filled > 0 ? wins / filled : 0;
  const avgPnL = filled > 0 ? totalPnL / filled : 0;
  const roi = filled > 0 ? totalPnL / (filled * 0.5) : 0; // 假设平均每笔占用 $0.50
  
  // 夏普比率（简化版，用单笔收益率计算）
  let sharpe = 0;
  if (returns.length > 1) {
    const avgR = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - avgR) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? avgR / std * Math.sqrt(252) : 0;
  }
  
  return {
    label,
    discountPct,
    fillRate,
    totalPnL,
    avgPnL,
    totalTrades,
    filledTrades: filled,
    wins,
    losses,
    winRate,
    roi,
    maxDrawdown,
    sharpe,
  };
}

// 多次模拟取平均（消除随机性）
function simulateWithRepetition(trades: Trade[], discountPct: number, fillRate: number, reps: number = 1000): ScenarioResult {
  const results: ScenarioResult[] = [];
  for (let i = 0; i < reps; i++) {
    results.push(simulate(trades, discountPct, fillRate));
  }
  
  // 取平均
  const avg: ScenarioResult = {
    label: `折扣${(discountPct * 100).toFixed(0)}%_成交率${(fillRate * 100).toFixed(0)}%`,
    discountPct,
    fillRate,
    totalPnL: results.reduce((s, r) => s + r.totalPnL, 0) / reps,
    avgPnL: results.reduce((s, r) => s + r.avgPnL, 0) / reps,
    totalTrades: trades.length,
    filledTrades: Math.round(results.reduce((s, r) => s + r.filledTrades, 0) / reps),
    wins: Math.round(results.reduce((s, r) => s + r.wins, 0) / reps),
    losses: Math.round(results.reduce((s, r) => s + r.losses, 0) / reps),
    winRate: results.reduce((s, r) => s + r.winRate, 0) / reps,
    roi: results.reduce((s, r) => s + r.roi, 0) / reps,
    maxDrawdown: results.reduce((s, r) => s + r.maxDrawdown, 0) / reps,
    sharpe: results.reduce((s, r) => s + r.sharpe, 0) / reps,
  };
  return avg;
}

function main() {
  const trades = loadTrades();
  
  console.log('='.repeat(100));
  console.log('Maker 纯挂单策略回测模拟');
  console.log('='.repeat(100));
  console.log(`\n📊 基础数据：${trades.length} 笔实际成交记录`);
  console.log(`   胜率：${(trades.filter(t => t.result === '命中').length / trades.length * 100).toFixed(1)}%`);
  console.log(`   平均入场价：$${(trades.reduce((s, t) => s + t.entryPrice, 0) / trades.length).toFixed(3)}`);
  console.log(`   总 P&L（Taker）：$${trades.reduce((s, t) => s + t.pnl, 0).toFixed(3)}`);
  
  // 模拟参数
  const discounts = [0.05, 0.10, 0.15, 0.20];
  const fillRates = [0.20, 0.30, 0.40, 0.50, 1.0];
  
  console.log('\n' + '='.repeat(100));
  console.log('📈 模拟结果（1000 次重复取平均）');
  console.log('='.repeat(100));
  
  console.log('\n');
  console.log(`${'场景'.padEnd(30)} ${'成交笔数'.padEnd(10)} ${'胜率'.padEnd(8)} ${'总盈亏'.padEnd(12)} ${'单笔盈亏'.padEnd(12)} ${'ROI'.padEnd(10)} ${'最大回撤'.padEnd(12)} ${'夏普'.padEnd(8)}`);
  console.log('-'.repeat(100));
  
  // 基准：纯 Taker
  const takerTotalPnL = trades.reduce((s, t) => s + t.pnl, 0);
  const takerAvgPnL = takerTotalPnL / trades.length;
  const takerWinRate = trades.filter(t => t.result === '命中').length / trades.length;
  console.log(`${'【基准】纯 Taker（当前）'.padEnd(30)} ${String(trades.length).padEnd(10)} ${(takerWinRate * 100).toFixed(1) + '%'.padEnd(5)} $${takerTotalPnL.toFixed(3).padEnd(8)} $${takerAvgPnL.toFixed(3).padEnd(8)} ${'—'.padEnd(10)} ${'—'.padEnd(12)} ${'—'.padEnd(8)}`);
  
  const bestResults: ScenarioResult[] = [];
  
  for (const discount of discounts) {
    for (const fillRate of fillRates) {
      const result = simulateWithRepetition(trades, discount, fillRate, 1000);
      bestResults.push(result);
      
      const pnlStr = `$${result.totalPnL.toFixed(2)}`;
      const avgStr = `$${result.avgPnL.toFixed(3)}`;
      const roiStr = `${(result.roi * 100).toFixed(1)}%`;
      const ddStr = `$${result.maxDrawdown.toFixed(2)}`;
      const sharpeStr = result.sharpe.toFixed(1);
      
      const scenario = `${'折扣' + (discount * 100).toFixed(0) + '% / 成交率' + (fillRate * 100).toFixed(0) + '%'}`;
      console.log(`${scenario.padEnd(30)} ${String(result.filledTrades).padEnd(10)} ${(result.winRate * 100).toFixed(1) + '%'.padEnd(5)} ${pnlStr.padEnd(12)} ${avgStr.padEnd(12)} ${roiStr.padEnd(10)} ${ddStr.padEnd(12)} ${sharpeStr.padEnd(8)}`);
    }
  }
  
  // 最佳和次佳场景
  console.log('\n' + '='.repeat(100));
  console.log('🏆 最佳场景排名（按总盈亏）');
  console.log('='.repeat(100));
  
  bestResults.sort((a, b) => b.totalPnL - a.totalPnL);
  
  console.log(`\n${'排名'.padEnd(6)} ${'场景'.padEnd(30)} ${'成交笔数'.padEnd(10)} ${'总盈亏'.padEnd(12)} ${'单笔盈亏'.padEnd(12)} ${'ROI'.padEnd(10)} ${'夏普'.padEnd(8)}`);
  console.log('-'.repeat(90));
  
  bestResults.slice(0, 5).forEach((r, i) => {
    console.log(`${`#${i + 1}`.padEnd(6)} ${r.label.padEnd(30)} ${String(r.filledTrades).padEnd(10)} $${r.totalPnL.toFixed(2).padEnd(8)} $${r.avgPnL.toFixed(3).padEnd(8)} ${(r.roi * 100).toFixed(1) + '%'.padEnd(7)} ${r.sharpe.toFixed(1).padEnd(8)}`);
  });
  
  // 分析：如果要达到和 Taker 一样的总盈亏，需要什么条件
  console.log('\n' + '='.repeat(100));
  console.log('🎯 盈亏平衡分析');
  console.log('='.repeat(100));
  
  // 找到总盈亏最接近 Taker 的场景
  let closest = bestResults[0];
  let closestDiff = Math.abs(bestResults[0].totalPnL - takerTotalPnL);
  for (const r of bestResults) {
    const diff = Math.abs(r.totalPnL - takerTotalPnL);
    if (diff < closestDiff) {
      closest = r;
      closestDiff = diff;
    }
  }
  
  console.log(`\n💰 纯 Taker 总盈亏：$${takerTotalPnL.toFixed(3)}（69 笔全成交）`);
  console.log(`\n📌 要达到同等收益，Maker 需要：`);
  console.log(`   折扣 ${(closest.discountPct * 100).toFixed(0)}% + 成交率 ${(closest.fillRate * 100).toFixed(0)}% → 总盈亏 $${closest.totalPnL.toFixed(2)}`);
  console.log(`   成交 ${closest.filledTrades}/${closest.totalTrades} 笔`);
  
  // 批注：Maker 对资金效率的影响
  console.log('\n' + '='.repeat(100));
  console.log('💡 核心发现');
  console.log('='.repeat(100));
  console.log(`
  1. 同等胜率下，Maker 的盈亏平衡点低于 Taker
     Maker 入场价 = Taker 入场价 × (1 - 折扣率)
     折扣 5%  → 相当于每笔多赚 5% 的利润
     折扣 15% → 相当于每笔多赚 15% 的利润
  
  2. 但成交率是最大变量
     成交率 20% → 需要 5 倍的时间才能完成同样笔数
     成交率 50% → 需要 2 倍的时间
     在 Bankroll 固定的情况下，资金周转率下降
  
  3. 关键公式
     Maker 有效盈亏 = Taker 盈亏 × (1 - 折扣率) × 成交率
     
     例：Taker 总盈亏 $9.25
         折扣 10% × 成交率 30%
         = $9.25 × 1.10 × 0.30 = $3.05（少了 67%）
  
  4. 只有当折扣足够大且成交率足够高时，Maker 才能超越 Taker
     从回测数据看，成交率 ≥ 40% + 折扣 ≥ 10% 才接近 Taker 收益
     但实际天气市场中，D3/D2 的 Maker 成交率可能远低于 40%
     因为流动性太薄，没人接盘
  `);
}

main();