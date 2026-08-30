// 这个文件负责将空间修正后的温度锚值转换成"每个温度桶的概率分布"。
//
// 核心原则：
//   1. 输入必须先经过 SpatialCorrectionEngine 修正，禁止直接使用原始 ensemble 成员做简单平均。
//   2. 输出每个桶的概率，必须包含离散度、共识水平、各源贡献。
//   3. 概率分布是对称的：以修正后的锚值为中心，温度桶离锚越远概率越低。
//
// 实现思路：
//   以修正温度锚为均值，用离散度作为标准差，按正态分布计算每个桶的概率。
//   离散度越高 → 概率分布越宽 → 策略应更保守（因为不确定性大）。
//   共识水平越高 → 各数据源越一致 → 置信度越高。

import type {
  ProbabilityDistribution,
  SpatialCorrectionResult,
  TemperatureBucket,
  DataSourceStatus,
  ForecastHorizon,
  CityId,
} from '../common/types.js';
import { createModuleLogger } from '../common/logger.js';

const logger = createModuleLogger('AdaptiveProbabilityEngine');

/** 集合预报融合输入：成员当天最高温 + 融合权重。 */
export interface EnsembleInput {
  model: string;
  memberCount: number;
  // 当天所有成员最高温（℃，已应用城市偏差平移）。
  memberTemps: number[];
  // 融合权重（0-1）：最终概率 = (1-w)×高斯 + w×ensemble。
  weight: number;
}

export class AdaptiveProbabilityEngine {
  constructor(
    private readonly city: CityId,
    private readonly targetStation: string,
    private readonly buckets: TemperatureBucket[],
  ) {}

  /**
   * 从空间修正结果生成温度桶概率分布。
   *
   * @param corrections 所有数据源经过空间修正后的结果。
   * @param sourceWeights 各数据源当前权重（由 DataIngestionLayer 的健康状态决定）。
   * @param horizon 当前预测阶段（d3/d2/d1/d0）。
   * @param residualSigmaC 历史残差 MAD 稳健 σ（℃, 借鉴 PolyWeather DEB）。
   *   有值时作为分布宽度的下限——真实预测误差幅度通常大于模型间分歧,
   *   用 max(历史残差σ, 源间分歧, 最小离散度) 避免 σ 过窄导致的高估。
   */
  generateDistribution(
    corrections: SpatialCorrectionResult[],
    sourceWeights: Map<string, number>,
    horizon: ForecastHorizon,
    residualSigmaC?: number,
    ensemble?: EnsembleInput,
  ): ProbabilityDistribution {
    // 筛选出有有效修正结果的数据源。
    const validCorrections = corrections.filter(
      (c) => c.confidence > 0 && Number.isFinite(c.spatialCorrectedMaxTemp),
    );

    if (validCorrections.length === 0 && !ensemble) {
      // 没有可用修正时，返回一个均匀分布（各桶概率相等）作为兜底。
      // 策略进程看到均匀分布会知道"数据不可靠"，应暂停开仓。
      return this.createUniformDistribution(horizon);
    }

    // 加权计算最终锚温度（按 sourceWeights 加权）。
    // 若没有任何确定性源但有 ensemble，则锚用 ensemble mean。
    const { anchorTempC, effectiveDispersionC, consensusLevel, sourceContributions } =
      validCorrections.length > 0
        ? this.computeAnchorWithDispersion(validCorrections, sourceWeights, residualSigmaC)
        : this.ensembleAnchorFallback(ensemble!);

    // 高斯路径：以锚 ± σ 正态拟合算桶概率。
    const gaussianBuckets = this.computeBucketProbabilities(
      anchorTempC,
      effectiveDispersionC,
      validCorrections,
    );

    // 集合预报路径：KDE 核密度（仅启用且提供成员时）。
    let buckets = gaussianBuckets;
    let ensembleInfo: ProbabilityDistribution['ensemble'];

    if (ensemble && ensemble.memberTemps.length > 0) {
      const kde = this.ensembleToBucketProbabilities(ensemble.memberTemps);
      const w = Math.max(0, Math.min(1, ensemble.weight));
      // 融合：最终 = (1-w)×高斯 + w×KDE，再归一化。
      buckets = this.buckets.map((b, i) => {
        const g = gaussianBuckets[i]?.probability ?? 0;
        const e = kde.probabilities[i]?.probability ?? 0;
        return { bucket: b, probability: (1 - w) * g + w * e };
      });
      const total = buckets.reduce((s, b) => s + b.probability, 0);
      if (total > 0) {
        for (const b of buckets) b.probability = b.probability / total;
      }
      ensembleInfo = {
        model: ensemble.model,
        memberCount: ensemble.memberCount,
        meanTempC: kde.meanTempC,
        dispersionC: kde.dispersionC,
        probabilities: kde.probabilities,
      };
      logger.info('集合预报已融合进概率', {
        city: this.city,
        model: ensemble.model,
        members: ensemble.memberCount,
        weight: w,
        meanTempC: kde.meanTempC,
        dispersionC: kde.dispersionC,
      });
    }

    return {
      city: this.city,
      targetStation: this.targetStation,
      horizon,
      correctedAnchorTempC: anchorTempC,
      dispersionC: effectiveDispersionC,
      consensusLevel,
      buckets,
      sourceContributions,
      ...(ensembleInfo ? { ensemble: ensembleInfo } : {}),
      generatedAt: new Date(),
    };
  }

  /** 只有 ensemble、没有确定性源时的锚兜底：用成员均值 + 成员离散度。 */
  private ensembleAnchorFallback(ensemble: EnsembleInput): {
    anchorTempC: number;
    effectiveDispersionC: number;
    consensusLevel: number;
    sourceContributions: ProbabilityDistribution['sourceContributions'];
  } {
    const temps = ensemble.memberTemps.filter((t) => Number.isFinite(t));
    const mean = temps.reduce((a, b) => a + b, 0) / Math.max(1, temps.length);
    const sd = Math.sqrt(
      temps.reduce((s, t) => s + (t - mean) * (t - mean), 0) / Math.max(1, temps.length),
    );
    return {
      anchorTempC: Math.round(mean * 100) / 100,
      effectiveDispersionC: Math.max(0.5, sd),
      consensusLevel: 0.3,
      sourceContributions: [
        {
          sourceId: 'open-meteo-ensemble',
          correctedTempC: Math.round(mean * 100) / 100,
          weight: 1.0,
          status: 'healthy',
        },
      ],
    };
  }

  private computeAnchorWithDispersion(
    corrections: SpatialCorrectionResult[],
    sourceWeights: Map<string, number>,
    residualSigmaC?: number,
  ): {
    anchorTempC: number;
    effectiveDispersionC: number;
    consensusLevel: number;
    sourceContributions: ProbabilityDistribution['sourceContributions'];
  } {
    // 1. 计算各数据源权重。
    const totalWeight = corrections.reduce((sum, c) => {
      const w = sourceWeights.get(c.sourceId) ?? 1.0;
      return sum + w * c.confidence;
    }, 0);

    if (totalWeight <= 0) {
      // 所有数据源都被禁用，退回到第一个修正结果。
      const fallback = corrections[0]!;
      return {
        anchorTempC: fallback.spatialCorrectedMaxTemp,
        effectiveDispersionC: 3.0,
        consensusLevel: 0,
        sourceContributions: [
          {
            sourceId: fallback.sourceId,
            correctedTempC: fallback.spatialCorrectedMaxTemp,
            weight: 1.0,
            status: 'degraded',
          },
        ],
      };
    }

    // 2. 加权平均算锚温度。
    let weightedSum = 0;
    let weightedDispersionSum = 0;
    const sourceContributions: ProbabilityDistribution['sourceContributions'] = [];

    for (const c of corrections) {
      const w = (sourceWeights.get(c.sourceId) ?? 1.0) * c.confidence;
      const normalizedWeight = w / totalWeight;

      weightedSum += normalizedWeight * c.spatialCorrectedMaxTemp;

      // 离散度：空间修正的置信度越低，贡献越大。
      // 周边站点少的时候，confidence 低，dispersion 应该更大。
      weightedDispersionSum += normalizedWeight * (1 + (1 - c.confidence) * 2);

      const status: DataSourceStatus = (sourceWeights.get(c.sourceId) ?? 1.0) > 0
        ? 'healthy'
        : 'degraded';

      sourceContributions.push({
        sourceId: c.sourceId,
        correctedTempC: c.spatialCorrectedMaxTemp,
        weight: normalizedWeight,
        status,
      });
    }

    const anchorTempC = weightedSum;

    // 3. 计算有效离散度（各源修正值的标准偏差 + 置信度加权）
    const variance = corrections.reduce((sum, c) => {
      const diff = c.spatialCorrectedMaxTemp - anchorTempC;
      return sum + diff * diff;
    }, 0) / corrections.length;

    const stdDevC = Math.sqrt(variance);
    const effectiveDispersionC = Math.max(
      residualSigmaC ?? 0,
      stdDevC,
      weightedDispersionSum,
    );

    // 4. 共识水平：各数据源修正温度之间的标准差越小，共识越高。
    const consensusLevel = corrections.length > 1
      ? Math.max(0, 1 - stdDevC / 5)
      : 0.3; // 只有一个数据源时给 0.3（保守）

    return { anchorTempC, effectiveDispersionC, consensusLevel, sourceContributions };
  }

  private computeBucketProbabilities(
    anchorTempC: number,
    dispersionC: number,
    corrections: SpatialCorrectionResult[],
  ): ProbabilityDistribution['buckets'] {
    // 如果离散度太小（<0.1），给一个最小值，防止概率计算出现除零。
    const sigma = Math.max(dispersionC, 0.1);

    // 计算每个桶的累积概率。
    // 对于连续桶（如 31、32、33...），用桶边界做正态 CDF 差。
    // 对于开放式桶（如 <=30、>=37），用 CDF 值。
    const bucketProbs = this.buckets.map((bucket) => {
      const probability = this.computeBucketProbability(bucket, anchorTempC, sigma);
      return {
        bucket,
        probability,
      };
    });

    // 归一化：确保所有桶的概率之和为 1。
    const totalProb = bucketProbs.reduce((sum, b) => sum + b.probability, 0);
    if (totalProb > 0 && Math.abs(totalProb - 1) > 0.001) {
      for (const b of bucketProbs) {
        b.probability = b.probability / totalProb;
      }
    }

    return bucketProbs;
  }

  private computeBucketProbability(
    bucket: TemperatureBucket,
    anchorTempC: number,
    sigma: number,
  ): number {
    // 用正态 CDF 计算桶的概率。
    // 每个桶有上下边界，概率 = CDF(上边界) - CDF(下边界)。
    //
    // 例如桶 32（min=31, max=32）：概率 = Φ(32) - Φ(31)
    // 桶 <=30（min=null, max=30）：概率 = Φ(30)
    // 桶 >=37（min=36, max=null）：概率 = 1 - Φ(36)

    const cdf = (x: number): number => {
      // 标准正态 CDF 的近似计算（误差函数实现）。
      const z = (x - anchorTempC) / sigma;
      return 0.5 * (1 + erf(z / Math.SQRT2));
    };

    const upper = bucket.maxTempC !== null ? cdf(bucket.maxTempC) : 1;
    const lower = bucket.minTempC !== null ? cdf(bucket.minTempC) : 0;

    return Math.max(0, upper - lower);
  }

  /**
   * 用集合成员做核密度估计（KDE）算桶概率。
   *
   * 每个成员温度作为一个高斯核的中心，对每个温度桶做核积分，再取成员平均。
   * 相比"单点 + 高斯拟合"（只用均值±σ），KDE 保留集合的真实分布形状
   * （偏态、多峰），尾部概率（极端桶）更贴近真实。
   *
   * 带宽用 Scott 规则：h = 1.06·σ·M^(-1/5)，下限 0.5℃ 防止过窄。
   */
  private ensembleToBucketProbabilities(memberTemps: number[]): {
    probabilities: ProbabilityDistribution['buckets'];
    meanTempC: number;
    dispersionC: number;
  } {
    const temps = memberTemps.filter((t) => Number.isFinite(t));
    if (temps.length === 0) {
      return {
        probabilities: this.buckets.map((bucket) => ({
          bucket,
          probability: 1 / this.buckets.length,
        })),
        meanTempC: 0,
        dispersionC: 10,
      };
    }

    const M = temps.length;
    const meanT = temps.reduce((a, b) => a + b, 0) / M;
    const variance = temps.reduce((s, t) => s + (t - meanT) * (t - meanT), 0) / M;
    const sd = Math.sqrt(variance);
    const h = Math.max(0.5, 1.06 * sd * Math.pow(M, -0.2));

    const probabilities = this.buckets.map((bucket) => {
      let p = 0;
      for (const t of temps) {
        p += this.bucketKernelProbability(bucket, t, h);
      }
      return { bucket, probability: p / M };
    });

    const total = probabilities.reduce((s, b) => s + b.probability, 0);
    if (total > 0) {
      for (const b of probabilities) b.probability = b.probability / total;
    }

    return {
      probabilities,
      meanTempC: Math.round(meanT * 100) / 100,
      dispersionC: Math.round(sd * 100) / 100,
    };
  }

  /** 高斯核（中心 center、带宽 h）在一个温度桶区间内的积分概率。 */
  private bucketKernelProbability(
    bucket: TemperatureBucket,
    center: number,
    h: number,
  ): number {
    const cdf = (x: number): number => 0.5 * (1 + erf((x - center) / (h * Math.SQRT2)));
    const upper = bucket.maxTempC !== null ? cdf(bucket.maxTempC) : 1;
    const lower = bucket.minTempC !== null ? cdf(bucket.minTempC) : 0;
    return Math.max(0, upper - lower);
  }

  private createUniformDistribution(horizon: ForecastHorizon): ProbabilityDistribution {
    // 没有可用数据时的兜底：均匀分布。
    // 每个桶概率相等，离散度设为一个很大的值。
    const uniformProb = 1 / this.buckets.length;

    return {
      city: this.city,
      targetStation: this.targetStation,
      horizon,
      correctedAnchorTempC: 0,
      dispersionC: 10,
      consensusLevel: 0,
      buckets: this.buckets.map((bucket) => ({
        bucket,
        probability: uniformProb,
      })),
      sourceContributions: [],
      generatedAt: new Date(),
    };
  }
}

// 误差函数近似（Abramowitz and Stegun 公式 7.1.26）。
// 精度 ~1.5e-7，对温度桶概率计算足够。
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