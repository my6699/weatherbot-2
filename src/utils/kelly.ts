// 这个文件实现凯利公式仓位管理。
//
// 为什么要做仓位管理？
// 即使策略选桶胜率很高，如果每次都全仓投入，一次黑天鹅就能亏光本金。
// 凯利公式给出的是"最优下注比例"，让长期复利增长最快，同时控制破产风险。
//
// 凯利公式（单笔）：
//   f* = (b * p - q) / b
//      = p - q / b
//
// 其中：
//   p = 赢的概率
//   q = 输的概率 = 1 - p
//   b = 赔率（净利润 / 净亏损）
//
// 在 Polymarket 温度市场里买 YES：
//   买入价格 askPrice（例如 0.30）
//   若命中结算为 1，净利润 = 1 - askPrice
//   若未命中结算为 0，净亏损 = -askPrice
//   所以赔率 b = (1 - askPrice) / askPrice
//
// 注意：这里我们买入后不是为了持有到结算，而是会在 D0 提前离场。
// 但离场价格不确定，所以先用"结算价 1 或 0"作为保守的赔率估计。
// 实际使用时会在 softExit 阶段分批卖出，盈利结构更复杂。

import type { TradeSide } from '../common/types.js';

export interface KellyInput {
  // 模型评估的胜率，范围 0 到 1。
  winProbability: number;

  // 买单价格，范围 0 到 1。
  price: number;

  // 交易方向。
  side: TradeSide;

  // 分仓系数（Fractional Kelly），推荐 0.25 到 0.5。
  // 全 Kelly 波动太大，实际交易常用分仓凯利来降低收益的波动。
  // 默认 0.25，即"只押全凯利的四分之一"。
  fraction?: number;
}

export interface KellyOutput {
  // 全凯利比例，范围 0 到 1。
  fullKellyFraction: number;

  // 分仓后的最终下注比例，范围 0 到 1。
  recommendedFraction: number;

  // 是否建议下注。
  // false 表示胜率不足或价格过高，应该放弃，而不是下注。
  shouldBet: boolean;

  // 原因说明，便于日志记录和复盘。
  reason: string;
}

export function calculateKelly(input: KellyInput): KellyOutput {
  const { winProbability, price, side } = input;
  const fraction = input.fraction ?? 0.25;

  // 输入校验：概率必须在 0~1，价格必须在 0~1。
  if (winProbability <= 0 || winProbability >= 1) {
    return {
      fullKellyFraction: 0,
      recommendedFraction: 0,
      shouldBet: false,
      reason: `胜概率必须在 0~1 之间，实际为 ${winProbability}，跳过下注`,
    };
  }

  if (price <= 0 || price >= 1) {
    return {
      fullKellyFraction: 0,
      recommendedFraction: 0,
      shouldBet: false,
      reason: `价格必须在 0~1 之间，实际为 ${price}，跳过下注`,
    };
  }

  // 计算赔率 b。
  let b: number;
  let lossProbability: number;

  if (side === 'YES') {
    // 买 YES：花 price 买入，赢则得到 1（利润 1-price），输则失去 price。
    b = (1 - price) / price;
    lossProbability = 1 - winProbability;
  } else {
    // 买 NO：花 (1 - price)？不对。
    // NO 价格 = 1 - YES价格。
    // 这里如果没有单独传入 NO 价格，用 noPrice = 1 - yesPrice。
    const noPrice = 1 - price;
    b = (1 - noPrice) / noPrice;
    lossProbability = 1 - winProbability;
  }

  // 全凯利公式。
  // f* = (b * p - q) / b
  const fullKelly = (b * winProbability - lossProbability) / b;

  if (fullKelly <= 0) {
    return {
      fullKellyFraction: fullKelly,
      recommendedFraction: 0,
      shouldBet: false,
      reason: `凯利结果为 ${fullKelly.toFixed(4)}（≤0），说明该下注的期望为负或风险过高，跳过`,
    };
  }

  // 分仓凯利：只投入推荐的比例。
  const recommendedFraction = Math.min(fullKelly * fraction, 1);

  return {
    fullKellyFraction: fullKelly,
    recommendedFraction,
    shouldBet: true,
    reason: `凯利 ${fullKelly.toFixed(4)}，分仓 ${fraction}，建议下注比例 ${recommendedFraction.toFixed(4)}`,
  };
}

export function calculatePositionSizeUsd(
  bankrollUsd: number,
  kellyOutput: KellyOutput,
  maxPositionUsd: number,
): number {
  // 根据凯利比例和风控上限计算实际下注金额。
  //
  // 实际投入 = min(银行 × 分仓凯利比例, 单次最大允许金额)。
  // 双重约束：
  //   1. 银行 × 凯利比例：保证不梭哈。
  //   2. maxPositionUsd：绝对风控上限，防止凯利算出一个很大的比例。
  //
  // 如果凯利建议不下注，返回 0。

  if (!kellyOutput.shouldBet) {
    return 0;
  }

  const kellyAmountUsd = bankrollUsd * kellyOutput.recommendedFraction;
  return Math.min(kellyAmountUsd, maxPositionUsd);
}