// 临时验证脚本：实测 ensemble API 拉取 + KDE 桶概率（验证后删除）。
import 'dotenv/config';
import { DataIngestionLayer } from '../dist/data/DataIngestionLayer.js';
import { AdaptiveProbabilityEngine } from '../dist/data/AdaptiveProbabilityEngine.js';
import { loadCityConfig } from '../dist/common/config-loader.js';

const city = loadCityConfig('shanghai');
const { lat, lon, stationId } = city.settlementStation;

const ingestion = new DataIngestionLayer();
const ens = await ingestion.fetchEnsembleDailyMaxes(lat, lon, 5, stationId, 'ecmwf_ifs025');
if (!ens) {
  console.error('ensemble 拉取失败');
  process.exit(1);
}

console.log(
  `模型=${ens.model} 成员数=${ens.memberCount} 天数=${ens.mean.length}`,
);
console.log(`ensemble mean(℃): ${ens.mean.map((m) => m.toFixed(1)).join(', ')}`);

const day = 1;
const dayTemps = ens.dayTemps.map((m) => m[day]).filter(Number.isFinite);
console.log(`\n第 ${day} 天成员最高温分布（${dayTemps.length} 个成员）:`);
console.log(
  `  min=${Math.min(...dayTemps).toFixed(1)} max=${Math.max(...dayTemps).toFixed(1)}`,
);
const sorted = [...dayTemps].sort((a, b) => a - b);
const start = Math.floor(Math.min(...sorted));
const end = Math.ceil(Math.max(...sorted));
for (let t = start; t <= end; t++) {
  const cnt = sorted.filter((v) => v >= t && v < t + 1).length;
  console.log(`  ${t}~${t + 1}°C: ${'#'.repeat(cnt)} (${cnt})`);
}

// 用 generateDistribution 传空 corrections + ensemble（weight=1 → 纯 KDE）。
const engine = new AdaptiveProbabilityEngine('shanghai', stationId, city.buckets);
const dist = engine.generateDistribution([], new Map(), 'd1', undefined, {
  model: 'ecmwf_ifs025',
  memberCount: dayTemps.length,
  memberTemps: dayTemps,
  weight: 1,
});
console.log('\n纯集合(KDE)桶概率:');
for (const b of dist.buckets.sort((x, y) => y.probability - x.probability)) {
  console.log(`  ${b.bucket.label.padEnd(5)} ${(b.probability * 100).toFixed(1)}%`);
}
console.log(
  `\nensemble 元数据: meanTempC=${dist.ensemble?.meanTempC} dispersionC=${dist.ensemble?.dispersionC}`,
);