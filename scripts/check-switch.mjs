// 一次性检查脚本：查看服务器各城市 open 持仓的换仓持久化状态。
// 用法：node scripts/check-switch.mjs
import fs from 'node:fs';

const cities = ['seoul', 'tokyo', 'wellington', 'lucknow', 'munich', 'singapore', 'tel-aviv'];
for (const c of cities) {
  const p = `data/trades-${c}.json`;
  if (!fs.existsSync(p)) continue;
  const a = JSON.parse(fs.readFileSync(p, 'utf8'));
  const o = a.filter((t) => t.status === 'open');
  console.log(
    c,
    JSON.stringify(
      o.map((t) => ({
        id: t.id.slice(-8),
        buckets: t.buckets,
        switched: t.switched ?? false,
        switchKeys: t.switchKeys ?? null,
        switchAt: t.switchAt ?? null,
        entryPrice: t.entryPrice,
        switchBuy: t.switchBuy ?? null,
      })),
    ),
  );
}
