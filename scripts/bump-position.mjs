// 一次性脚本：把全部城市 config 的单笔投入从 20U 调到 25U（总资金 1000U 口径），
// 每城上限 80 → 100U。
// 用法：node scripts/bump-position.mjs
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), 'config');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'city_peak_times.json');
let changed = 0;
for (const f of files) {
  const p = path.join(dir, f);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!j.risk) continue;
  const before = `${j.risk.maxPositionUsd}/${j.risk.maxCityExposureUsd}`;
  j.risk.maxPositionUsd = 25;
  j.risk.maxCityExposureUsd = 100;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf8');
  console.log(`${f}: ${before} -> ${j.risk.maxPositionUsd}/${j.risk.maxCityExposureUsd}`);
  changed++;
}
console.log(`共修改 ${changed} 个城市配置`);
