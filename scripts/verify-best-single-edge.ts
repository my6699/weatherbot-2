// 最优单桶 edge 过滤——模拟环境快速验证（2026-08-12）。
//
// 直接 import 生产代码的纯函数 bestSingleEdgeOf（MultiCityStrategy），
// 构造典型场景断言通过/跳过判断，确保生产逻辑无冲突：
//   ① 双桶 A 优（edge 0.20）B 噪音（0.02）→ best=0.20 ≥ 0.16 放行（噪音不否决）
//   ② 双桶 A 弱（edge 0.05）B 更弱（0.02）→ best=0.05 < 0.16 跳过
//   ③ 单桶回退 → 过滤不适用（生产只对 buckets.length>=2 生效）
//   ④ 候选缺失（未知桶）→ 返回 null，调用方放行（维持旧行为）
// 用法：npx tsx scripts/verify-best-single-edge.ts

import { bestSingleEdgeOf } from '../src/strategies/MultiCityStrategy.js';

// 与生产同构的候选桶（真实快照口径：modelProbability / yesPrice）。
const candidates = [
  { bucket: { label: '35C' }, modelProbability: 0.45, yesPrice: 0.25 }, // edge 0.20
  { bucket: { label: '36C' }, modelProbability: 0.22, yesPrice: 0.20 }, // edge 0.02
  { bucket: { label: '37C' }, modelProbability: 0.1, yesPrice: 0.05 }, // edge 0.05
  { bucket: { label: '38C' }, modelProbability: 0.3, yesPrice: 0 }, // 价格非法（0）→ 跳过该桶
];

// 生产阈值（与 BEST_SINGLE_EDGE 默认值对齐，0.16）。
const THRESHOLD = 0.16;

const cases: Array<{
  name: string;
  buckets: string[];
  expect: number | null;
  pass: boolean | null; // true=放行 false=跳过 null=不适用（单桶/未知）
}> = [
  {
    name: 'A优0.20+B噪音0.02 → best=0.20 放行（第二优桶不否决）',
    buckets: ['35C', '36C'],
    expect: 0.2,
    pass: true,
  },
  {
    name: 'A弱0.05+B更弱0.02 → best=0.05 跳过',
    buckets: ['37C', '36C'],
    expect: 0.05,
    pass: false,
  },
  {
    name: '单桶 35C → best=0.20（但生产仅双桶触发过滤，不适用）',
    buckets: ['35C'],
    expect: 0.2,
    pass: null,
  },
  {
    name: '含价格非法桶 35C+38C → best=0.20（38C yesPrice=0 被跳过）',
    buckets: ['35C', '38C'],
    expect: 0.2,
    pass: true,
  },
  {
    name: '未知桶 → null 放行',
    buckets: ['40C'],
    expect: null,
    pass: null,
  },
];

let ok = true;
for (const c of cases) {
  const got = bestSingleEdgeOf(
    c.buckets.map((label) => ({ label })),
    candidates,
  );
  const match = got === c.expect;
  ok = ok && match;
  let action: string;
  if (c.pass === null) {
    action = '不适用（单桶/候选缺失 → 放行）';
  } else {
    action = c.pass ? '放行' : '跳过';
  }
  console.log(
    `${match ? 'PASS' : 'FAIL'}  [${c.buckets.join('+')}] ${c.name}\n` +
      `      bestSingleEdge=${got}  期望=${c.expect}  ≥${THRESHOLD}? → ${action}`,
  );
}

console.log(ok ? '\n全部断言通过，生产过滤逻辑无冲突。' : '\n存在断言失败，请检查。');
process.exit(ok ? 0 : 1);
