// 混合策略：Maker 优先，不成交就 Taker 兜底
//
// 策略逻辑：
//   1. D2 开盘：选便宜的桶挂 Maker (阈值 $0.30，回撤 ≥ 3% 成交)
//   2. 如果 Maker 成交 → 用回撤价
//   3. 如果 Maker 没成交 → 用 D2 市价（Taker）进场
//   4. 另一个桶始终用 Taker 价
//   5. 不撤单，不跳过，69 笔全部进场

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
  if (!isNaN(n)) { const k = `${n}-${n}`; if (ph.buckets[k]) return ph.buckets[k]; }
  for (const [k, v] of Object.entries(ph.buckets)) {
    if (k.includes(label) || label.includes(k)) return v as any;
  }
  return null;
}

function analyzeBucket(prices: PH[], makerThreshold: number, retraceMin: number) {
  const sorted = [...prices].sort((a, b) => a.t - b.t);
  if (sorted.length < 3) {
    return { makerQualified: false, retraceFound: false, d2Price: 0, makerPrice: 0, retracePrice: 0, retracePct: 0 };
  }
  
  const start = sorted[0].t;
  const d2Period = sorted.filter(e => e.t <= start + 14400);
  const d2Price = d2Period.length > 0 ? Math.min(...d2Period.map(e => e.p)) : sorted[0].p;
  
  // D2 价格 < 阈值 → 可以挂 Maker
  const makerQualified = d2Price <= makerThreshold;
  
  if (!makerQualified) {
    return { makerQualified: false, retraceFound: false, d2Price, makerPrice: d2Price, retracePrice: d2Price, retracePct: 0 };
  }
  
  // 检查 D2-D1 回撤
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
  
  const retracePct = peak > 0 ? (peak - trough) / peak : 0;
  const retraceFound = retracePct >= retraceMin;
  
  return {
    makerQualified: true,
    retraceFound,
    d2Price,
    makerPrice: d2Price,        // Maker 挂单价 = D2 开盘价
    retracePrice: trough,       // 回撤价（如果 Maker 成交）
    retracePct,
  };
}

// 获取 Taker 桶的入场价（Maker 回撤时间点的价格）
function getTakerPrice(takerPrices: PH[], makerEntryTime: number): number {
  const sorted = [...takerPrices].sort((a, b) => a.t - b.t);
  // 找 makerEntryTime 前后最近的价格
  for (const tp of sorted) {
    if (tp.t >= makerEntryTime) return tp.p;
  }
  return sorted[sorted.length - 1].p;
}

// 找 Maker 桶的回撤入场时间
function findEntryTime(makerPrices: PH[], entryPrice: number): number {
  const sorted = [...makerPrices].sort((a, b) => a.t - b.t);
  for (const mp of sorted) {
    if (Math.abs(mp.p - entryPrice) < 0.001) return mp.t;
  }
  // 没精确匹配，找最接近的
  let best = sorted[0].t, bestDiff = Infinity;
  for (const mp of sorted) {
    const diff = Math.abs(mp.p - entryPrice);
    if (diff < bestDiff) { bestDiff = diff; best = mp.t; }
  }
  return best;
}

function main() {
  const csvPath = path.join(process.cwd(), 'data', 'backtest', 'backtest-detail_2026-08-17T08-03-26.csv');
  const csv = fs.readFileSync(csvPath, 'utf8');
  const lines = csv.trim().split('\n').slice(1).filter(l => l.includes('price-history'));
  
  const MAKER_THRESHOLD = 0.30;
  const RETRACE_MIN = 0.03;
  
  let totalPnlNew = 0, totalPnlOrig = 0;
  let totalWins = 0, totalMakerFilled = 0, totalMakerMissed = 0;
  let totalEntryPrice = 0, totalOrigEntry = 0;
  let totalMakerSaved = 0;
  let makerBetterCount = 0, makerWorseCount = 0;
  
  const details: string[] = [];
  
  console.log('='.repeat(120));
  console.log('混合策略：Maker 优先，不成交就 Taker 兜底');
  console.log(`参数: 便宜桶 Maker (阈值 $${MAKER_THRESHOLD}，回撤 ≥ ${(RETRACE_MIN*100).toFixed(0)}%)，不成交用 D2 市价`);
  console.log('='.repeat(120));
  
  for (const line of lines) {
    const f = line.split(',');
    const city = f[1], date = f[2];
    const bucketCombo = f[3];
    const origEntry = parseFloat(f[4]);
    const result = f[9];
    const origPnl = parseFloat(f[11]);
    totalPnlOrig += origPnl;
    totalOrigEntry += origEntry;
    
    const buckets = bucketCombo.split('+').map(b => b.trim());
    const ph = loadPH(city, date);
    
    let finalEntry = origEntry; // 默认用原入场价
    let makerStatus = 'taker_fallback';
    let makerSaved = 0;
    let detail = '';
    
    if (ph && buckets.length === 2) {
      const priceInfo = buckets.map(b => {
        const prices = getBP(ph, b);
        return prices ? { bucket: b, prices, analysis: analyzeBucket(prices, MAKER_THRESHOLD, RETRACE_MIN) } : null;
      });
      
      const valid = priceInfo.filter(p => p !== null);
      if (valid.length === 2) {
        // 排序：便宜的在前
        const sorted = valid.sort((a, b) => (a?.analysis.d2Price ?? 999) - (b?.analysis.d2Price ?? 999));
        const makerBucket = sorted[0];
        const takerBucket = sorted[1];
        
        const makerAnalysis = makerBucket.analysis;
        const takerAnalysis = takerBucket.analysis;
        
        let makerEntryPrice: number;
        let makerEntryTime: number;
        
        if (makerAnalysis.makerQualified && makerAnalysis.retraceFound) {
          // Maker 成交：用回撤价
          makerEntryPrice = makerAnalysis.retracePrice;
          makerEntryTime = findEntryTime(makerBucket.prices, makerAnalysis.retracePrice);
          makerStatus = 'maker_filled';
          totalMakerFilled++;
          makerSaved = makerAnalysis.d2Price - makerAnalysis.retracePrice;
          if (makerSaved > 0.001) makerBetterCount++;
          if (makerSaved < -0.001) makerWorseCount++;
        } else {
          // Maker 没成交：用 D2 市价
          makerEntryPrice = makerAnalysis.d2Price;
          makerEntryTime = makerBucket.prices.sort((a, b) => a.t - b.t)[0].t;
          makerStatus = 'maker_missed';
          totalMakerMissed++;
        }
        
        // Taker 桶：在 Maker 入场时间点买
        const takerPrices = takerBucket.prices.sort((a, b) => a.t - b.t);
        const takerPrice = getTakerPrice(takerPrices, makerEntryTime);
        
        finalEntry = makerEntryPrice + takerPrice;
        detail = `${makerBucket.bucket}(${makerEntryPrice.toFixed(3)}) ${makerStatus === 'maker_filled' ? '✅Maker' : '❌Taker'}，${takerBucket.bucket}(${takerPrice.toFixed(3)}) Taker，入场 $${finalEntry.toFixed(3)}`;
      } else {
        detail = `缺失数据，用原入场价`;
      }
    } else {
      detail = buckets.length !== 2 ? `非双桶，用原入场价` : `无价格历史，用原入场价`;
    }
    
    const isHit = result === '命中';
    const finalPnl = isHit ? (1 - finalEntry) : (0 - finalEntry);
    totalPnlNew += finalPnl;
    totalEntryPrice += finalEntry;
    if (isHit) totalWins++;
    totalMakerSaved += makerSaved;
    
    const resultStr = makerStatus === 'maker_filled' ? '🏭Maker' : '⬇️Taker';
    const diff = finalEntry - origEntry;
    const diffStr = Math.abs(diff) < 0.001 ? '=' : diff < 0 ? `↓$${(-diff).toFixed(3)}` : `↑$${diff.toFixed(3)}`;
    details.push(
      `${(city+' '+date).padEnd(22)} $${origEntry.toFixed(3).padEnd(7)} $${origPnl.toFixed(3).padEnd(7)} ` +
      `$${finalEntry.toFixed(3).padEnd(7)} $${finalPnl.toFixed(3).padEnd(7)} ${resultStr.padEnd(12)} ${diffStr.padEnd(10)} ${detail.slice(0, 50)}`
    );
  }
  
  const origWins = lines.filter(l => l.split(',')[9] === '命中').length;
  const avgOrig = totalOrigEntry / lines.length;
  const avgNew = totalEntryPrice / lines.length;
  
  console.log(`\n📊 对比汇总`);
  console.log('='.repeat(120));
  console.log(`\n${'指标'.padEnd(25)} ${'原 Taker'.padEnd(18)} ${'Maker优先+Taker兜底'.padEnd(18)} ${'变化'.padEnd(15)}`);
  console.log('-'.repeat(78));
  console.log(`${'总盈亏'.padEnd(25)} $${totalPnlOrig.toFixed(2).padEnd(15)} $${totalPnlNew.toFixed(2).padEnd(15)} ${totalPnlNew > totalPnlOrig ? '+' : ''}$${(totalPnlNew - totalPnlOrig).toFixed(2).padEnd(12)}`);
  console.log(`${'进场笔数'.padEnd(25)} ${String(lines.length).padEnd(17)} ${String(lines.length).padEnd(17)} ${'= 0'}`);
  console.log(`${'胜率'.padEnd(25)} ${(origWins / lines.length * 100).toFixed(0) + '%'.padEnd(16)} ${(totalWins / lines.length * 100).toFixed(0) + '%'.padEnd(17)}`);
  console.log(`${'平均入场价'.padEnd(25)} $${avgOrig.toFixed(3).padEnd(15)} $${avgNew.toFixed(3).padEnd(15)} ${avgNew < avgOrig ? '↓ 便宜' + ((1 - avgNew / avgOrig) * 100).toFixed(0) + '%' : '↑ 贵了'}`);
  console.log(`${'Maker 成交/未成交'.padEnd(25)} ${'—'.padEnd(17)} ${`${totalMakerFilled}/${totalMakerMissed}`.padEnd(17)}`);
  console.log(`${'Maker 节省总计'.padEnd(25)} ${'—'.padEnd(17)} $${totalMakerSaved.toFixed(3).padEnd(17)}`);
  console.log(`${'Maker 更优/更差'.padEnd(25)} ${'—'.padEnd(17)} ${(makerBetterCount + '/' + makerWorseCount).padEnd(17)}`);
  
  console.log(`\n${'='.repeat(120)}`);
  console.log('📋 详细交易');
  console.log('='.repeat(120));
  console.log(`\n${'城市+日期'.padEnd(22)} ${'原入场价'.padEnd(10)} ${'原盈亏'.padEnd(10)} ${'新入场价'.padEnd(10)} ${'新盈亏'.padEnd(10)} ${'结果'.padEnd(12)} ${'价差'.padEnd(10)} ${'说明'}`);
  console.log('-'.repeat(120));
  details.forEach(d => console.log(d));
}

main();