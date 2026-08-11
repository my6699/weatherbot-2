// 复现企业微信报告"当前市值"计算，找出高收益来源。
// 服务器运行：npx tsx scripts/dump-report.ts
import fs from 'node:fs';
import { PolymarketClient } from '../src/utils/polymarket-client.js';

const CITY_CN = {
  shanghai: '上海', nyc: '纽约', chicago: '芝加哥', miami: '迈阿密', dallas: '达拉斯',
  seattle: '西雅图', atlanta: '亚特兰大', london: '伦敦', paris: '巴黎', munich: '慕尼黑',
  ankara: '安卡拉', seoul: '首尔', tokyo: '东京', singapore: '新加坡', lucknow: '勒克瑙',
  'tel-aviv': '特拉维夫', toronto: '多伦多', 'sao-paulo': '圣保罗', 'buenos-aires': '布宜诺斯艾利斯',
  wellington: '惠灵顿',
};

function parseOutcome(raw) {
  if (!raw) return 0;
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p)) return Number(p[0]) || 0;
  } catch {}
  return 0;
}

function marketBid(m) {
  return Number(m.bestBid) || parseOutcome(m.outcomePrices);
}

function matchBucketBid(markets, bucketLabel) {
  const low = bucketLabel.startsWith('<=');
  const high = bucketLabel.startsWith('>=');
  const num = Number(bucketLabel.replace(/[^\d.-]/g, ''));
  for (const m of markets) {
    const q = m.question ?? '';
    const mm = q.match(/(\d+)\s*°([CF])/);
    if (!mm) continue;
    const temp = Number(mm[1]);
    const isLow = /or below/i.test(q);
    const isHigh = /or higher/i.test(q);
    if (low && isLow) return marketBid(m);
    if (high && isHigh) return marketBid(m);
    if (!low && !high && !isLow && !isHigh && temp === num) return marketBid(m);
  }
  return null;
}

async function main() {
  const client = new PolymarketClient();
  const all = [];
  for (const f of fs.readdirSync('data').filter((x) => /^trades-.*\.json$/.test(x))) {
    const city = f.replace('trades-', '').replace('.json', '');
    for (const t of JSON.parse(fs.readFileSync(`data/${f}`, 'utf8'))) {
      if (t.status === 'open') all.push({ ...t, city });
    }
  }

  let costTotal = 0, valueOpen = 0, valueSw = 0;
  for (const t of all) {
    const event = await client.findEventBySlug(t.city, ...t.targetDate.split('-').map(Number));
    if (!event) continue;
    const markets = event.markets ?? [];
    const sumBidOpen = t.buckets.map((l) => matchBucketBid(markets, l)).filter((b) => b !== null && b > 0);
    const sumBidSw = (t.switchKeys ?? t.buckets).map((l) => matchBucketBid(markets, l)).filter((b) => b !== null && b > 0);
    const vOpen = sumBidOpen.length === t.buckets.length && t.entryPrice > 0 ? (t.sizeUsd * sumBidOpen.reduce((a, b) => a + b, 0)) / t.entryPrice : null;
    const basePrice = t.switched ? (t.switchBuy ?? t.entryPrice) : t.entryPrice;
    const vSw = sumBidSw.length === (t.switchKeys ?? t.buckets).length && basePrice > 0 ? (t.sizeUsd * sumBidSw.reduce((a, b) => a + b, 0)) / basePrice : null;
    costTotal += t.sizeUsd;
    if (vOpen !== null) valueOpen += vOpen;
    if (vSw !== null) valueSw += vSw;
    console.log(
      `[${CITY_CN[t.city] ?? t.city}] 桶${t.buckets.join('+')}${t.switched ? `→${t.switchKeys.join('+')}` : ''} | 成本${t.entryPrice.toFixed(2)}${t.switched ? `/新桶${t.switchBuy?.toFixed(2)}` : ''} | 开仓桶bid=${(sumBidOpen.reduce((a, b) => a + b, 0) || 0).toFixed(2)} 市值(开仓口径)=${vOpen === null ? '—' : '$' + vOpen.toFixed(2)} 市值(换仓口径)=${vSw === null ? '—' : '$' + vSw.toFixed(2)}`,
    );
  }
  console.log('---');
  console.log(`成本合计 $${costTotal.toFixed(2)} | 市值(开仓桶口径) $${valueOpen.toFixed(2)} (${((valueOpen - costTotal) / costTotal * 100).toFixed(1)}%) | 市值(换仓桶口径) $${valueSw.toFixed(2)} (${((valueSw - costTotal) / costTotal * 100).toFixed(1)}%)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
