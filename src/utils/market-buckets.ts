// 市场原生温度桶解析与概率计算（2026-08-11 起：不再做单位换算，直接用市场原生单位）。
//
// Polymarket 温度市场按城市分两种桶格式：
//   °C 城市（shanghai 等）：单值桶 "be 25°C"        → 精确边界 [24.5, 25.5]°C
//   °F 城市（chicago/dallas 等）：区间桶 "between 74-75°F" → 精确边界 [72.5, 74.5]°F ≈ [22.5, 23.6]°C
//   开放桶："80°F or below"（低）/"90°F or higher"（高）。
//
// 核心原则：
//   1. 显示/存储用原生单位 label（"25C"、"74-75F"、"<=80F"、">=90F"），不做温度换算。
//   2. 概率计算用精确 °C 边界：°F→°C 是线性变换，在 °C 边界上算正态 CDF 与
//      °F 原生单位直接算数学等价（CDF 对线性变换不变），所以内部统一用 °C 边界。

import type { TemperatureBucket } from '../common/types.js';

export interface ParsedMarketBucket {
  // 原生单位 label："25C" / "74-75F" / "<=80F" / ">=90C"
  label: string;
  // 精确 °C 边界（开放桶为 null 边）
  bucket: TemperatureBucket;
  isLow: boolean;
  isHigh: boolean;
}

const QUESTION_RE = /(\d+)\s*[-–]?\s*(\d+)?\s*°\s*([CF])/;

/**
 * 从市场 question 解析原生桶（label + 精确 °C 边界）。
 * question 形如："Will the highest temperature in Shanghai be 25°C on August 11?"、
 * "…between 74-75°F…"、"…80°F or below…"、"…90°F or higher…"。
 * 解析不到数字+单位返回 null。
 */
export function parseMarketQuestion(q: string): ParsedMarketBucket | null {
  const match = q.match(QUESTION_RE);
  if (!match) return null;
  const lo = Number(match[1]);
  const hi = match[2] ? Number(match[2]) : lo;
  const isF = match[3] === 'F';
  const isLow = /or below|or lower|below/i.test(q);
  const isHigh = /or higher|or above|above/i.test(q);

  // 原生刻度的精确边界：单值桶 [v-0.5, v+0.5]，区间桶 [lo-0.5, hi+0.5]。
  // 开放桶只用单边：or below → 上边界 hi+0.5；or higher → 下边界 lo-0.5。
  const toC = (x: number): number => (isF ? ((x - 32) * 5) / 9 : x);
  const unit = isF ? 'F' : 'C';

  let label: string;
  let bucket: TemperatureBucket;
  if (isLow) {
    label = `<=${lo}${unit}`;
    bucket = { label, minTempC: null, maxTempC: toC(hi + 0.5) };
  } else if (isHigh) {
    label = `>=${lo}${unit}`;
    bucket = { label, minTempC: toC(lo - 0.5), maxTempC: null };
  } else if (hi > lo) {
    label = `${lo}-${hi}${unit}`;
    bucket = { label, minTempC: toC(lo - 0.5), maxTempC: toC(hi + 0.5) };
  } else {
    label = `${lo}${unit}`;
    bucket = { label, minTempC: toC(lo - 0.5), maxTempC: toC(hi + 0.5) };
  }
  return { label, bucket, isLow, isHigh };
}

/**
 * 桶命中概率：在精确 °C 边界上用正态 CDF 计算（与 AdaptiveProbabilityEngine 同公式）。
 * anchorTempC / dispersionC 来自概率分布的 correctedAnchorTempC / dispersionC。
 */
export function bucketProbability(
  bucket: TemperatureBucket,
  anchorTempC: number,
  dispersionC: number,
): number {
  const sigma = Math.max(dispersionC, 0.1);
  const cdf = (x: number): number => {
    const z = (x - anchorTempC) / sigma;
    return 0.5 * (1 + erf(z / Math.SQRT2));
  };
  const upper = bucket.maxTempC !== null ? cdf(bucket.maxTempC) : 1;
  const lower = bucket.minTempC !== null ? cdf(bucket.minTempC) : 0;
  return Math.max(0, upper - lower);
}

// 误差函数近似（Abramowitz and Stegun 公式 7.1.26），精度 ~1.5e-7。
function erf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x >= 0 ? 1 : -1;
  const absX = Math.abs(x);
  const t = 1 / (1 + p * absX);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return sign * y;
}
