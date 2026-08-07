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
  TradeSide,
  ForecastHorizon,
  CityId,
} from '../common/types.js';
import type { CityConfig } from '../common/config-loader.js';
import { createModuleLogger } from '../common/logger.js';

const logger = createModuleLogger('TradingDecisionEngine');

// 双桶入场 edge 直过滤：模型区间置信 pPair 必须显著高于买入成本。
//   pPair - 买入成本 >= MIN_PAIR_EDGE 才允许开仓。
// 依据（2026-08-07 诊断）：双桶路径只按 pPair 排序选桶，没有 edge 检查，
// tel-aviv 08-05 用 0.905 买入自己只信 67% 的桶对（市场 87-93% 反而更准）。
// 价格绝对值上限（0.5/0.85）已验证是负优化——edge 直过滤只拦"模型自己都不信的贵单"。
const MIN_PAIR_EDGE = 0.10;

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
}

export class TradingDecisionEngine {
  constructor(private readonly cityConfig: CityConfig) {}

  /**
   * 主入口：选出模型预测的相邻两个桶（双桶区间）并生成交易决策。
   *
   * 选桶逻辑（2026-08-07 双桶区间改造）：
   *   不再选单一桶 —— 单桶选中后只要温度落在相邻桶就全输，
   *   且"最高概率桶"系统性高估（argmax 选择偏差）。
   *
   *   新逻辑：找"最接近实际温度"的相邻桶对（区间）：
   *     1. 从候选桶里找出所有相邻桶对（温度边界相连的两个桶）。
   *     2. 过滤：两个桶都必须有交易量（成交量 > 0 才买）。
   *     3. 区间概率 pPair = p(桶A) + p(桶B)，选 pPair 最高的对。
   *     4. 生成双桶决策：entryPrice = 两桶 YES 价格之和。
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
    const viable = candidates.filter(
      (c) =>
        c.modelProbability >= this.minModelProbability() &&
        c.yesPrice > 0 && c.yesPrice < 1 &&
        (context.tradingMode !== 'live' || c.volumeUsd > 0),
    );

    if (viable.length === 0) {
      logger.info('没有候选桶通过准入过滤（模型概率或交易量不足）', {
        city: context.city,
        candidates: candidates.length,
      });
      return null;
    }

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

    // 4. 按区间概率排序，选最高的相邻对。
    pairs.sort((x, y) => y.pPair - x.pPair);
    const best = pairs[0]!;

    // 4.5. 双桶入场 edge 直过滤：模型区间置信 pPair 必须显著高于买入成本。
    //     pPair - 买入成本 >= MIN_PAIR_EDGE 才允许开仓（与回测 simulate-all-cities 对齐）。
    //     edge 不足说明模型自己都不信这个区间，买了就是给市场送钱，跳过本轮。
    const entryCost = best.a.yesPrice + best.b.yesPrice;
    if (best.pPair - entryCost < MIN_PAIR_EDGE) {
      logger.warn('双桶区间 edge 不足，跳过决策', {
        city: context.city,
        buckets: `${best.a.bucket.label}+${best.b.bucket.label}`,
        pPair: best.pPair.toFixed(3),
        entryCost: entryCost.toFixed(3),
        edge: (best.pPair - entryCost).toFixed(3),
      });
      return null;
    }

    const score = this.computeScore(best.a, distribution, this.cityConfig.scoringWeights);

    logger.info('双桶区间选桶完成', {
      buckets: `${best.a.bucket.label}+${best.b.bucket.label}`,
      pPair: best.pPair.toFixed(3),
      entryCost: (best.a.yesPrice + best.b.yesPrice).toFixed(3),
      aPrice: best.a.yesPrice,
      bPrice: best.b.yesPrice,
      reason: this.buildIntervalReason(best.a, best.b, best.pPair),
    });

    // 5. 生成双桶决策。方向固定 YES（两个桶都买 YES）。
    return {
      city: context.city,
      horizon: context.horizon,
      side: 'YES',
      bucket: best.a.bucket,
      buckets: [best.a.bucket, best.b.bucket],
      entryPrice: best.a.yesPrice + best.b.yesPrice,
      sizeUsd: this.cityConfig.risk.maxPositionUsd,
      mode: context.tradingMode,
      score,
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
    const score = this.computeScore(best, context.distribution, this.cityConfig.scoringWeights);

    logger.info('单桶选桶完成', {
      bucket: best.bucket.label,
      modelProbability: best.modelProbability,
      marketPrice: best.yesPrice,
      reason: this.buildReason(best, score),
    });

    return {
      city: context.city,
      horizon: context.horizon,
      side: 'YES',
      bucket: best.bucket,
      buckets: [best.bucket],
      entryPrice: best.yesPrice,
      sizeUsd: this.cityConfig.risk.maxPositionUsd,
      mode: context.tradingMode,
      score,
      reason: this.buildReason(best, score),
      createdAt: new Date(),
    };
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
   * edge = 模型概率 - 市场 YES 价格。
   * 即使只有 3-5% 的 edge 也给分（不再是 8% 的硬门槛）。
   */
  private scoreProbabilityGap(candidate: CandidateBucket): number {
    const edge = candidate.modelProbability - candidate.yesPrice;
    if (edge <= 0.03) return 0;
    return Math.min(1, edge / 0.1);
  }

  /**
   * 因子 7：离散度过滤（惩罚项）。
   * 离散度越高，模型不确定性越大，扣分越多。
   */
  private scoreDispersionPenalty(distribution: ProbabilityDistribution): number {
    const dispersion = distribution.dispersionC;
    // 1°C 以内无惩罚，2°C 开始明显惩罚，4°C 以上满分惩罚。
    if (dispersion <= 1) return 0;
    return Math.min(1, (dispersion - 1) / 3);
  }

  /**
   * 离散度硬阈值：超过 5°C 直接跳过决策。
   */
  private maxDispersionThreshold(): number {
    return 5;
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