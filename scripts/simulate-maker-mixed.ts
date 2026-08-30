// 混合策略：一个桶 Maker，一个桶 Taker
//
// 策略逻辑：
//   1. D2 开盘：找出双桶中更便宜的那个桶 → 挂 Maker 限价单 (< 0.25)
//   2. D1 监测：
//      - 便宜桶：≥ 5% 回撤 → 接受 Maker 成交
//      - 便宜桶：无回撤 → 撤单放弃整个机会
//   3. 贵桶：不管什么情况，都市价买
//   4. 动态阈值：双桶总价 > 阈值 → 不进
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

// 分析单个桶是否满足回撤条件
function checkBucket(prices: PH[], makerThreshold: number, retraceMin: number): {
  qualified: boolean;      // D2 价格 < 阈值，可以挂
  accepted: boolean;      // 有回撤，成交
  canceled: boolean;      // 无回撤，撤单
  makerPrice: number;
  entryPrice: number;
  retracementPct: number;
} {
  const sorted = [...prices].sort((a, b) => a.t - b.t);
  if (sorted.length < 3) {
    return { qualified: false, accepted: false, canceled: false, makerPrice: 0, entryPrice: 0, retracementPct: 0 };
  }
  
  const start = sorted[0].t;
  const d2Period = sorted.filter(e => e.t <= start + 14400);
  const makerPrice = d2Period.length > 0 ? Math.min(...d2Period.map(e => e.p)) : sorted[0].p;
  
  if (makerPrice > makerThreshold) {
    return { qualified: false, accepted: false, canceled: false, makerPrice, entryPrice: 0, retracementPct: 0 };
  }
  
  const end = start + 129600;
  const relevant = sorted.filter(e => e.t >= start && e.t <= end);
  
  let peak = 0, peakIdx = 0;
  for (let i = 0; i < relevant.length; i++) {
    if (relevant[i].p > peak) { peak = relevant[i].p; peakIdx = i; }
  }
  
  let trough = peak;
  for (let i = peakIdx; i < relevant.length; i++) {
    if (relevant[i].p < trough) trough = relevant[i].p;
  }
  
  const retracementPct = peak > 0 ? (peak - trough) / peak : 0;
  
  if (retracementPct >= retraceMin) {
    return { qualified: true, accepted: true, canceled: false, makerPrice, entryPrice: trough, retracementPct };
  }
  
  return { qualified: true, accepted: false, canceled: true, makerPrice, entryPrice: 0, retracementPct };
}

function main() {
  const csvPath = path.join(process.cwd(), 'data', 'backtest', 'backtest-detail_2026-08-17T08-03-26.csv');
  const csv = fs.readFileSync(csvPath, 'utf8');
  const lines = csv.trim().split('\n').slice(1).filter(l => l.includes('price-history'));
  
  // 参数
  const MAKER_THRESHOLD = 0.30;  // 哪个桶低于这个值，哪个桶做 Maker
  const RETRACE_MIN = 0.03;    // 回撤 ≥ 3% 成交
  
  let totalEntered = 0, totalCanceled = 0, totalSkipped = 0;
  let totalWins = 0, totalPnl = 0, totalPnlOrig = 0;
  let totalEntryPrice = 0;
  
  const details: string[] = [];
  
  console.log('='.repeat(120));
  console.log('混合策略：一个桶 Maker + 一个桶 Taker');
  console.log(`参数: 选较便宜的桶做 Maker (阈值 $${MAKER_THRESHOLD}，回撤 ≥ ${(RETRACE_MIN*100).toFixed(0)}%成交)，另一个桶市价买`);
  console.log('='.repeat(120));
  
  for (const line of lines) {
    const f = line.split(',');
    const city = f[1], date = f[2];
    const bucketCombo = f[3];
    const origEntry = parseFloat(f[4]);
    const result = f[9];
    const origPnl = parseFloat(f[11]);
    totalPnlOrig += origPnl;
    
    const buckets = bucketCombo.split('+').map(b => b.trim());
    if (buckets.length !== 2) {
      totalSkipped++;
      details.push(`${(city+' '+date).padEnd(22)} $${origEntry.toFixed(3).padEnd(7)} $${origPnl.toFixed(3).padEnd(7)} —  —  ⏭️跳过  不是双桶`);
      continue;
    }
    
    const ph = loadPH(city, date);
    if (!ph) {
      totalSkipped++;
      details.push(`${(city+' '+date).padEnd(22)} $${origEntry.toFixed(3).padEnd(7)} $${origPnl.toFixed(3).padEnd(7)} —  —  ⏭️跳过  无价格历史`);
      continue;
    }
    
    // 获取两个桶的价格序列
    const priceInfo = buckets.map(b => {
      const prices = getBP(ph, b);
      if (!prices) return null;
      return { bucket: b, prices, analysis: checkBucket(prices, MAKER_THRESHOLD, RETRACE_MIN) };
    });
    
    const valid = priceInfo.filter(p => p !== null);
    if (valid.length !== 2) {
      totalSkipped++;
      details.push(`${(city+' '+date).padEnd(22)} $${origEntry.toFixed(3).padEnd(7)} $${origPnl.toFixed(3).padEnd(7)} —  —  ⏭️跳过  缺失数据`);
      continue;
    }
    
    // 排序：便宜的桶在前
    const sorted = valid.sort((a, b) => (a?.analysis.makerPrice ?? 999) - (b?.analysis.makerPrice ?? 999));
    const makerBucket = sorted[0]; // 便宜的 → Maker
    const takerBucket = sorted[1]; // 贵的 → Taker
    const makerPrice = makerBucket.analysis.makerPrice;
    
    if (!makerBucket.analysis.qualified) {
      // 便宜桶本身就超过阈值 → 全撤
      totalCanceled++;
      details.push(`${(city+' '+date).padEnd(22)} $${origEntry.toFixed(3).padEnd(7)} $${origPnl.toFixed(3).padEnd(7)} —  —  ❌撤单  maker桶(${makerBucket.bucket}) 价$${makerPrice.toFixed(3)} > $${MAKER_THRESHOLD}`);
      continue;
    }
    
    if (!makerBucket.analysis.accepted) {
      // 便宜桶合格但没回撤 → 全撤
      totalCanceled++;
      const r = makerBucket.analysis.retracementPct * 100;
      details.push(`${(city+' '+date).padEnd(22)} $${origEntry.toFixed(3).padEnd(7)} $${origPnl.toFixed(3).padEnd(7)} —  —  ❌撤单  maker桶(${makerBucket.bucket}) 回撤 ${r.toFixed(0)}% < ${(RETRACE_MIN*100).toFixed(0)}%`);
      continue;
    }
    
    // === 现在：一个 Maker 成交，一个 Taker 市价买 ===
    // Taker 在 Maker 回撤同一时间点市价买
    // 找到 Maker 回撤入场点的时间戳，用那个时间的 Taker 价格
    // Maker 回撤入场价 = makerBucket.analysis.entryPrice
    // 在 makerBucket 的价格历史中找到 entryPrice 对应的时间
    const makerPrices = makerBucket.prices.sort((a, b) => a.t - b.t);
    let makerEntryTime = makerPrices[makerPrices.length - 1].t; // 默认用最后时间
    for (const mp of makerPrices) {
      if (Math.abs(mp.p - makerBucket.analysis.entryPrice) < 0.001) {
        makerEntryTime = mp.t;
        break;
      }
    }
    // 找到 Taker 桶在 makerEntryTime 前后最近的价格
    const takerPrices = takerBucket.prices.sort((a, b) => a.t - b.t);
    let takerPrice = takerPrices[takerPrices.length - 1].p;
    for (const tp of takerPrices) {
      if (tp.t >= makerEntryTime) {
        takerPrice = tp.p;
        break;
      }
    }
    // 如果 Taker 价格 > 0.65 或 <= 0.001，可能有问题，用中间值
    if (takerPrice > 0.65) {
      // 找 makerEntryTime 之前 24h 内的价格
      const prev = takerPrices.filter(e => e.t <= makerEntryTime && e.t >= makerEntryTime - 86400);
      if (prev.length > 0) {
        // 取中位数
        const sorted = prev.map(e => e.p).sort((a, b) => a - b);
        takerPrice = sorted[Math.floor(sorted.length / 2)];
      }
    }
    const totalEntry = makerBucket.analysis.entryPrice + takerPrice;
    const isHit = result === '命中';
    const finalPnl = isHit ? (1 - totalEntry) : (0 - totalEntry);
    
    totalEntered++;
    totalPnl += finalPnl;
    totalEntryPrice += totalEntry;
    if (isHit) totalWins++;
    
    const r1 = makerBucket.analysis.retracementPct * 100;
    const resultStr = '✅进场';
    const reason = `${makerBucket.bucket}(${makerPrice.toFixed(3)}) Maker，${takerBucket.bucket}(${takerPrice.toFixed(3)}) Taker，入场 $${totalEntry.toFixed(3)}`;
    details.push(`${(city+' '+date).padEnd(22)} $${origEntry.toFixed(3).padEnd(7)} $${origPnl.toFixed(3).padEnd(7)} $${totalEntry.toFixed(3).padEnd(7)} $${finalPnl.toFixed(3).padEnd(7)} ${resultStr.padEnd(12)} ${reason.slice(0, 50)}`);
  }
  
  // 汇总输出
  const origWins = lines.filter(l => l.split(',')[9] === '命中').length;
  const avgOrig = lines.reduce((s, l) => s + parseFloat(l.split(',')[4]), 0) / lines.length;
  const avgNew = totalEntered > 0 ? totalEntryPrice / totalEntered : 0;
  
  console.log(`\n基础数据: ${lines.length} 笔交易`);
  console.log(`原始 Taker: 总盈亏 $${totalPnlOrig.toFixed(2)}，胜率 ${(origWins / lines.length * 100).toFixed(0)}%`);
  console.log(`\n混合策略结果:`);
  console.log(`  进场: ${totalEntered} 笔，总盈亏 $${totalPnl.toFixed(2)}，胜率 ${totalEntered > 0 ? (totalWins / totalEntered * 100).toFixed(0) : 'N/A'}%`);
  console.log(`  撤单: ${totalCanceled} 笔`);
  console.log(`  跳过: ${totalSkipped} 笔`);
  
  console.log(`\n${'='.repeat(120)}`);
  console.log('📊 对比汇总');
  console.log('='.repeat(120));
  console.log(`\n${'指标'.padEnd(25)} ${'原 Taker'.padEnd(18)} ${'混合(M+T)'.padEnd(18)} ${'变化'.padEnd(15)}`);
  console.log('-'.repeat(78));
  console.log(`${'总盈亏'.padEnd(25)} $${totalPnlOrig.toFixed(2).padEnd(15)} $${totalPnl.toFixed(2).padEnd(15)} ${totalPnl > totalPnlOrig ? '+' : ''}$${(totalPnl - totalPnlOrig).toFixed(2).padEnd(12)}`);
  console.log(`${'进场笔数'.padEnd(25)} ${String(lines.length).padEnd(17)} ${String(totalEntered).padEnd(17)} ${totalEntered > lines.length ? '+' : ''}${totalEntered - lines.length}`);
  console.log(`${'胜率'.padEnd(25)} ${(origWins / lines.length * 100).toFixed(0) + '%'.padEnd(16)} ${totalEntered > 0 ? (totalWins / totalEntered * 100).toFixed(0) + '%' : 'N/A'.padEnd(17)}`);
  if (avgNew > 0) {
    console.log(`${'平均入场价'.padEnd(25)} $${avgOrig.toFixed(3).padEnd(15)} $${avgNew.toFixed(3).padEnd(15)} ${avgNew < avgOrig ? '↓ 便宜' + ((1 - avgNew / avgOrig) * 100).toFixed(0) + '%' : '↑ 贵了'}`);
  }
  
  console.log(`\n${'='.repeat(120)}`);
  console.log('📋 详细交易');
  console.log('='.repeat(120));
  console.log(`\n${'城市+日期'.padEnd(22)} ${'原入场价'.padEnd(10)} ${'原盈亏'.padEnd(10)} ${'新入场价'.padEnd(10)} ${'新盈亏'.padEnd(10)} ${'结果'.padEnd(12)} ${'说明'}`);
  console.log('-'.repeat(120));
  details.forEach(d => console.log(d));
}

main();