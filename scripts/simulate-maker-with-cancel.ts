// Maker + D2 挂单 + D1 撤单 + 回撤重进场 回测
//
// 策略：
//   1. D2 开盘：预测桶单价 < 0.25 → 挂 Maker 限价单
//   2. D1 起监测：如果价格反复（先涨后跌 ≥ 5%），Maker 单成交，入场
//   3. 如果价格一直涨不回撤 → 撤单，放弃
//   4. 动态阈值：模型概率 > 80% → $0.65，< 70% → $0.45
//   5. 持有到结算

import fs from 'node:fs';
import path from 'node:path';

interface PH { t: number; p: number }

function loadPH(city: string, date: string): any {
  const fp = path.join(process.cwd(), 'data', 'price-history', `${city}_${date}.json`);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function getBP(ph: any, label: string): PH[] | null {
  if (ph.buckets[label]) return ph.buckets[label];
  const n = parseInt(label);
  if (!isNaN(n)) {
    const k = `${n}-${n}`;
    if (ph.buckets[k]) return ph.buckets[k];
  }
  for (const [k, v] of Object.entries(ph.buckets)) {
    if (k.includes(label) || label.includes(k)) return v as any;
  }
  return null;
}

// 分析单桶价格走势，判断 Maker 挂单+撤单结果
function analyzeBucket(
  prices: PH[],
  makerThreshold: number, // 单个桶 Maker 挂单价上限
  retraceMin: number,     // 回撤最小比例
): {
  makerQualified: boolean;  // D2 价格 < 阈值，可以挂单
  accepted: boolean;        // 出现了回撤，Maker 成交
  canceled: boolean;        // 没回撤，撤单
  makerPrice: number;       // D2 挂单价
  entryPrice: number;       // 实际入场价（回撤价格）
  peakPrice: number;
  troughPrice: number;
  retracementPct: number;
} {
  const sorted = [...prices].sort((a, b) => a.t - b.t);
  if (sorted.length < 3) {
    return { makerQualified: false, accepted: false, canceled: false, makerPrice: 0, entryPrice: 0, peakPrice: 0, troughPrice: 0, retracementPct: 0 };
  }
  
  const start = sorted[0].t;
  // D2 开盘 4 小时内的最低价 → 挂单价
  const d2Period = sorted.filter(e => e.t <= start + 14400);
  const makerPrice = d2Period.length > 0 ? Math.min(...d2Period.map(e => e.p)) : sorted[0].p;
  
  // D2 价格已经超过阈值 → 不挂单
  if (makerPrice > makerThreshold) {
    return { makerQualified: false, accepted: false, canceled: false, makerPrice, entryPrice: 0, peakPrice: 0, troughPrice: 0, retracementPct: 0 };
  }
  
  // 在 D2-D1 之间找峰值和谷值
  const end = start + 129600; // 36h
  const relevant = sorted.filter(e => e.t >= start && e.t <= end);
  
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
  
  const retracementPct = peak > 0 ? (peak - trough) / peak : 0;
  
  // 如果从峰值有 >= retraceMin 的回撤 → Maker 单成交，按回撤价格入场
  if (retracementPct >= retraceMin) {
    return {
      makerQualified: true, accepted: true, canceled: false,
      makerPrice, entryPrice: trough,
      peakPrice: peak, troughPrice: trough, retracementPct,
    };
  }
  
  // 没回撤 → Maker 单没成交，撤单
  return {
    makerQualified: true, accepted: false, canceled: true,
    makerPrice, entryPrice: 0,
    peakPrice: peak, troughPrice: trough, retracementPct,
  };
}

function main() {
  const csvPath = path.join(process.cwd(), 'data', 'backtest', 'backtest-detail_2026-08-17T08-03-26.csv');
  const csv = fs.readFileSync(csvPath, 'utf8');
  const lines = csv.trim().split('\n').slice(1).filter(l => l.includes('price-history'));
  
  const MAKER_THRESHOLD = 0.25; // 单价 < 0.25 挂 Maker
  const RETRACE_MIN = 0.05;     // 回撤 5% 接受
  
  let totalEntered = 0, totalCanceled = 0, totalSkipped = 0;
  let totalWins = 0, totalPnl = 0, totalPnlOrig = 0;
  let totalEntryPrice = 0;
  
  const details: string[] = [];
  
  console.log('='.repeat(110));
  console.log('Maker + D1 撤单机制 策略回测');
  console.log(`参数: 单桶 D2 < $${MAKER_THRESHOLD} 挂单，回撤 ≥ ${(RETRACE_MIN*100).toFixed(0)}% 接受，否则撤单`);
  console.log('='.repeat(110));
  
  for (const line of lines) {
    const f = line.split(',');
    const city = f[1], date = f[2];
    const bucketCombo = f[3];
    const origEntry = parseFloat(f[4]);
    const result = f[9];
    const origPnl = parseFloat(f[11]);
    totalPnlOrig += origPnl;
    
    const buckets = bucketCombo.split('+').map(b => b.trim());
    const ph = loadPH(city, date);
    
    let finalEntry: number | null = null;
    let finalPnl: number | null = null;
    let finalResult = 'skipped';
    let reason = '';
    let detailEntry = '—', detailPnl = '—';
    
    if (!ph) {
      reason = '无价格历史';
      totalSkipped++;
    } else {
      const analysis = buckets.map(b => {
        const prices = getBP(ph, b);
        return prices ? analyzeBucket(prices, MAKER_THRESHOLD, RETRACE_MIN) : null;
      });
      
      const valid = analysis.filter(a => a !== null);
      if (valid.length < 2) {
        reason = '缺失价格数据';
        totalSkipped++;
      } else {
        const accepted = valid.filter(a => a.accepted);
        const canceled = valid.filter(a => a.canceled);
        
        if (accepted.length === 2) {
          // 双桶都回撤 → 进场
          const entry = accepted.reduce((s, a) => s + a.entryPrice, 0);
          const makerP = accepted.reduce((s, a) => s + a.makerPrice, 0);
          const avgR = accepted.reduce((s, a) => s + a.retracementPct, 0) / 2;
          finalEntry = entry;
          const isHit = result === '命中';
          finalPnl = isHit ? (1 - entry) : (0 - entry);
          finalResult = 'entered';
          totalEntered++;
          totalPnl += finalPnl;
          totalEntryPrice += entry;
          if (isHit) totalWins++;
          const r1 = (valid[0]?.retracementPct ?? 0) * 100;
          const r2 = (valid[1]?.retracementPct ?? 0) * 100;
          reason = `双桶回撤 ${r1.toFixed(0)}%/${r2.toFixed(0)}%，入场 $${entry.toFixed(3)}`;
          detailEntry = entry.toFixed(3);
          detailPnl = finalPnl.toFixed(3);
        } else if (canceled.length === 2) {
          finalResult = 'canceled';
          totalCanceled++;
          const r1 = (valid[0]?.retracementPct ?? 0) * 100;
          const r2 = (valid[1]?.retracementPct ?? 0) * 100;
          reason = `双桶都无回撤 (${r1.toFixed(0)}%/${r2.toFixed(0)}%) → 撤单`;
        } else {
          finalResult = 'canceled';
          totalCanceled++;
          const acc = accepted.length, can = canceled.length;
          reason = `${acc}桶回撤 ${can}桶无回撤 → 整体撤单`;
        }
      }
    }
    
    details.push(
      `${(city+' '+date).padEnd(22)} $${origEntry.toFixed(3).padEnd(7)} $${origPnl.toFixed(3).padEnd(7)} ` +
      `$${detailEntry.padEnd(7)} $${detailPnl.padEnd(7)} ${finalResult === 'entered' ? '✅进场'.padEnd(12) : finalResult === 'canceled' ? '❌撤单'.padEnd(12) : '⏭️跳过'.padEnd(12)} ${reason.slice(0, 50)}`
    );
  }
  
  // 输出
  const origWins = lines.filter(l => l.split(',')[9] === '命中').length;
  const avgOrig = totalPnlOrig > 0 ? lines.reduce((s, l) => s + parseFloat(l.split(',')[4]), 0) / lines.length : 0;
  const avgNew = totalEntered > 0 ? totalEntryPrice / totalEntered : 0;
  
  console.log(`\n基础数据: ${lines.length} 笔交易`);
  console.log(`原始 Taker: 总盈亏 $${totalPnlOrig.toFixed(2)}，胜率 ${(origWins / lines.length * 100).toFixed(0)}%`);
  console.log(`\n新策略结果:`);
  console.log(`  进场: ${totalEntered} 笔，总盈亏 $${totalPnl.toFixed(2)}，胜率 ${totalEntered > 0 ? (totalWins / totalEntered * 100).toFixed(0) : 'N/A'}%`);
  console.log(`  撤单放弃: ${totalCanceled} 笔`);
  console.log(`  跳过: ${totalSkipped} 笔`);
  
  console.log(`\n${'='.repeat(110)}`);
  console.log('📊 对比汇总');
  console.log('='.repeat(110));
  console.log(`\n${'指标'.padEnd(25)} ${'原 Taker'.padEnd(18)} ${'Maker+撤单'.padEnd(18)} ${'变化'.padEnd(15)}`);
  console.log('-'.repeat(78));
  console.log(`${'总盈亏'.padEnd(25)} $${totalPnlOrig.toFixed(2).padEnd(15)} $${totalPnl.toFixed(2).padEnd(15)} ${totalPnl > totalPnlOrig ? '+' : ''}$${(totalPnl - totalPnlOrig).toFixed(2).padEnd(12)}`);
  console.log(`${'进场笔数'.padEnd(25)} ${String(lines.length).padEnd(17)} ${String(totalEntered).padEnd(17)} ${totalEntered > lines.length ? '+' : ''}${totalEntered - lines.length}`);
  console.log(`${'胜率'.padEnd(25)} ${(origWins / lines.length * 100).toFixed(0) + '%'.padEnd(16)} ${totalEntered > 0 ? (totalWins / totalEntered * 100).toFixed(0) + '%' : 'N/A'.padEnd(17)}`);
  if (avgNew > 0) {
    console.log(`${'平均入场价'.padEnd(25)} $${avgOrig.toFixed(3).padEnd(15)} $${avgNew.toFixed(3).padEnd(15)} ${avgNew < avgOrig ? '↓ 便宜' + ((1 - avgNew / avgOrig) * 100).toFixed(0) + '%' : '↑ 贵了'}`);
  }
  
  console.log(`\n${'='.repeat(110)}`);
  console.log('📋 详细交易');
  console.log('='.repeat(110));
  console.log(`\n${'城市+日期'.padEnd(22)} ${'原入场价'.padEnd(10)} ${'原盈亏'.padEnd(10)} ${'新入场价'.padEnd(10)} ${'新盈亏'.padEnd(10)} ${'结果'.padEnd(12)} ${'说明'}`);
  console.log('-'.repeat(110));
  details.forEach(d => console.log(d));
}

main();