// 这个文件实现多因子选桶打分（TradingDecisionEngine）。
//
// 不再只依赖"模型概率 - 市场价格 > 0.08"单因子。
// 而是对每个候选桶计算 7 个因子的加权总分，再按总分排序选桶。
//
// 7 个因子：
//   1. cheapTail：尾部便宜度（价格 ≤ 0.15 的 YES 或 ≥ 0.45 的 NO）
//   2. modelShock：模型更新冲击（相邻两次概率分布的差异）
//   3. orderFlow：订单流/情绪强度（成交量、订单簿失衡）
//   4. spatialSupport：站点微气候 + 空间修正支持度
//   5. relativeValue：相对价值（相邻桶价格不合理）
//   6. probabilityGap：校准概率与市场价的相对差（即使 3-5% 也可加分）
//   7. dispersionPenalty：离散度过滤（离散度太高扣分）
//
// 权重从 config/<city>.json 的 scoringWeights 读取，可配置可调。

import type {
  ProbabilityDistribution,
  MarketSnapshot,
  TemperatureBucket,
  TradingSignalScore,
  TradingDecision,
  MakerFirstInfo,
  TradeSide,
  ForecastHorizon,
  CityId,
} from '../common/types.js';
import type { CityConfig } from '../common/config-loader.js';
import { createModuleLogger } from '../common/logger.js';

const logger = createModuleLogger('TradingDecisionEngine');

// 双桶入场成本上限：两个桶的 YES 价格之和 ≤ MAX_ENTRY_COST。
// 成本超过上限说明市场已经高度确信，没有足够上行空间。
// 可配：MAX_ENTRY_COST=0.70（回测验证参数用；设 99 即取消上限）。
const MAX_ENTRY_COST = Number(process.env.MAX_ENTRY_COST ?? '0.65');

// 流动性过滤下限（$）：买入 YES 时"可用流动性"（bid/ask 两侧深度较小值）
// 低于该值视为无流动性，live 模式直接不进场。避免在没人接盘的薄盘里开仓。
const MIN_LIQUIDITY_USD = Number(process.env.MIN_LIQUIDITY_USD ?? '100');

// 单桶滑点上限（占价格比例）：估算滑点超过该值说明深度太差，直接拒绝。
const MAX_SLIPPAGE = Number(process.env.MAX_SLIPPAGE ?? '0.05');

export interface CandidateBucket {
  bucket: TemperatureBucket;
  // 模型概率（0-1）。
  modelProbability: number;
  // 市场 YES 价格（0-1）。
  yesPrice: number;
  // 市场 NO 价格（0-1）。
  noPrice: number;
  // 成交量（美元）。
  volumeUsd: number;
  // 订单簿失衡（-1 到 1）。
  orderBookImbalance: number;
  // 可用流动性（$）：bid/ask 两侧深度较小值，用于流动性过滤。
  // 未提供时按 0 处理（无流动性）；生产路径 buildCandidates 会填真实值。
  liquidityUsd?: number;
  // 估算滑点成本（占价格比例，0-1）：buy YES 时穿透 ask 的成本。
  // 未提供时按 0 处理（无滑点）；生产路径 buildCandidates 会填真实值。
  slippage?: number;
  // 空间修正置信度（0-1）。
  spatialConfidence: number;
  // 上一次模型概率（用于计算模型更新冲击）。
  previousProbability?: number;
  // 相邻桶的价格（用于计算相对价值）。
  neighborPrices?: {
    lowerYesPrice?: number;
    higherYesPrice?: number;
  };
}

export interface DecisionContext {
  city: CityId;
  horizon: ForecastHorizon;
  distribution: ProbabilityDistribution;
  candidates: CandidateBucket[];
  tradingMode: 'paper' | 'live';
  // 资金池基准（$）：live 用 CLOB 真实可用余额，paper 用虚拟 bankroll。
  // 凯利动态投注 = 资金池 × f* × 凯利系数，edge 越大投得越多。
  bankrollUsd: number;

  // 凯利 edge 过滤开关（默认 true = 生产）：
  //   true：f* ≤ 0（模型概率不如市场价）→ 不开仓；sizeUsd = min(资金池×f*×系数, 上限)。
  //   false：回测用——选桶行为与旧版完全一致（不拦截、sizeUsd 固定为单笔上限），
  //          凯利只记录 kellyFraction，实际投入由回测脚本自行按 bankroll 递减重放。
  kellyFilter?: boolean;
}

export class TradingDecisionEngine {
  constructor(private readonly cityConfig: CityConfig) {}

  /**
   * 准备 Maker 优先入场信息：从候选桶中找出便宜桶做 Maker，贵桶做 Taker。
   * 回测验证：Maker 阈值 0.30 + 回撤 3%，63/69 笔成交，总盈亏 +15.6%。
   * 仅 D2 时有效，D1/D0 直接 Taker 进场。
   */
  prepareMakerFirst(
    bestA: CandidateBucket,
    bestB: CandidateBucket,
    horizon: ForecastHorizon,
  ): MakerFirstInfo | undefined {
    // 只在 D2 尝试 Maker 优先
    if (horizon !== 'd2') return undefined;

    // 找出便宜桶做 Maker
    const makerBucket = bestA.yesPrice <= bestB.yesPrice ? bestA : bestB;
    const takerBucket = bestA.yesPrice <= bestB.yesPrice ? bestB : bestA;
    const makerLimitPrice = makerBucket.yesPrice;
    const makerQualified = makerLimitPrice <= 0.30;

    return {
      makerBucket: makerBucket.bucket,
      takerBucket: takerBucket.bucket,
      makerLimitPrice,
      makerQualified,
      entryPriceD2: bestA.yesPrice + bestB.yesPrice,
    };
  }

  /**
   * 主入口：选出模型预测的相邻两个桶（双桶区间）并生成交易决策。
   *
   * 选桶逻辑（2026-08-07 双桶区间改造）：
   *   不再选单一桶 —— 单桶选中后只要温度落在相邻桶就全输，
   *   且"最高概率桶"系统性高估（argmax 选择偏差）。
   * 双桶入场决策（D3/D2 市场开盘第一时间使用）。
   *
   * 新逻辑：找"模型和市场最一致"的相邻桶对（区间）：
   *     1. 从候选桶里找出所有相邻桶对（温度边界相连的两个桶）。
   *     2. 过滤：两个桶都必须有交易量（成交量 > 0 才买）。
   *     3. 区间概率 pPair = p(桶A) + p(桶B)，买入成本 = YES(桶A) + YES(桶B)。
   *     4. 按 |pPair - 买入成本| 升序排序，选最"一致"的对。
   *     5. 过滤：买入成本 ≤ 0.65（市场不能太确信）。
   *     6. 生成双桶决策：entryPrice = 两桶 YES 价格之和。
   *   退出逻辑在 ExitStrategy：两桶 bid 之和 >= 0.85 即平仓。
   */
  decide(context: DecisionContext): TradingDecision | null {
    const { candidates, distribution } = context;

    // 1. 离散度过滤：如果整体离散度太高，说明模型不确定性大，不做决策。
    if (distribution.dispersionC > this.maxDispersionThreshold()) {
      logger.warn('离散度过高，跳过决策', {
        city: context.city,
        dispersionC: distribution.dispersionC,
      });
      return null;
    }

    // 2. 准入过滤：只保留模型真正看好的桶。
    //    模型概率阈值：太低说明模型不认为温度会落在这，不选。
    //    交易量过滤：live 模式要求"有交易量的桶才买"（无流动性不进场）；
    //    paper 模式无真实行情（buildCandidates 里 volumeUsd=0 占位），跳过交易量要求，
    //    否则模拟盘永远选不出单，无法验证双桶策略逻辑。
    //    流动性过滤 + 滑点成本（live 模式）：可用深度 < MIN_LIQUIDITY_USD 或
    //    估算滑点 > MAX_SLIPPAGE 的薄盘不进（避免在没人接盘的桶里穿透开仓）。
    const minProb = this.minModelProbability();
    const viable = candidates.filter(
      (c) =>
        c.modelProbability >= minProb &&
        c.yesPrice > 0 && c.yesPrice < 1 &&
        (context.tradingMode !== 'live' ||
          (c.volumeUsd > 0 &&
            (c.liquidityUsd ?? 0) >= MIN_LIQUIDITY_USD &&
            (c.slippage ?? 0) <= MAX_SLIPPAGE)),
    );

    if (viable.length === 0) {
      logger.info('没有候选桶通过准入过滤（模型概率或交易量不足）', {
        city: context.city,
        candidates: candidates.length,
        minModelProbability: minProb,
      });
      return null;
    }

    // 详细日志：每个候选桶的准入结果与拒绝原因（排查为什么没选出交易）。
    logger.info('【开仓评估】准入过滤明细', {
      city: context.city,
      mode: context.tradingMode,
      minModelProbability: minProb,
      viable: viable.length,
      filtered: candidates
        .filter((c) => !viable.includes(c))
        .map((c) => ({
          bucket: c.bucket.label,
          modelP: Math.round(c.modelProbability * 1000) / 1000,
          yesPrice: c.yesPrice,
          volumeUsd: c.volumeUsd,
          rejectReason:
            c.modelProbability < minProb
              ? `modelP ${c.modelProbability.toFixed(3)} < ${minProb}`
              : c.yesPrice <= 0 || c.yesPrice >= 1
                ? `price ${c.yesPrice} 非法`
                : context.tradingMode === 'live' && c.volumeUsd <= 0
                    ? 'volume=0 无流动性'
                    : context.tradingMode === 'live' && (c.liquidityUsd ?? 0) < MIN_LIQUIDITY_USD
                      ? `liquidity ${(c.liquidityUsd ?? 0).toFixed(0)}$ < ${MIN_LIQUIDITY_USD}$`
                      : context.tradingMode === 'live' && (c.slippage ?? 0) > MAX_SLIPPAGE
                        ? `slippage ${((c.slippage ?? 0) * 100).toFixed(1)}% > ${MAX_SLIPPAGE * 100}%`
                        : '未知',
        })),
      viableDetail: viable.map((c) => ({
        bucket: c.bucket.label,
        modelP: Math.round(c.modelProbability * 1000) / 1000,
        yesPrice: c.yesPrice,
        volumeUsd: c.volumeUsd,
        liquidityUsd: Math.round(c.liquidityUsd ?? 0),
        slippage: Math.round((c.slippage ?? 0) * 1000) / 1000,
      })),
    });

    // 3. 找出所有相邻桶对，计算区间概率 pPair。
    //    相邻 = 一个桶的 maxTempC 等于另一个桶的 minTempC。
    const pairs: Array<{ a: CandidateBucket; b: CandidateBucket; pPair: number }> = [];
    for (let i = 0; i < viable.length; i++) {
      for (let j = i + 1; j < viable.length; j++) {
        if (this.isAdjacent(viable[i]!.bucket, viable[j]!.bucket)) {
          const a = viable[i]!;
          const b = viable[j]!;
          pairs.push({ a, b, pPair: a.modelProbability + b.modelProbability });
        }
      }
    }

    if (pairs.length === 0) {
      // 没有相邻桶对：回退到单桶（模型概率最高且有交易量的桶）。
      logger.info('没有相邻桶对，回退单桶选桶', {
        city: context.city,
        viable: viable.length,
      });
      return this.decideSingle(context, viable);
    }

    // 4. 按 |pPair - 买入成本| 升序排序，选模型和市场最"一致"的相邻对。
    //    一致 = 模型预测概率与市场定价差值最小（模型和市场都不离谱）。
    //    滑点成本：live 模式把估算滑点加进有效成本，使 edge/凯利反映真实成交成本。
    const priced = pairs.map((p) => {
      const rawCost = p.a.yesPrice + p.b.yesPrice;
      const slippageCost =
        this.slippageCost(context.tradingMode, p.a) +
        this.slippageCost(context.tradingMode, p.b);
      return {
        ...p,
        entryCost: rawCost,
        effectiveCost: rawCost + slippageCost,
        agreement: Math.abs(p.pPair - rawCost),
        aSlippage: p.a.slippage ?? 0,
        bSlippage: p.b.slippage ?? 0,
      };
    });
    priced.sort((x, y) => x.agreement - y.agreement);

    // 4.5. 成本过滤：两个桶 YES 价格之和（含滑点）必须 ≤ MAX_ENTRY_COST。
    //     成本过高说明市场已高度确信，没有足够上行空间，跳过。
    const affordable = priced.filter((p) => p.effectiveCost <= MAX_ENTRY_COST);

    // 详细日志：每个相邻桶对的区间概率/成本/一致度（排查为什么选中/没选中这对）。
    logger.info('【开仓评估】相邻桶对明细', {
      city: context.city,
      totalPairs: priced.length,
      affordablePairs: affordable.length,
      maxEntryCost: MAX_ENTRY_COST,
      mode: context.tradingMode,
      pairDetail: priced.map((p) => ({
        pair: `${p.a.bucket.label}+${p.b.bucket.label}`,
        pPair: Math.round(p.pPair * 1000) / 1000,
        entryCost: Math.round(p.entryCost * 1000) / 1000,
        effectiveCost: Math.round(p.effectiveCost * 1000) / 1000,
        agreement: Math.round(p.agreement * 1000) / 1000,
        affordable: p.effectiveCost <= MAX_ENTRY_COST,
        a: {
          bucket: p.a.bucket.label,
          modelP: p.a.modelProbability,
          price: p.a.yesPrice,
          volume: p.a.volumeUsd,
          slippage: Math.round(p.aSlippage * 1000) / 1000,
        },
        b: {
          bucket: p.b.bucket.label,
          modelP: p.b.modelProbability,
          price: p.b.yesPrice,
          volume: p.b.volumeUsd,
          slippage: Math.round(p.bSlippage * 1000) / 1000,
        },
      })),
    });

    if (affordable.length === 0) {
      logger.warn('所有候选桶对成本（含滑点）均超过上限，跳过决策', {
        city: context.city,
        bestPair: priced[0]
          ? `${priced[0]!.a.bucket.label}+${priced[0]!.b.bucket.label}`
          : null,
        bestEffectiveCost: priced[0] ? priced[0]!.effectiveCost.toFixed(3) : null,
        maxEntryCost: MAX_ENTRY_COST,
      });
      return null;
    }

    const best = affordable[0]!;
    const entryCost = best.effectiveCost;

    // 凯利动态投注（双桶 N=2）：f* = (2·pPair − 有效成本) / (2 − 有效成本)。
    // 模型概率不如市场价（f* ≤ 0）时无正期望，不开仓。
    // 有效成本含滑点，滑点会吃掉 edge，可能把正期望拉成不进场。
    const kelly = this.kellySizeUsd(2, best.pPair, entryCost, context.bankrollUsd, context.kellyFilter);
    if (!kelly) {
      logger.info('双桶凯利无正期望，跳过开仓', {
        city: context.city,
        buckets: `${best.a.bucket.label}+${best.b.bucket.label}`,
        pPair: best.pPair.toFixed(3),
        entryCost: entryCost.toFixed(3),
        slippageCost: entryCost - best.entryCost,
        kellyFraction: this.rawKellyFraction(2, best.pPair, entryCost).toFixed(3),
      });
      return null;
    }

    const score = this.computeScore(best.a, distribution, this.cityConfig.scoringWeights);

    logger.info('双桶区间选桶完成', {
      buckets: `${best.a.bucket.label}+${best.b.bucket.label}`,
      pPair: best.pPair.toFixed(3),
      entryCost: best.entryCost.toFixed(3),
      slippageCost: (entryCost - best.entryCost).toFixed(4),
      agreement: best.agreement.toFixed(3),
      aPrice: best.a.yesPrice,
      bPrice: best.b.yesPrice,
      kellyFraction: kelly.kellyFraction.toFixed(3),
      sizeUsd: Math.round(kelly.sizeUsd * 100) / 100,
      bankrollUsd: Math.round(context.bankrollUsd * 100) / 100,
      reason: this.buildIntervalReason(best.a, best.b, best.pPair),
    });

    // 5. 生成双桶决策。方向固定 YES（两个桶都买 YES）。
    const makerFirst = this.prepareMakerFirst(best.a, best.b, context.horizon);
    return {
      city: context.city,
      horizon: context.horizon,
      side: 'YES',
      bucket: best.a.bucket,
      buckets: [best.a.bucket, best.b.bucket],
      entryPrice: best.a.yesPrice + best.b.yesPrice,
      sizeUsd: kelly.sizeUsd,
      kellyFraction: kelly.kellyFraction,
      mode: context.tradingMode,
      score,
      ...(makerFirst ? { makerFirst } : {}),
      reason: this.buildIntervalReason(best.a, best.b, best.pPair),
      createdAt: new Date(),
    };
  }

  /**
   * 回退路径：没有合格相邻桶对时，选单个模型概率最高且有交易量的桶。
   */
  private decideSingle(
    context: DecisionContext,
    viable: CandidateBucket[],
  ): TradingDecision | null {
    viable.sort((a, b) => b.modelProbability - a.modelProbability);
    const best = viable[0]!;

    // 详细日志：单桶回退时所有通过准入的候选（排查为什么选了这个桶）。
    logger.info('【开仓评估】单桶回退候选明细', {
      city: context.city,
      viable: viable.map((c) => ({
        bucket: c.bucket.label,
        modelP: Math.round(c.modelProbability * 1000) / 1000,
        yesPrice: c.yesPrice,
        volumeUsd: c.volumeUsd,
      })),
    });

    // 凯利动态投注（单桶 N=1）：f* = (p − 有效价) / (1 − 有效价)。
    // 有效价 = 市场 YES 价 + 滑点（live 模式），滑点会缩小 edge。
    // 单桶"最高概率桶"有 argmax 选择偏差（系统性高估），凯利系数 1/4 + 单笔上限双保险。
    const effectivePrice = best.yesPrice + this.slippageCost(context.tradingMode, best);
    const kelly = this.kellySizeUsd(1, best.modelProbability, effectivePrice, context.bankrollUsd, context.kellyFilter);
    if (!kelly) {
      logger.info('单桶凯利无正期望，跳过开仓', {
        city: context.city,
        bucket: best.bucket.label,
        modelProbability: best.modelProbability.toFixed(3),
        marketPrice: best.yesPrice.toFixed(3),
        effectivePrice: effectivePrice.toFixed(3),
        slippageCost: this.slippageCost(context.tradingMode, best).toFixed(4),
        kellyFraction: this.rawKellyFraction(1, best.modelProbability, effectivePrice).toFixed(3),
      });
      return null;
    }

    const score = this.computeScore(best, context.distribution, this.cityConfig.scoringWeights);

    logger.info('单桶选桶完成', {
      bucket: best.bucket.label,
      modelProbability: best.modelProbability,
      marketPrice: best.yesPrice,
      kellyFraction: kelly.kellyFraction.toFixed(3),
      sizeUsd: Math.round(kelly.sizeUsd * 100) / 100,
      reason: this.buildReason(best, score),
    });

    return {
      city: context.city,
      horizon: context.horizon,
      side: 'YES',
      bucket: best.bucket,
      buckets: [best.bucket],
      entryPrice: best.yesPrice,
      sizeUsd: kelly.sizeUsd,
      kellyFraction: kelly.kellyFraction,
      mode: context.tradingMode,
      score,
      reason: this.buildReason(best, score),
      createdAt: new Date(),
    };
  }

  /**
   * 凯利动态投注金额（多桶统一公式）：
   *   全凯利 f* = (N·p − c) / (N − c)
   *     N = 买入桶数（单桶 1 / 双桶 2），p = 模型总概率，c = 买入总成本。
   *   每笔 = 资金池 × max(0, f*) × KELLY_FRACTION（默认 1/4 分数凯利——模型概率
   *   有系统性误差，全凯利过度投注，1/4 凯利在回测口径更稳），
   *   再受 maxPositionUsd 单笔上限封顶（防止 edge 很大时一笔梭哈）。
   * 返回 null 表示 f* ≤ 0（模型概率不如市场价，无正期望，不开仓）。
   */
  private kellySizeUsd(
    nBuckets: number,
    modelProb: number,
    entryCost: number,
    bankrollUsd: number,
    kellyFilter = true,
  ): { kellyFraction: number; sizeUsd: number } | null {
    const kellyFraction = this.rawKellyFraction(nBuckets, modelProb, entryCost);
    if (kellyFilter && kellyFraction <= 0) return null;
    if (!kellyFilter) {
      // 回测模式：不拦截、不按凯利缩放，sizeUsd 固定为单笔上限（选桶行为与旧版一致）。
      return { kellyFraction, sizeUsd: this.cityConfig.risk.maxPositionUsd };
    }
    const fraction = Number(process.env.KELLY_FRACTION ?? '0.25');
    const sizeUsd = Math.min(
      bankrollUsd * kellyFraction * fraction,
      this.cityConfig.risk.maxPositionUsd,
    );
    return { kellyFraction, sizeUsd };
  }

  /** 全凯利比例 f* = (N·p − c) / (N − c)，不截断（供日志显示原始值）。 */
  private rawKellyFraction(nBuckets: number, modelProb: number, entryCost: number): number {
    const denom = nBuckets - entryCost;
    if (denom <= 0) return 0;
    return (nBuckets * modelProb - entryCost) / denom;
  }

  /**
   * 单个桶在给定交易模式下的滑点成本（占价格比例）。
   * live 模式计入真实估算滑点；paper/回测不产生真实成交成本，返回 0 保持原行为。
   */
  private slippageCost(mode: 'paper' | 'live', candidate: CandidateBucket): number {
    return mode === 'live' ? (candidate.slippage ?? 0) : 0;
  }

  /**
   * 判断两个温度桶是否相邻：
   *   一个桶的上边界等于另一个桶的下边界（如 31-32 与 32-33）。
   * 开区间桶（<=30 / >=37）按单边边界处理。
   */
  private isAdjacent(a: TemperatureBucket, b: TemperatureBucket): boolean {
    const abuts = (x: TemperatureBucket, y: TemperatureBucket): boolean =>
      x.maxTempC !== null && y.minTempC !== null && Math.abs(x.maxTempC - y.minTempC) < 0.01;
    return abuts(a, b) || abuts(b, a);
  }

  /**
   * 双桶区间决策原因（大白话）。
   */
  private buildIntervalReason(a: CandidateBucket, b: CandidateBucket, pPair: number): string {
    return `选中相邻桶 ${a.bucket.label}+${b.bucket.label}（区间概率 ${(pPair * 100).toFixed(0)}%，买入成本 ${((a.yesPrice + b.yesPrice) * 100).toFixed(0)}%）`;
  }

  /**
   * 模型概率准入下限：低于该概率的桶不参与选桶。
   * 模拟中观测到低概率桶（12-20%）大量入围，全是噪音。
   * 设为 0.15，只有模型真正看好的桶才入选。
   */
  private minModelProbability(): number {
    return 0.15;
  }

  /**
   * 计算某个候选桶的 7 因子加权总分。
   */
  computeScore(
    candidate: CandidateBucket,
    distribution: ProbabilityDistribution,
    weights: CityConfig['scoringWeights'],
  ): TradingSignalScore {
    // 各因子打分范围设计为 0-1，乘以权重后求和。
    // 权重从配置读取，方便调参。

    const cheapTailScore = this.scoreCheapTail(candidate);
    const modelShockScore = this.scoreModelShock(candidate);
    const orderFlowScore = this.scoreOrderFlow(candidate);
    const spatialSupportScore = this.scoreSpatialSupport(candidate);
    const relativeValueScore = this.scoreRelativeValue(candidate);
    const probabilityGapScore = this.scoreProbabilityGap(candidate);
    const dispersionPenalty = this.scoreDispersionPenalty(distribution);

    const totalScore =
      weights.cheapTail * cheapTailScore +
      weights.modelShock * modelShockScore +
      weights.orderFlow * orderFlowScore +
      weights.spatialSupport * spatialSupportScore +
      weights.relativeValue * relativeValueScore +
      weights.probabilityGap * probabilityGapScore -
      weights.dispersionPenalty * dispersionPenalty;

    return {
      totalScore,
      cheapTailScore,
      modelShockScore,
      orderFlowScore,
      spatialSupportScore,
      relativeValueScore,
      probabilityGapScore,
      dispersionPenalty,
    };
  }

  // ==================== 7 个因子 ====================

  /**
   * 因子 1：尾部便宜度。
   * YES 价格 ≤ 0.15 或 NO 价格 ≥ 0.45 时加分。
   * 尾部便宜意味着市场给这个桶定价过低，买 YES 的赔率结构更有利。
   */
  private scoreCheapTail(candidate: CandidateBucket): number {
    const yesPrice = candidate.yesPrice;
    const noPrice = candidate.noPrice;

    if (yesPrice <= 0.15) {
      // 越便宜分越高。
      return 1 - yesPrice / 0.15;
    }
    if (noPrice >= 0.45) {
      return (noPrice - 0.45) / 0.55;
    }
    return 0;
  }

  /**
   * 因子 2：模型更新冲击。
   * 模型概率相比上次大幅上升 → 加分（说明新信息利好这个桶）。
   * 模型概率下降 → 不加分。
   */
  private scoreModelShock(candidate: CandidateBucket): number {
    const prev = candidate.previousProbability;
    if (prev === undefined) return 0;

    const change = candidate.modelProbability - prev;
    // 上升超过 0.03（3%）才算"冲击"。
    if (change <= 0.03) return 0;
    return Math.min(1, change / 0.1);
  }

  /**
   * 因子 3：订单流/情绪强度。
   * 成交量高 + 订单簿失衡偏正 → 市场关注度上升 → 加分。
   */
  private scoreOrderFlow(candidate: CandidateBucket): number {
    const volumeScore = Math.min(1, candidate.volumeUsd / 5000); // 5k 美元成交量为满分。
    const imbalanceScore = Math.max(0, candidate.orderBookImbalance); // 只奖励正失衡。

    // 两个子因子各占 50%。
    return 0.5 * volumeScore + 0.5 * imbalanceScore;
  }

  /**
   * 因子 4：站点微气候 + 空间修正支持度。
   * 空间修正置信度高 → 说明有周边站点数据支持 → 加分。
   */
  private scoreSpatialSupport(candidate: CandidateBucket): number {
    return Math.min(1, candidate.spatialConfidence);
  }

  /**
   * 因子 5：相对价值（相邻桶不合理）。
   * 如果相邻桶的价格明显高于本桶，而模型概率接近，则本桶被低估。
   * 例如：模型给桶 32 和 33 概率都是 30%，但市场 32 卖 0.2，33 卖 0.45 → 32 被低估。
   */
  private scoreRelativeValue(candidate: CandidateBucket): number {
    const neighbors = candidate.neighborPrices;
    if (!neighbors) return 0;

    let score = 0;
    let count = 0;

    if (neighbors.lowerYesPrice !== undefined && neighbors.lowerYesPrice > 0) {
      const ratio = candidate.yesPrice / neighbors.lowerYesPrice;
      // 本桶比相邻桶便宜越多，ratio 越低，分越高。
      if (ratio < 0.8) {
        score += (0.8 - ratio) / 0.8;
        count += 1;
      }
    }

    if (neighbors.higherYesPrice !== undefined && neighbors.higherYesPrice > 0) {
      const ratio = candidate.yesPrice / neighbors.higherYesPrice;
      if (ratio < 0.8) {
        score += (0.8 - ratio) / 0.8;
        count += 1;
      }
    }

    return count > 0 ? score / count : 0;
  }

  /**
   * 因子 6：校准概率与市场价的相对差。
   * edge = 模型概率 - 市场 YES 价格 - 滑点成本。
   * 即使只有 3-5% 的 edge 也给分（不再是 8% 的硬门槛）。
   * 滑点会吃掉 edge：深度差、滑点高的桶 edge 变小（paper 滑点为 0，行为不变）。
   */
  private scoreProbabilityGap(candidate: CandidateBucket): number {
    const effectivePrice = candidate.yesPrice + (candidate.slippage ?? 0);
    const edge = candidate.modelProbability - effectivePrice;
    if (edge <= 0.03) return 0;
    return Math.min(1, edge / 0.1);
  }

  /**
   * 因子 7：离散度过滤（惩罚项）。
   * 离散度越高，模型不确定性越大，扣分越多。
   */
  private scoreDispersionPenalty(distribution: ProbabilityDistribution): number {
    const dispersion = distribution.dispersionC;
    // 收紧：0.5°C 以内无惩罚，1°C 以上满分惩罚。
    if (dispersion <= 0.5) return 0;
    return Math.min(1, (dispersion - 0.5) / 0.5);
  }

  /**
   * 离散度硬阈值：超过 2°C 直接跳过决策。
   * 收紧原因：London 等海洋性气候城市模型间分歧大，
   * 5°C 阈值从未触发过，导致模型不确定时仍然盲目开仓。
   */
  private maxDispersionThreshold(): number {
    return 2;
  }

  private buildReason(
    candidate: CandidateBucket,
    score: TradingSignalScore,
  ): string {
    // 用大白话生成决策原因，方便复盘。
    const parts: string[] = [];

    if (score.cheapTailScore > 0.5) parts.push('尾部便宜');
    if (score.modelShockScore > 0.5) parts.push('模型更新冲击');
    if (score.orderFlowScore > 0.5) parts.push('订单流活跃');
    if (score.spatialSupportScore > 0.6) parts.push('空间修正支持');
    if (score.relativeValueScore > 0.5) parts.push('相对价值突出');
    if (score.probabilityGapScore > 0.5) parts.push('概率被低估');

    const detail = parts.length > 0 ? `，因为：${parts.join('、')}` : '';

    return `选中桶 ${candidate.bucket.label}（模型 ${(candidate.modelProbability * 100).toFixed(0)}%，市场 ${(candidate.yesPrice * 100).toFixed(0)}%${detail}）`;
  }
}