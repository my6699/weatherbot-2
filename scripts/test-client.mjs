// 快速测试 PolymarketClient 网络连通性
import { PolymarketClient } from '../src/utils/polymarket-client.js';

const c = new PolymarketClient();
const r1 = await c.findEventBySlug('shanghai', 2026, 8, 11);
console.log('shanghai 08-11:', r1 ? r1.id : 'null');
const r2 = await c.findEventBySlug('london', 2026, 8, 11);
console.log('london 08-11:', r2 ? r2.id : 'null');
const r3 = await c.findEventBySlug('seoul', 2026, 8, 11);
console.log('seoul 08-11:', r3 ? r3.id : 'null');
