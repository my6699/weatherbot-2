// 重建 bias.json：用 predictions.json 的 rawAnchorC（原始 ECMWF 预报）
// 与 metar_max.json（实际温度）对比，计算真实偏差。
//
// 原则：
//   1. 只用 ECMWF 集合预报数据（weatherbot-2 的实际数据源）
//   2. 样本不足（<3）的 key，bias 设为 0（不修正）
//   3. 样本 >=3 的 key，用 James-Stein 收缩（K=5，与生产同口径）
//   4. 幅度钳位 ±2°C
//
// 运行：npx tsx scripts/rebuild-bias.ts

import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const predFile = path.join(projectRoot, 'data', 'predictions.json');
const oldDataDir =
  process.env.OLD_PROJECT_DATA_DIR ??
  '/home/ec2-user/weatherbot-collector/data';
const metarFile = path.join(oldDataDir, 'metar_max.json');
const biasFile = path.join(oldDataDir, 'bias.json');

// 与 DebCalibration 同口径的参数
const STRATUM_SHRINK_K = 5;
const BIAS_MIN_N = 3; // 提高最低样本数（原值 2 → 3）
const BIAS_SHRINK_N = 4;
const BIAS_MAX_C = 2.0;

function tempStratumC(fc: number): string {
  if (fc <= 32) return '<=32';
  if (fc <= 36) return '33-36';
  return '>=37';
}

const HORIZON_TO_OLD: Record<string, string> = {
  d3: 'D+3',
  d2: 'D+2',
  d1: 'D+1',
  d0: 'D+0',
};

function shrunkBias(avgBias: number, n: number): number {
  const shrink = Math.min(1, n / BIAS_SHRINK_N);
  const capped = Math.max(-BIAS_MAX_C, Math.min(BIAS_MAX_C, avgBias));
  return Math.round(capped * shrink * 1000) / 1000;
}

function main(): void {
  const predictions = JSON.parse(fs.readFileSync(predFile, 'utf8')) as Record<
    string,
    { city: string; stationId: string; date: string; horizons: Record<string, any> }
  >;
  const metarMax = JSON.parse(fs.readFileSync(metarFile, 'utf8')) as Record<
    string,
    Record<string, number>
  >;

  const today = new Date().toISOString().slice(0, 10);

  // 收集所有 (city, horizon, source, stratum) →偏差样本
  const samples: Record<string, number[]> = {};
  // 三维（city|horizon|source）→偏差样本
  const samples3d: Record<string, number[]> = {};

  for (const r of Object.values(predictions)) {
    const actualC = metarMax[r.stationId]?.[r.date];
    if (actualC === undefined || r.date >= today) continue;

    for (const [horizon, hz] of Object.entries(r.horizons || {})) {
      if (hz.rawAnchorC === undefined) continue;

      const oldH = HORIZON_TO_OLD[horizon] ?? 'D+2';
      const source = 'ecmwf';
      const key3d = `${r.city}|${oldH}|${source}`;
      const stratum = tempStratumC(hz.rawAnchorC);
      const key4d = `${key3d}|${stratum}`;

      const bias = actualC - hz.rawAnchorC;
      (samples3d[key3d] ??= []).push(bias);
      (samples[key4d] ??= []).push(bias);
    }
  }

  // 构建新 bias.json
  const newBias: Record<string, { bias: number; n: number; updated_at: string }> = {};
  const now = new Date().toISOString();

  // 三维城市基准
  for (const [key3d, arr] of Object.entries(samples3d)) {
    const n = arr.length;
    const avg = arr.reduce((a, b) => a + b, 0) / n;
    newBias[key3d] = {
      bias: n >= BIAS_MIN_N ? shrunkBias(avg, n) : 0,
      n,
      updated_at: now,
    };
  }

  // 四维温度档（James-Stein 收缩到三维基准）
  for (const [key4d, arr] of Object.entries(samples)) {
    const n = arr.length;
    const avg = arr.reduce((a, b) => a + b, 0) / n;
    const key3d = key4d.split('|').slice(0, 3).join('|');
    const b3 = newBias[key3d]?.bias ?? 0;

    if (n >= BIAS_MIN_N) {
      const s = shrunkBias(avg, n);
      const eff =
        (n / (n + STRATUM_SHRINK_K)) * s +
        (1 - n / (n + STRATUM_SHRINK_K)) * b3;
      newBias[key4d] = {
        bias: Math.round(eff * 1000) / 1000,
        n,
        updated_at: now,
      };
    } else {
      newBias[key4d] = { bias: 0, n, updated_at: now };
    }
  }

  // 备份旧 bias.json
  const backupPath = biasFile + '.bak.' + Date.now();
  if (fs.existsSync(biasFile)) {
    fs.copyFileSync(biasFile, backupPath);
    console.log('旧 bias.json 已备份:', backupPath);
  }

  // 写入新 bias.json
  fs.writeFileSync(biasFile, JSON.stringify(newBias, null, 2), 'utf8');
  console.log('新 bias.json 已写入:', biasFile);
  console.log('总 key 数:', Object.keys(newBias).length);

  // 统计
  let zeroCount = 0;
  let nonZeroCount = 0;
  for (const v of Object.values(newBias)) {
    if (v.bias === 0) zeroCount++;
    else nonZeroCount++;
  }
  console.log(`bias=0（不修正）: ${zeroCount} 个`);
  console.log(`bias≠0（生效）: ${nonZeroCount} 个`);

  // 展示非零项
  console.log('\n=== 生效的偏差修正项 ===');
  for (const [k, v] of Object.entries(newBias)) {
    if (v.bias !== 0) {
      console.log(`  ${k.padEnd(35)} bias=${v.bias >= 0 ? '+' : ''}${v.bias.toFixed(3)}°C (n=${v.n})`);
    }
  }
}

main();
