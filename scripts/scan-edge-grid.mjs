// 最优单桶 edge 阈值网格扫描脚本。
// 目标：找"EV 不掉的前提下入场率最高"的阈值（生产当前 0.16）。
// 做法：循环跑 simulate-all-cities.ts（FILTER_BEST_SINGLE=1 + MIN_PAIR_EDGE=x），
//   解析每次导出的 detail/summary CSV，汇总成对比表。
// 用法：node scripts/scan-edge-grid.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'data', 'backtest');

const THRESHOLDS = [0, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17, 0.18, 0.20];
const COSTS = [99];
const WINDOWS = [
  { label: '全量', days: 0 },
  { label: '近7天', days: 7 },
];
// 扫描维度：SCAN_DIM=cost 时固定 edge=0.16、循环成本上限；否则循环 edge 阈值。
const SCAN_COST = process.env.SCAN_DIM === 'cost';

function latestCsv(prefix) {
  const files = fs
    .readdirSync(OUT)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.csv'))
    .sort();
  return files.length ? path.join(OUT, files[files.length - 1]) : null;
}

function parseDetail(file) {
  if (!file) return null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(1);
  const rows = lines.map((l) => l.split(','));
  const markets = rows.length;
  const entered = rows.filter((r) => r[4] && r[4].trim() !== '').length;
  const settled = rows.map((r) => parseFloat(r[11])).filter((p) => !isNaN(p));
  const profitable = settled.filter((p) => p > 0).length;
  const total = settled.reduce((s, p) => s + p, 0);
  const mean = settled.length ? total / settled.length : null;
  const entryUsd = rows
    .filter((r) => r[4] && r[4].trim() !== '')
    .reduce((s, r) => s + parseFloat(r[4]), 0);
  const roi = entryUsd > 0 ? (total / entryUsd) * 100 : null;
  return {
    markets,
    entered,
    entryRate: markets ? ((entered / markets) * 100).toFixed(1) + '%' : '-',
    settled: settled.length,
    profitable,
    total: total.toFixed(3),
    mean: mean === null ? '-' : mean.toFixed(4),
    roi: roi === null ? '-' : roi.toFixed(1) + '%',
  };
}

function runBacktest(threshold, days, cost) {
  const env = {
    ...process.env,
    FILTER_BEST_SINGLE: '1',
    MIN_PAIR_EDGE: String(threshold),
    SWITCH_D1: '1',
    SWITCH_THRESHOLD: '0.3',
    SINCE_DAYS: String(days),
    MAX_ENTRY_COST: String(cost ?? 0.65),
  };
  const runStart = Date.now();
  // 用 node 直接执行 tsx 的 cli.mjs（避免 Windows 下 .cmd 批处理 spawn 问题）。
  const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const res = spawnSync(process.execPath, [tsxCli, 'scripts/simulate-all-cities.ts'], {
    cwd: ROOT,
    env,
    encoding: 'utf-8',
    timeout: 10 * 60 * 1000,
  });
  // 回测脚本偶发在 exportCsv 之后的收尾阶段以非 0 退出，但 CSV 已完整导出。
  // 此时数据可用：只要检测到本次运行新生成的 detail CSV，就照常解析。
  const freshDetail = latestFreshCsv('backtest-detail_', runStart);
  if (res.status !== 0 && !freshDetail) {
    const outTail = (res.stdout || '').split('\n').slice(-8).join('\n');
    const errTail = (res.stderr || '').split('\n').slice(-8).join('\n');
    throw new Error(
      `回测失败且无新 CSV (edge=${threshold}, days=${days})\n--- stdout 尾部 ---\n${outTail}\n--- stderr 尾部 ---\n${errTail}`,
    );
  }
  return parseDetail(freshDetail ?? latestCsv('backtest-detail_'));
}

function latestFreshCsv(prefix, afterMs) {
  const files = fs
    .readdirSync(OUT)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.csv'))
    .map((f) => path.join(OUT, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const fresh = files.find((f) => fs.statSync(f).mtimeMs >= afterMs - 2000);
  return fresh ?? null;
}

if (SCAN_COST) {
  console.log('开始成本上限扫描（edge 固定 0.16, SWITCH_D1=0.3）...\n');
  for (const w of WINDOWS) {
    console.log(`===== ${w.label}（SINCE_DAYS=${w.days}） =====`);
    console.log('成本   市场数 入场率   结算  盈利  总盈亏     单笔均值    ROI');
    const rows = [];
    for (const c of COSTS) {
      process.stdout.write(`  跑 ${c.toFixed(2)} ...`);
      const r = runBacktest(0.16, w.days, c);
      rows.push([c.toFixed(2), r]);
      process.stdout.write(' 完成\n');
    }
    for (const [label, r] of rows) {
      console.log(
        `${String(label).padEnd(6)}  ${String(r.markets).padEnd(5)} ${String(r.entryRate).padEnd(8)} ${String(r.settled).padEnd(5)} ${String(r.profitable).padEnd(5)} ${String(r.total).padEnd(11)} ${String(r.mean).padEnd(10)} ${String(r.roi).padEnd(6)}`,
      );
    }
    console.log('');
  }
} else {
  console.log('开始 edge 阈值网格扫描（FILTER_BEST_SINGLE=1, SWITCH_D1=0.3）...\n');
  for (const w of WINDOWS) {
    console.log(`===== ${w.label}（SINCE_DAYS=${w.days}） =====`);
    console.log('阈值   市场数 入场率   结算  盈利  总盈亏     单笔均值    ROI');
    const rows = [];
    for (const th of THRESHOLDS) {
      const label = th === 0 ? 'off  ' : th.toFixed(2);
      process.stdout.write(`  跑 ${label} ...`);
      const r = runBacktest(th, w.days);
      rows.push([label, r]);
      process.stdout.write(' 完成\n');
    }
    for (const [label, r] of rows) {
      console.log(
        `${String(label).padEnd(6)}  ${String(r.markets).padEnd(5)} ${String(r.entryRate).padEnd(8)} ${String(r.settled).padEnd(5)} ${String(r.profitable).padEnd(5)} ${String(r.total).padEnd(11)} ${String(r.mean).padEnd(10)} ${String(r.roi).padEnd(6)}`,
      );
    }
    console.log('');
  }
}
console.log('扫描完成。');
