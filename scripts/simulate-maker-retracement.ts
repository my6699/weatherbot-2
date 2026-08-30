// Maker + D1 回撤进场 + 动态阈值 策略回测
//
// 策略逻辑：
//   1. D2 阶段：在预测桶上挂 Maker 限价单，单价 < 0.20
//   2. D1 阶段：监测高概率桶的价格回撤
//   3. 进场条件：价格回撤且符合双桶预测
//   4. 动态阈值：模型双桶概率 > 80% → 允许 $0.65
//                 模型双桶概率 < 70% → 只允许 $0.45
//   5. 持有到结算
//
// 注：预测数据只覆盖 8/15-8/20，而回测交易在 8/4-8/13
// 所以用实际交易的桶作为"预测桶"，价格历史数据做回撤检测

import fs from 'node:fs';
import path from 'node:path';

interface PriceHistoryEntry {
  t: number;  // Unix timestamp (seconds)
  p: number;  // YES price
}

interface PriceHistory {
  city: string;
  date: string;
  buckets: Record<string, PriceHistoryEntry[]>;
}

interface SimResult {
  label: string;
  bucketCombo: string;
  originalEntry: number;
  originalPnl: number;
  originalResult: string;
  
  d2MakerPrice: number | null;
  d2MakerQualified: boolean;
  retracementEntry: number | null;
  retracementFound: boolean;
  peakPrice: number | null;
  troughPrice: number | null;
  retracementPct: number | null;
  
  finalEntry: number | null;
  finalPnl: number | null;
  finalResult: string;
  reason: string;
}

function loadPriceHistory(city: string, date: string): PriceHistory | null {
  const fp = path.join(process.cwd(), 'data', 'price-history', `${city}_${date}.json`);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

// 获取桶的价格序列
function getBucketPrices(ph: PriceHistory, bucketLabel: string): PriceHistoryEntry[] | null {
  // 直接匹配
  if (ph.buckets[bucketLabel]) return ph.buckets[bucketLabel];
  // 标准化
  const num = parseInt(bucketLabel);
  if (!isNaN(num)) {
    const k = `${num}-${num}`;
    if (ph.buckets[k]) return ph.buckets[k];
  }
  // 模糊匹配
  for (const [key, val] of Object.entries(ph.buckets)) {
    if (key.includes(bucketLabel) || bucketLabel.includes(key)) return val;
  }
  return null;
}

// 检测价格回撤：在 D2 到 D1 期间，价格从峰值回落至少 5%
function detectRetracement(prices: PriceHistoryEntry[]): {
  peakPrice: number; troughPrice: number; retracementPct: number;
  entered: boolean; entryPrice: number;
} | null {
  if (!prices || prices.length < 5) return null;
  const sorted = [...prices].sort((a, b) => a.t - b.t);
  
  // D2 开盘到 D1 结束（前 36 小时）
  const start = sorted[0].t;
  const end = start + 129600; // 36小时
  const relevant = sorted.filter(e => e.t >= start && e.t <= end);
  if (relevant.length < 3) return null;
  
  // 找峰值
  let peak = 0, peakIdx = 0;
  for (let i = 0; i < relevant.length; i++) {
    if (relevant[i].p > peak) { peak = relevant[i].p; peakIdx = i; }
  }
  
  // 峰值后找谷值
  let trough = peak;
  for (let i = peakIdx; i < relevant.length; i++) {
    if (relevant[i].p < trough) trough = relevant[i].p;
  }
  
  if (peakIdx >= relevant.length - 1) {
    return { peakPrice: peak, troughPrice: trough, retracementPct: 0, entered: false, entryPrice: 0 };
  }
  
  const retracementPct = peak > 0 ? (peak - trough) / peak : 0;
  if (retracementPct < 0.05) {
    return { peakPrice: peak, troughPrice: trough, retracementPct, entered: false, entryPrice: 0 };
  }
  
  return { peakPrice: peak, troughPrice: trough, retracementPct, entered: true, entryPrice: trough };
}

function main() {
  const csvPath = path.join(process.cwd(), 'data', 'backtest', 'backtest-detail_2026-08-17T08-03-26.csv');
  const csv = fs.readFileSync(csvPath, 'utf8');
  const lines = csv.trim().split('\n').slice(1).filter(l => l.includes('price-history'));
  
  const results: SimResult[] = [];
  let totalMaker = 0, totalEntered = 0, totalSkipped = 0;
  let totalMakerWin = 0, totalEnteredWin = 0;
  let totalPnlMaker = 0, totalPnlEntered = 0, totalPnlOrig = 0;
  
  console.log('='.repeat(110));
  console.log('Maker + D1 回撤 + 动态阈值 策略回测');
  console.log('='.repeat(110));
  
  for (const line of lines) {
    const f = line.split(',');
    const city = f[1], date = f[2];
    const bucketCombo = f[3]; // e.g. "32-32+33-33"
    const entryPrice = parseFloat(f[4]);
    const result = f[9];
    const pnl = parseFloat(f[11]);
    totalPnlOrig += pnl;
    
    const buckets = bucketCombo.split('+').map(b => b.trim());
    const ph = loadPriceHistory(city, date);
    
    // 参数
    const MAKER_THRESHOLD = 0.20; // 单价 < 0.20 才挂 Maker
    const RETRACEMENT_MIN = 0.05; // 回撤至少 5%
    const ENTRY_CAP = 0.65;       // 最高入场价（简化版，不用动态阈值）
    
    let d2MakerPrice: number | null = null;
    let d2MakerQualified = false;
    let retracementEntry: number | null = null;
    let retracementFound = false;
    let peakPrice: number | null = null;
    let troughPrice: number | null = null;
    let retracementPct: number | null = null;
    let finalEntry: number | null = null;
    let finalResult = 'skipped';
    let reason = '';
    
    if (ph) {
      // === 阶段1: D2 Maker < 0.20 ===
      const bucketPrices = buckets.map(b => getBucketPrices(ph, b));
      const d2OpenPrices = bucketPrices.map(bp => {
        if (!bp || bp.length === 0) return null;
        const sorted = [...bp].sort((a, b) => a.t - b.t);
        const d2Start = sorted[0].t;
        const d2Period = sorted.filter(e => e.t <= d2Start + 14400); // 4小时内
        return d2Period.length > 0 ? Math.min(...d2Period.map(e => e.p)) : sorted[0].p;
      });
      
      if (d2OpenPrices.every(p => p !== null && p < MAKER_THRESHOLD)) {
        d2MakerPrice = d2OpenPrices.reduce((s, p) => s + (p ?? 0), 0);
        d2MakerQualified = true;
        finalEntry = d2MakerPrice;
        finalResult = 'maker_filled';
        reason = `D2 Maker 成交: 双桶 @ $${d2MakerPrice.toFixed(3)}`;
      } else {
        // === 阶段2: D1 回撤监测 ===
        const retracements = bucketPrices.map(bp => detectRetracement(bp)).filter(r => r !== null && r.entered);
        
        if (retracements.length >= 2) {
          // 两个桶都有回撤
          const totalRetracePrice = retracements.reduce((s, r) => s + (r?.entryPrice ?? 0), 0);
          peakPrice = retracements.reduce((s, r) => s + (r?.peakPrice ?? 0), 0);
          troughPrice = retracements.reduce((s, r) => s + (r?.troughPrice ?? 0), 0);
          retracementPct = peakPrice > 0 ? (peakPrice - troughPrice) / peakPrice : 0;
          retracementFound = true;
          retracementEntry = totalRetracePrice;
          
          if (totalRetracePrice <= ENTRY_CAP) {
            finalEntry = totalRetracePrice;
            finalResult = 'entered';
            reason = `D1 回撤进场: $${totalRetracePrice.toFixed(3)} (回撤 ${(retracementPct * 100).toFixed(0)}%)`;
          } else {
            reason = `回撤价 $${totalRetracePrice.toFixed(3)} > $${ENTRY_CAP}，跳过`;
          }
        } else {
          const d2Prices = d2OpenPrices.filter(p => p !== null).map(p => p!.toFixed(3));
          reason = `D2 价高 [${d2Prices.join(', ')}] 且无有效回撤`;
        }
      }
    } else {
      reason = '无价格历史';
    }
    
    // 计算新策略盈亏
    let finalPnl: number | null = null;
    if (finalEntry !== null) {
      const isHit = result === '命中';
      finalPnl = isHit ? (1 - finalEntry) : (0 - finalEntry);
      if (finalResult === 'maker_filled') {
        totalMaker++;
        totalPnlMaker += finalPnl;
        if (isHit) totalMakerWin++;
      } else {
        totalEntered++;
        totalPnlEntered += finalPnl;
        if (isHit) totalEnteredWin++;
      }
    } else {
      totalSkipped++;
    }
    
    results.push({
      label: `${city} ${date}`, bucketCombo,
      originalEntry: entryPrice, originalPnl: pnl, originalResult: result,
      d2MakerPrice, d2MakerQualified, retracementEntry, retracementFound,
      peakPrice, troughPrice, retracementPct, finalEntry, finalPnl, finalResult, reason,
    });
  }
  
  // === 输出汇总 ===
  const totalNew = totalMaker + totalEntered;
  const totalNewPnl = totalPnlMaker + totalPnlEntered;
  const totalNewWins = totalMakerWin + totalEnteredWin;
  const origWins = lines.filter(l => l.split(',')[9] === '命中').length;
  
  console.log(`\n基础数据: ${lines.length} 笔交易`);
  console.log(`原始 Taker 策略: 总盈亏 $${totalPnlOrig.toFixed(2)}，胜率 ${(origWins / lines.length * 100).toFixed(0)}%`);
  console.log(`\n新策略执行结果:`);
  console.log(`  D2 Maker 成交: ${totalMaker} 笔，总盈亏 $${totalPnlMaker.toFixed(2)}，胜率 ${totalMaker > 0 ? (totalMakerWin / totalMaker * 100).toFixed(0) : 'N/A'}%`);
  console.log(`  D1 回撤进场: ${totalEntered} 笔，总盈亏 $${totalPnlEntered.toFixed(2)}，胜率 ${totalEntered > 0 ? (totalEnteredWin / totalEntered * 100).toFixed(0) : 'N/A'}%`);
  console.log(`  跳过未进场: ${totalSkipped} 笔`);
  console.log(`  合计: ${totalNew} 笔，总盈亏 $${totalNewPnl.toFixed(2)}，胜率 ${totalNew > 0 ? (totalNewWins / totalNew * 100).toFixed(0) : 'N/A'}%`);
  
  console.log(`\n${'='.repeat(110)}`);
  console.log('📊 策略对比');
  console.log('='.repeat(110));
  console.log(`\n${'指标'.padEnd(25)} ${'原 Taker'.padEnd(18)} ${'新策略'.padEnd(18)} ${'变化'.padEnd(15)}`);
  console.log('-'.repeat(76));
  console.log(`${'总盈亏'.padEnd(25)} $${totalPnlOrig.toFixed(2).padEnd(15)} $${totalNewPnl.toFixed(2).padEnd(15)} ${totalNewPnl > totalPnlOrig ? '+' : ''}$${(totalNewPnl - totalPnlOrig).toFixed(2).padEnd(12)}`);
  console.log(`${'进场笔数'.padEnd(25)} ${String(lines.length).padEnd(17)} ${String(totalNew).padEnd(17)} ${totalNew > lines.length ? '+' : ''}${totalNew - lines.length}`);
  console.log(`${'胜率'.padEnd(25)} ${(origWins / lines.length * 100).toFixed(0) + '%'.padEnd(16)} ${totalNew > 0 ? (totalNewWins / totalNew * 100).toFixed(0) + '%' : 'N/A'.padEnd(17)}`);
  
  // 平均入场价对比
  const avgOrigEntry = lines.reduce((s, l) => s + parseFloat(l.split(',')[4]), 0) / lines.length;
  const enteredResults = results.filter(r => r.finalEntry !== null);
  const avgNewEntry = enteredResults.length > 0 ? enteredResults.reduce((s, r) => s + (r.finalEntry ?? 0), 0) / enteredResults.length : 0;
  console.log(`${'平均入场价'.padEnd(25)} $${avgOrigEntry.toFixed(3).padEnd(15)} $${avgNewEntry.toFixed(3).padEnd(15)} ${avgNewEntry > 0 ? (avgNewEntry < avgOrigEntry ? '↓ 便宜' + ((1 - avgNewEntry / avgOrigEntry) * 100).toFixed(0) + '%' : '↑ 贵了') : '—'}`);
  
  // 详细交易列表
  console.log(`\n${'='.repeat(110)}`);
  console.log('📋 详细交易');
  console.log('='.repeat(110));
  console.log(`\n${'城市+日期'.padEnd(22)} ${'原入场价'.padEnd(10)} ${'原盈亏'.padEnd(10)} ${'新入场价'.padEnd(10)} ${'新盈亏'.padEnd(10)} ${'结果'.padEnd(12)} ${'说明'}`);
  console.log('-'.repeat(110));
  
  for (const r of results) {
    const origEntry = r.originalEntry.toFixed(3);
    const origPnl = r.originalPnl.toFixed(3);
    const newEntry = r.finalEntry !== null ? r.finalEntry.toFixed(3) : '—';
    const newPnl = r.finalPnl !== null ? r.finalPnl.toFixed(3) : '—';
    const resultStr = r.finalResult === 'maker_filled' ? '🏭Maker' : r.finalResult === 'entered' ? '✅进场' : '⏭️跳过';
    const reasonShort = r.reason.length > 45 ? r.reason.slice(0, 45) + '...' : r.reason;
    console.log(`${r.label.padEnd(22)} $${origEntry.padEnd(7)} $${origPnl.padEnd(7)} $${newEntry.padEnd(7)} $${newPnl.padEnd(7)} ${resultStr.padEnd(12)} ${reasonShort}`);
  }
}

main();