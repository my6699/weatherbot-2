// 临时脚本：导出服务器 Redis 里所有 weather:* 数据为单个 JSON 文件。
// 用法：node scripts/export-redis-weather.mjs
import { Redis } from 'ioredis';
import fs from 'node:fs';

const r = new Redis('redis://127.0.0.1:6379', { maxRetriesPerRequest: 3 });
try {
  const keys = await r.keys('weather:*');
  const out = {};
  for (const k of keys) {
    const v = await r.get(k);
    if (v !== null) out[k] = v;
  }
  fs.writeFileSync('/tmp/weather-redis-export.json', JSON.stringify(out, null, 0));
  console.log(`exported ${keys.length} keys -> /tmp/weather-redis-export.json`);
} finally {
  await r.quit();
}
