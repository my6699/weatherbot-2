// 这个文件负责每个城市的独立偏差特征库。
//
// 核心原则：禁止使用全局平均偏差。
// 每个城市、每个数据源、每个季节、每种天气类型，都要维护自己的系统性偏差。
//
// 偏差定义：
//   bias = 实际最高温 - 预报最高温
//   正值表示数据源系统性低估（实际更热），负值表示数据源系统性高估。
//
// 存储方式：JSON 文件（data/bias/<city>.json），每个城市一份。
// 简单、可读、跨平台，适合当前阶段。后续可换成 SQLite。
//
// 为什么按 sourceId + city + season + weatherRegime 分组？
// 1. 不同模型（ECMWF/GFS/ICON）偏差不同。
// 2. 不同城市气候不同，ZSPD 的偏差不能用于其他城市。
// 3. 不同季节太阳辐射不同，偏差季节性很强。
// 4. 不同天气类型（晴/雨/台风）偏差差异巨大。

import fs from 'node:fs';
import path from 'node:path';
import type { CityBiasProfile, CityId } from '../common/types.js';
import { createModuleLogger, logError } from '../common/logger.js';

const logger = createModuleLogger('BiasCharacterizationLibrary');

export interface BiasObservation {
  city: CityId;
  sourceId: string;
  season: string;
  weatherRegime: string;
  forecastedMaxTemp: number;
  actualMaxTemp: number;
  date: string;
}

export interface BiasStorage {
  version: number;
  updatedAt: string;
  profiles: CityBiasProfile[];
}

export class BiasCharacterizationLibrary {
  private profiles: CityBiasProfile[] = [];
  private storagePath: string;

  constructor(city: CityId, projectRoot: string) {
    // 每个城市独立存储偏差库，禁止跨城市混用。
    this.storagePath = path.join(projectRoot, 'data', 'bias', `${city}.json`);
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.storagePath)) {
        this.profiles = [];
        logger.info(`偏差库不存在，初始化为空：${this.storagePath}`);
        return;
      }

      const raw = fs.readFileSync(this.storagePath, 'utf8');
      const parsed = JSON.parse(raw) as BiasStorage;
      this.profiles = parsed.profiles ?? [];
      logger.info(`加载偏差库成功，共 ${this.profiles.length} 个 profile：${this.storagePath}`);
    } catch (error) {
      logError(logger, '加载偏差库失败，使用空库', error);
      this.profiles = [];
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const storage: BiasStorage = {
        version: 1,
        updatedAt: new Date().toISOString(),
        profiles: this.profiles,
      };

      fs.writeFileSync(this.storagePath, JSON.stringify(storage, null, 2), 'utf8');
      logger.info(`保存偏差库成功：${this.storagePath}`);
    } catch (error) {
      logError(logger, '保存偏差库失败', error);
    }
  }

  /**
   * 记录一条实际观测结果，用于更新偏差。
   *
   * 当市场结算后，我们知道实际最高温，就可以对比预报值，更新偏差。
   * 这是偏差库动态更新的核心入口。
   */
  recordObservation(observation: BiasObservation): void {
    const biasC = observation.actualMaxTemp - observation.forecastedMaxTemp;

    // 找到对应的 profile key。
    const key = this.profileKey(
      observation.city,
      observation.sourceId,
      observation.season,
      observation.weatherRegime,
    );

    const existing = this.profiles.find((p) => p.city === key.city && p.sourceId === key.sourceId && p.season === key.season && p.weatherRegime === key.weatherRegime);

    if (!existing) {
      // 没有这个 profile，创建新的。
      this.profiles.push({
        city: key.city,
        sourceId: key.sourceId,
        season: key.season,
        weatherRegime: key.weatherRegime,
        meanBiasC: biasC,
        stdBiasC: 0,
        quantilesC: {
          p10: biasC,
          p50: biasC,
          p90: biasC,
        },
        sampleSize: 1,
        updatedAt: new Date(),
      });
    } else {
      // 有 profile，增量更新。
      // 用 Welford 在线算法更新均值和方差，避免存储所有历史样本。
      this.updateProfile(existing, biasC);
    }

    this.save();
  }

  private updateProfile(profile: CityBiasProfile, biasC: number): void {
    const oldMean = profile.meanBiasC;
    const n = profile.sampleSize;

    // Welford 在线均值更新。
    const newMean = oldMean + (biasC - oldMean) / (n + 1);

    // 更新方差（用未归一化的 M2 累计）。
    // 这里简化处理：只记录均值，方差用样本偏差的绝对值近似。
    // 进阶版可以完整实现 Welford 的 M2 更新。
    const spread = Math.abs(biasC - oldMean);
    profile.stdBiasC = profile.sampleSize === 1
      ? spread
      : Math.sqrt(
          (Math.pow(profile.stdBiasC, 2) * (n - 1) + Math.pow(biasC - newMean, 2)) / n,
        );

    // 更新分位数（简化：用 min/max 近似 p10/p90）。
    profile.quantilesC.p10 = Math.min(profile.quantilesC.p10, biasC);
    profile.quantilesC.p90 = Math.max(profile.quantilesC.p90, biasC);

    profile.meanBiasC = newMean;
    profile.sampleSize += 1;
    profile.updatedAt = new Date();
  }

  /**
   * 查询某个场景的偏差 profile。
   *
   * 返回该城市、该数据源、该季节、该天气类型下的偏差均值。
   * 用于 SpatialCorrectionEngine 做第一层偏差修正。
   */
  getBiasProfile(
    city: CityId,
    sourceId: string,
    season: string,
    weatherRegime: string,
  ): CityBiasProfile | null {
    const profile = this.profiles.find(
      (p) =>
        p.city === city &&
        p.sourceId === sourceId &&
        p.season === season &&
        p.weatherRegime === weatherRegime,
    );

    return profile ?? null;
  }

  /**
   * 获取该城市所有偏差 profile（用于可视化复盘）。
   */
  getAllProfiles(city: CityId): CityBiasProfile[] {
    return this.profiles.filter((p) => p.city === city);
  }

  /**
   * 判断某个 profile 是否可信任。
   * 样本太少时不可靠，返回 false，调用方应回退到"不做事前偏差修正"。
   */
  isProfileReliable(profile: CityBiasProfile, minSamples = 5): boolean {
    return profile.sampleSize >= minSamples;
  }

  /**
   * 计算一条偏差的"可信组合"。
   * 如果目标 profile 样本太少，尝试向上聚合到更粗的分组（例如只按 sourceId+city）。
   */
  getReliableBias(
    city: CityId,
    sourceId: string,
    season: string,
    weatherRegime: string,
  ): { meanBiasC: number; reliable: boolean } | null {
    // 1. 精确匹配
    const exact = this.getBiasProfile(city, sourceId, season, weatherRegime);
    if (exact && this.isProfileReliable(exact)) {
      return { meanBiasC: exact.meanBiasC, reliable: true };
    }

    // 2. 回退到只按 sourceId + city（忽略季节和天气类型）
    const fallback = this.profiles.find(
      (p) => p.city === city && p.sourceId === sourceId,
    );
    if (fallback && this.isProfileReliable(fallback)) {
      return { meanBiasC: fallback.meanBiasC, reliable: false };
    }

    // 3. 完全没有数据，返回 null，调用方不做偏差修正。
    return null;
  }

  private profileKey(
    city: CityId,
    sourceId: string,
    season: string,
    weatherRegime: string,
  ): { city: CityId; sourceId: string; season: string; weatherRegime: string } {
    return { city, sourceId, season, weatherRegime };
  }
}