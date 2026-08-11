// 查看华氏城市市场 question 真实格式（一次性调试）
import { PolymarketClient } from '../src/utils/polymarket-client.js';

const client = new PolymarketClient();
for (const city of ['nyc', 'london', 'chicago']) {
  const event = await client.findEventBySlug(city, 2026, 8, 12);
  if (!event) { console.log(city, 'no event'); continue; }
  const ms = event.markets ?? [];
  console.log(`\n===== ${city} ${event.title} markets=${ms.length} =====`);
  for (const m of ms.slice(0, 6)) {
    console.log(`  Q: ${m.question}`);
    console.log(`     bestBid=${m.bestBid} bestAsk=${m.bestAsk} outcome=${String(m.outcomePrices).slice(0, 40)}`);
  }
}
