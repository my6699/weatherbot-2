// 这个文件是 DataHubService，整个系统的"唯一数据生产者"。
//
// 职责（串起所有数据模块）：
//   1. 定时从多种气象数据源拉取预报。
//   2. 用城市独立偏差库做偏差修正。
//   3. 用 AdaptiveProbabilityEngine 生成温度桶概率分布。
//   4. 把结果写入 Redis，供各城市策略进程读取。
//   5. 写入每个水平段（d3/d2/d1/d0）的专属 key。
//
// 说明（2026-08-07）：空间修正已停用。
//   实测发现 Open-Meteo 网格对主站 ZSPD 本身很准（±0.5°C），
//   空间修正（周边站加权/残差）无法带来稳定增益，
//   甚至会把热岛/海洋站的网格偏差混进主站。
//   所以当前只做"原始预报 + 城市独立偏差修正"，不再做空间加权。
//
// 多城市（2026-08-08）：一个 DataHub 同时服务所有已配置城市。
//   - 构造时接收全部城市 CityConfig[]。
//   - 每个城市有独立的 BiasCharacterizationLibrary 和 AdaptiveProbabilityEngine。
//   - runOnce() 循环采集所有城市，写入各自 Redis key（按 city 隔离）。

// 必须在所有其他 import 之前加载 .env：
// config-loader 只被 type import（编译后移除），不会执行 dotenv.config()，
// DataHub 是独立进程，若不在入口最先加载 .env，REDIS_URL/采集间隔等配置
// 会全部回退到默认值。
import 'dotenv/config';

import type { Redis } from 'ioredis';
import fs from 'node:fs';
import path from 'node:path';
import { DataIngestionLayer } from './DataIngestionLayer.js';
import { BiasCharacterizationLibrary } from './BiasCharacterizationLibrary.js';
import { AdaptiveProbabilityEngine, type EnsembleInput } from './AdaptiveProbabilityEngine.js';
import { DebCalibration } from './DebCalibration.js';
import { createModuleLogger, logError } from '../common/logger.js';
import type { AppEnv, CityConfig } from '../common/config-loader.js';
import type {
  StandardizedForecast,
  SpatialCorrectionResult,
  ForecastHorizon,
  RedisWeatherPayload,
  ProbabilityDistribution,
  EnsembleDailyForecast,
} from '../common/types.js';
import { createRedisClient, writeWeatherData } from './redis-config.js';
import { delayMs } from '../utils/time.js';

const logger = createModuleLogger('DataHubService');

/** 每个城市独立保存的引擎实例。 */
interface CityRuntime {
  city: CityConfig;
  biasLibrary: BiasCharacterizationLibrary;
  probabilityEngine: AdaptiveProbabilityEngine;
}

/** 落盘的修正后预测记录：key = city|date，每 (城市, 目标日期, 水平段) 保留最新一轮。 */
interface PredictionRecord {
  city: string;
  stationId: string;
  date: string;
  horizons: Record<
    string,
    {
      anchorC: number;
      topBucket: string;
      topMinC: number | null;
      topMaxC: number | null;
      topProb: number;
      secondBucket: string | null;
      secondMinC: number | null;
      secondMaxC: number | null;
      secondProb: number | null;
      // 修正前锚点（原始预报加权平均）及其所在桶，用于评估修正净效果。
      rawAnchorC: number;
      rawTopBucket: string | null;
      rawTopMinC: number | null;
      rawTopMaxC: number | null;
      updatedAt: string;
    }
  >;
}

export class DataHubService {
  private readonly ingestion: DataIngestionLayer;
  private readonly debCalibration: DebCalibration;
  private readonly redis: Redis;
  private readonly env: AppEnv;
  private readonly cities: CityRuntime[];
  private running = false;
  // 偏差表专用刷新定时器（5 分钟）：只 stat 校准文件 mtime，零 API 请求。
  private biasReloadTimer: ReturnType<typeof setInterval> | undefined;

  constructor(env: AppEnv, cityConfigs: CityConfig[]) {
    this.env = env;
    this.ingestion = new DataIngestionLayer();
    this.debCalibration = new DebCalibration(process.cwd());
    this.redis = createRedisClient();

    // 注意：数据采集不做黑名单过滤（黑名单只影响交易开仓）。
    // 黑名单城市仍需持续采集数据，用于未来纠偏和解除黑名单。
    this.cities = cityConfigs.map((city) => ({
      city,
      biasLibrary: new BiasCharacterizationLibrary(city.city, process.cwd()),
      probabilityEngine: new AdaptiveProbabilityEngine(
        city.city,
        city.settlementStation.stationId,
        city.buckets,
      ),
    }));
    if (this.cities.length === 0) {
      throw new Error('未配置任何城市，DataHub 无法启动');
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const pollInterval = this.env.DATAHUB_POLL_INTERVAL_SECONDS;
    logger.info(`DataHubService 启动`, {
      cities: this.cities.map((c) => c.city.city),
      pollIntervalSeconds: pollInterval,
    });

    // 启动后立即执行一次，不等第一个轮询间隔。
    try {
      await this.redis.connect();
    } catch (error) {
      logError(logger, 'Redis 连接失败，DataHub 无法启动', error);
      this.running = false;
      return;
    }

    await this.runOnce();

    // 偏差表专用刷新定时器：每 5 分钟只 stat 两个校准文件（零 API 请求），
    // 发现更新立即重载。与预报轮询解耦——不靠调小轮询间隔刷新偏差表，
    // 避免每 10 分钟全量拉预报撞上 Open-Meteo 免费层每日 1 万次配额。
    const reloadBias = (): void => {
      try {
        if (this.debCalibration.reloadIfChanged()) {
          logger.info('偏差表已更新，DebCalibration 自动重载完成');
        }
      } catch (error) {
        logError(logger, 'DebCalibration 重载失败，沿用旧表', error);
      }
    };
    this.biasReloadTimer = setInterval(reloadBias, 5 * 60 * 1000);

    while (this.running) {
      try {
        await delayMs(pollInterval * 1000);
        await this.runOnce();
      } catch (error) {
        logError(logger, 'DataHub 轮询异常', error);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.biasReloadTimer) {
      clearInterval(this.biasReloadTimer);
      this.biasReloadTimer = undefined;
    }
    try {
      await this.redis.quit();
    } catch (error) {
      logError(logger, 'Redis 断开失败', error);
    }
    logger.info('DataHubService 已停止');
  }

  /**
   * GitHub Actions 定时采集模式：单次完整采集后停止并退出（不进入轮询循环）。
   * 由 DATAHUB_RUN_ONCE=true 触发，用于 Actions 每小时定时采集并提交数据回仓库。
   */
  async runOnceAndExit(): Promise<void> {
    try {
      await this.redis.connect();
    } catch (error) {
      logError(logger, 'Redis 连接失败，单次采集无法启动', error);
      process.exit(1);
    }
    try {
      await this.runOnce();
    } catch (error) {
      logError(logger, '单次采集失败', error);
    }
    await this.stop();
    process.exit(0);
  }

  /**
   * 执行一次完整的数据生产流程：循环采集所有城市。
   */
  async runOnce(): Promise<void> {
    // 偏差表由旧项目 collector 每 2 小时更新，检查 mtime 后自动重载（不重启进程），
    // 保证每轮采集都用到最新校准。
    try {
      if (this.debCalibration.reloadIfChanged()) {
        logger.info('偏差表已更新，DebCalibration 自动重载完成');
      }
    } catch (error) {
      logError(logger, 'DebCalibration 重载失败，本轮沿用旧表', error);
    }

    for (const runtime of this.cities) {
      try {
        await this.runForCity(runtime);
      } catch (error) {
        logError(logger, `采集城市 ${runtime.city.city} 失败`, error);
      }
    }
  }

  /**
   * 采集单个城市的一轮数据。
   */
  private async runForCity(runtime: CityRuntime): Promise<void> {
    const { city } = runtime;
    const { lat, lon } = city.settlementStation;

    logger.info('开始一轮数据采集', { city: city.city });

    // 1. 并行拉取多种数据源的预报。
    const [ecmwf, gfs, icon] = await Promise.all([
      this.ingestion.fetchOpenMeteoEcmwf(lat, lon, 5, city.settlementStation.stationId),
      this.ingestion.fetchOpenMeteoGfs(lat, lon, 5, city.settlementStation.stationId),
      this.ingestion.fetchOpenMeteoIcon(lat, lon, 5, city.settlementStation.stationId),
    ]);

    const forecasts: StandardizedForecast[] = [
      ecmwf,
      gfs,
      icon,
    ].filter((f): f is StandardizedForecast => f !== null);

    if (forecasts.length === 0 && !this.env.ENSEMBLE_ENABLED) {
      logger.error('所有数据源都失败，无法生成概率分布', { city: city.city });
      return;
    }

    // 可选：拉取集合预报（ensemble）。独立请求（模型名动态），失败不影响确定性源。
    let ensemble: EnsembleDailyForecast | null = null;
    if (this.env.ENSEMBLE_ENABLED) {
      ensemble = await this.ingestion.fetchEnsembleDailyMaxes(
        lat,
        lon,
        5,
        city.settlementStation.stationId,
        this.env.ENSEMBLE_MODEL,
        this.env.ENSEMBLE_MAX_MEMBERS,
      );
      if (ensemble) {
        logger.info('集合预报拉取成功', {
          city: city.city,
          model: ensemble.model,
          members: ensemble.memberCount,
          days: ensemble.mean.length,
        });
      } else {
        logger.warn('集合预报拉取失败，本轮回退纯高斯', { city: city.city });
      }
    }

    // 2. 生成多个水平段的概率分布。
    //    d0/d1/d2/d3 对应"今天/明天/后天/大后天"的日最高温预报。
    const horizons: ForecastHorizon[] = ['d3', 'd2', 'd1', 'd0'];
    const dayOffset: Record<ForecastHorizon, number> = { d3: 3, d2: 2, d1: 1, d0: 0 };

    for (const horizon of horizons) {
      const corrections = this.buildHorizonCorrections(
        runtime,
        forecasts,
        dayOffset[horizon],
        horizon,
      );

      if (corrections.length === 0) {
        logger.error('所有数据源修正都失败，跳过该水平段', { city: city.city, horizon });
        continue;
      }

      // 动态 MAE 权重（该水平段的 ecmwf/gfs 按 1/MAE 缩放，icon 静态 0.2）。
      // 校准表缺失（如 d3 无样本）时回退到数据源健康权重。
      const unit = this.unitKey(city);
      const debWeights = this.debCalibration.getMaeWeights(unit, horizon);
      const sourceWeights =
        debWeights.size > 0 ? debWeights : this.ingestion.getSourceWeights();

      const distribution = runtime.probabilityEngine.generateDistribution(
        corrections,
        sourceWeights,
        horizon,
        undefined,
        this.buildEnsembleInput(runtime, ensemble, dayOffset[horizon], horizon),
      );

      const payload: RedisWeatherPayload = {
        city: city.city,
        horizon,
        probability: distribution,
        spatialCorrections: corrections,
        timestamp: new Date().toISOString(),
      };

      await writeWeatherData(
        this.redis,
        this.env.REDIS_KEY_PREFIX,
        city.city,
        horizon,
        payload,
        this.env.DATA_MAX_AGE_SECONDS,
      );

      // 修正前锚点 = 各源原始预报 × 权重的加权平均（与修正后同权重，
      // 用于评估偏差修正的净效果：修正是提高还是拉低命中率）。
      let rawSum = 0;
      let rawW = 0;
      for (const c of corrections) {
        const w = sourceWeights.get(c.sourceId) ?? 0;
        rawSum += c.rawForecastedMaxTemp * w;
        rawW += w;
      }
      const rawAnchorC = rawW > 0 ? rawSum / rawW : corrections[0]?.rawForecastedMaxTemp ?? 0;

      // 落盘修正后的预测（供胜率报告对比结算真值）。
      this.persistPrediction(runtime, distribution, dayOffset[horizon], rawAnchorC);
    }

    logger.info('本轮数据采集完成并写入 Redis', {
      city: city.city,
      sources: forecasts.length,
      anchorTemp: forecasts[0]?.forecastedMaxTemp?.toFixed(1),
    });
  }

  /** 温度单位 key（供 DEB 校准表查询）：华氏城市用 F，摄氏用 C。 */
  private unitKey(city: CityConfig): 'F' | 'C' {
    return (city as { unit?: 'F' | 'C' }).unit ?? 'C';
  }

  /**
   * 构造集合预报的融合输入。
   * 取 ensemble 当天（dayOffset）所有成员的最高温；启用偏差校正时，
   * 用 ensemble mean 当天的温度算一个 ecmwf 温度档偏差，整体平移所有成员
   * （系统性偏移整体平移，不改变分布形状）。
   * 成员不足 2 个时返回 null（概率引擎自动回退纯高斯）。
   */
  private buildEnsembleInput(
    runtime: CityRuntime,
    ensemble: EnsembleDailyForecast | null,
    dayOffset: number,
    horizon: ForecastHorizon,
  ): EnsembleInput | undefined {
    if (!ensemble || !this.env.ENSEMBLE_ENABLED) return undefined;

    const dayTemps: number[] = ensemble.dayTemps
      .map((m) => m[dayOffset])
      .filter(isFiniteNumber);
    if (dayTemps.length < 2) return undefined;

    const meanT = ensemble.mean[dayOffset];
    let shifted = dayTemps;
    if (this.env.ENSEMBLE_BIAS_CORRECT && isFiniteNumber(meanT)) {
      // ecmwf 偏差平移（与确定性源同口径：getBiasC 返回"实际 - 预报"，平移 = 预报 - bias）。
      const biasC = this.debCalibration.getBiasC(
        runtime.city.city,
        horizon,
        'open-meteo-ecmwf',
        meanT,
      );
      if (biasC !== 0) {
        shifted = dayTemps.map((t) => Math.round((t - biasC) * 100) / 100);
        logger.debug('集合成员应用偏差平移', {
          city: runtime.city.city,
          horizon,
          biasC,
          meanBefore: meanT,
          meanAfter: Math.round((meanT - biasC) * 100) / 100,
        });
      }
    }

    return {
      model: ensemble.model,
      memberCount: shifted.length,
      memberTemps: shifted,
      weight: this.env.ENSEMBLE_WEIGHT,
    };
  }

  /**
   * 把修正后的预测落盘到 data/predictions.json（供胜率报告对比结算真值）。
   * key = city|date（UTC 日期），每轮覆盖对应 (城市, 目标日期, 水平段) 的最新预测。
   * 同时记录修正前锚点（rawAnchorC），用于评估偏差修正的净效果。
   */
  private persistPrediction(
    runtime: CityRuntime,
    distribution: ProbabilityDistribution,
    dayOffset: number,
    rawAnchorC: number,
  ): void {
    try {
      const file = path.join(process.cwd(), 'data', 'predictions.json');
      const targetDate = new Date(Date.now() + dayOffset * 86_400_000)
        .toISOString()
        .slice(0, 10);

      const sorted = [...distribution.buckets].sort(
        (a, b) => b.probability - a.probability,
      );
      const top = sorted[0];
      const second = sorted[1];
      // 修正前锚点所在桶（未修正预测落在哪个桶）。
      const rawBucket = distribution.buckets.find(
        (b) =>
          (b.bucket.minTempC === null || rawAnchorC >= b.bucket.minTempC) &&
          (b.bucket.maxTempC === null || rawAnchorC < b.bucket.maxTempC),
      );

      let all: Record<string, PredictionRecord> = {};
      try {
        if (fs.existsSync(file)) {
          all = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, PredictionRecord>;
        }
      } catch (error) {
        logger.warn('读取 predictions.json 失败，重建文件', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const key = `${distribution.city}|${targetDate}`;
      const entry = all[key] ?? {
        city: distribution.city,
        stationId: runtime.city.settlementStation.stationId,
        date: targetDate,
        horizons: {},
      };
      entry.horizons[distribution.horizon] = {
        anchorC: distribution.correctedAnchorTempC,
        topBucket: top?.bucket.label ?? '?',
        topMinC: top?.bucket.minTempC ?? null,
        topMaxC: top?.bucket.maxTempC ?? null,
        topProb: top ? Math.round(top.probability * 1000) / 1000 : 0,
        secondBucket: second?.bucket.label ?? null,
        secondMinC: second?.bucket.minTempC ?? null,
        secondMaxC: second?.bucket.maxTempC ?? null,
        secondProb: second ? Math.round(second.probability * 1000) / 1000 : null,
        rawAnchorC: Math.round(rawAnchorC * 100) / 100,
        rawTopBucket: rawBucket?.bucket.label ?? null,
        rawTopMinC: rawBucket?.bucket.minTempC ?? null,
        rawTopMaxC: rawBucket?.bucket.maxTempC ?? null,
        updatedAt: new Date().toISOString(),
      };
      all[key] = entry;

      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(all), 'utf8');
    } catch (error) {
      logError(logger, '落盘修正后预测失败', error);
    }
  }

  /**
   * 构建某一水平段的偏差修正结果（每数据源一条）。
   *
   * bias 优先级：
   *   1. DEB 温度档 bias（该城市该水平段该数据源的预报温度档）。
   *   2. 回退到本系统 BiasCharacterizationLibrary。
   */
  private buildHorizonCorrections(
    runtime: CityRuntime,
    forecasts: StandardizedForecast[],
    dayOffset: number,
    horizon: ForecastHorizon,
  ): SpatialCorrectionResult[] {
    const { city, biasLibrary } = runtime;
    const corrections: SpatialCorrectionResult[] = [];
    const season = this.guessSeason(city.timezone);

    for (const forecast of forecasts) {
      try {
        const rawForecastedMaxTemp = this.pickDayTempC(forecast, dayOffset);

        let biasCorrectedMaxTemp: number;
        if (this.env.DEB_BIAS_CORRECT) {
          // DEB 温度档 bias（该城市该水平段该数据源的预报温度档）。
          const debBiasC = this.debCalibration.getBiasC(
            city.city,
            horizon,
            forecast.sourceId,
            rawForecastedMaxTemp,
          );

          if (debBiasC !== 0) {
            biasCorrectedMaxTemp = Math.round((rawForecastedMaxTemp - debBiasC) * 100) / 100;
          } else {
            // 回退：本系统偏差库（历史行为）。
            const bias = biasLibrary.getReliableBias(
              city.city,
              forecast.sourceId,
              season,
              'general',
            );
            biasCorrectedMaxTemp = bias
              ? Math.round((rawForecastedMaxTemp + bias.meanBiasC) * 100) / 100
              : rawForecastedMaxTemp;
          }
        } else {
          // DEB_BIAS_CORRECT=false：使用原始预报温度，不修正。
          biasCorrectedMaxTemp = rawForecastedMaxTemp;
        }

        // 不再做空间加权，直接以偏差修正后的温度作为锚定温度。
        corrections.push({
          city: city.city,
          targetStation: city.settlementStation.stationId,
          sourceId: forecast.sourceId,
          rawForecastedMaxTemp,
          biasCorrectedMaxTemp,
          spatialCorrectedMaxTemp: biasCorrectedMaxTemp,
          spatialAdjustmentC: 0,
          confidence: 1.0,
          nearbyStationWeights: [],
          updatedAt: new Date(),
        });
      } catch (error) {
        logError(logger, `数据源 ${forecast.sourceId} 偏差修正失败`, error);
      }
    }

    return corrections;
  }

  /**
   * 取某数据源第 dayOffset 天的逐日最高温预报（℃）。
   * 没有逐日数据时回退到全窗口最高温（历史行为）。
   */
  private pickDayTempC(forecast: StandardizedForecast, dayOffset: number): number {
    const daily = (forecast.metadata?.dailyMaxC as number[] | undefined) ?? [];
    const v = daily[dayOffset];
    return v != null && Number.isFinite(v) ? v : forecast.forecastedMaxTemp;
  }

  private guessSeason(timezone: string): string {
    // 根据城市时区所在月份判断季节。
    const now = new Date().toLocaleString('en-US', { timeZone: timezone });
    const month = new Date(now).getMonth() + 1;

    if (month >= 3 && month <= 5) return 'spring';
    if (month >= 6 && month <= 8) return 'summer';
    if (month >= 9 && month <= 11) return 'autumn';
    return 'winter';
  }
}

/**
 * 命令行入口：`tsx src/data/DataHubService.ts`
 * 启动 DataHub 数据生产者，定时拉取所有城市气象数据并写入 Redis。
 */
async function main(): Promise<void> {
  const { loadEnv, loadAllCityConfigsForCollection } = await import('../common/config-loader.js');
  const env = loadEnv();
  // 采集必须覆盖全部城市（含交易黑名单城市），以持续积累纠偏数据。
  const cityConfigs = loadAllCityConfigsForCollection();

  logger.info(`加载到 ${cityConfigs.length} 个城市配置`);

  const service = new DataHubService(env, cityConfigs);

  // GitHub Actions 定时采集模式：单次执行后退出（不进入无限轮询）。
  if (process.env.DATAHUB_RUN_ONCE === 'true') {
    await service.runOnceAndExit();
    return;
  }

  // 优雅关闭：收到 Ctrl+C 或 PM2 stop 时释放资源。
  process.on('SIGINT', async () => {
    await service.stop();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await service.stop();
    process.exit(0);
  });

  await service.start();
}

// 直接运行时启动（tsx 直接执行本文件）。
main().catch((error) => {
  logError(logger, 'DataHubService 启动失败', error);
  process.exit(1);
});

/** 类型守卫：判断一个未知值是否为有限数字（配合 noUncheckedIndexedAccess 过滤数组）。 */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}