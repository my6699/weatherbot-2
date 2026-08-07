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
// 一个 DataHub 可以服务多个城市（每个城市独立配置）。
// 当前实现聚焦上海，但结构上已支持多城市。

import type { Redis } from 'ioredis';
import { DataIngestionLayer } from './DataIngestionLayer.js';
import { BiasCharacterizationLibrary } from './BiasCharacterizationLibrary.js';
import { AdaptiveProbabilityEngine } from './AdaptiveProbabilityEngine.js';
import { DebCalibration } from './DebCalibration.js';
import { createModuleLogger, logError } from '../common/logger.js';
import type { AppConfig, CityConfig } from '../common/config-loader.js';
import type {
  StandardizedForecast,
  SpatialCorrectionResult,
  ForecastHorizon,
  RedisWeatherPayload,
} from '../common/types.js';
import { createRedisClient, writeWeatherData } from './redis-config.js';
import { delayMs } from '../utils/time.js';

const logger = createModuleLogger('DataHubService');

export class DataHubService {
  private readonly ingestion: DataIngestionLayer;
  private readonly biasLibrary: BiasCharacterizationLibrary;
  private readonly debCalibration: DebCalibration;
  private readonly probabilityEngine: AdaptiveProbabilityEngine;
  private readonly redis: Redis;
  private readonly config: AppConfig;
  private running = false;

  constructor(config: AppConfig) {
    this.config = config;
    this.ingestion = new DataIngestionLayer();
    this.biasLibrary = new BiasCharacterizationLibrary(
      config.city.city,
      config.projectRoot,
    );
    this.debCalibration = new DebCalibration(config.projectRoot);
    this.probabilityEngine = new AdaptiveProbabilityEngine(
      config.city.city,
      config.city.settlementStation.stationId,
      config.city.buckets,
    );
    this.redis = createRedisClient();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const pollInterval = this.config.env.DATAHUB_POLL_INTERVAL_SECONDS;
    logger.info(`DataHubService 启动`, {
      city: this.config.city.city,
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
    try {
      await this.redis.quit();
    } catch (error) {
      logError(logger, 'Redis 断开失败', error);
    }
    logger.info('DataHubService 已停止');
  }

  /**
   * 执行一次完整的数据生产流程。
   */
  async runOnce(): Promise<void> {
    const city = this.config.city;
    const { lat, lon } = city.settlementStation;

    try {
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

      if (forecasts.length === 0) {
        logger.error('所有数据源都失败，无法生成概率分布');
        return;
      }

      // 2. 生成多个水平段的概率分布。
      //    每个水平段使用：对应日期的逐日预报温度 + 该水平段的温度档 bias（DEB）
      //    + 该水平段的动态 MAE 权重。回测验证（simulate-all-cities, bias+mae）：
      //    命中率 40.0%、PnL +$2.715（vs baseline 38.1%/+$1.110，+145%）。
      //    d0/d1/d2/d3 对应"今天/明天/后天/大后天"的日最高温预报。
      const horizons: ForecastHorizon[] = ['d3', 'd2', 'd1', 'd0'];
      const dayOffset: Record<ForecastHorizon, number> = { d3: 3, d2: 2, d1: 1, d0: 0 };

      for (const horizon of horizons) {
        const corrections = this.buildHorizonCorrections(
          city,
          forecasts,
          dayOffset[horizon],
          horizon,
        );

        if (corrections.length === 0) {
          logger.error('所有数据源修正都失败，跳过该水平段', { horizon });
          continue;
        }

        // 动态 MAE 权重（该水平段的 ecmwf/gfs 按 1/MAE 缩放，icon 静态 0.2）。
        // 校准表缺失（如 d3 无样本）时回退到数据源健康权重（现状行为）。
        const debWeights = this.debCalibration.getMaeWeights('C', horizon);
        const sourceWeights =
          debWeights.size > 0 ? debWeights : this.ingestion.getSourceWeights();

        const distribution = this.probabilityEngine.generateDistribution(
          corrections,
          sourceWeights,
          horizon,
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
          this.config.env.REDIS_KEY_PREFIX,
          city.city,
          horizon,
          payload,
          this.config.env.DATA_MAX_AGE_SECONDS,
        );
      }

      logger.info('本轮数据采集完成并写入 Redis', {
        city: city.city,
        sources: forecasts.length,
        anchorTemp: forecasts[0]?.forecastedMaxTemp?.toFixed(1),
      });
    } catch (error) {
      logError(logger, 'runOnce 执行失败', error);
    }
  }

  /**
   * 构建某一水平段的偏差修正结果（每数据源一条）。
   *
   * bias 优先级：
   *   1. DEB 温度档 bias（旧项目 bias.json 4 维 key，James-Stein 收缩）——
   *      回测最大赢家。符号约定与旧项目 bias.ts 一致：
   *      bias = mean(预报 - 实际)，修正 = 预报 - bias（把预报拉向实际）。
   *   2. 回退到本系统 BiasCharacterizationLibrary（历史行为，
   *      meanBiasC = 实际 - 预报，修正 = 预报 + bias）。
   */
  private buildHorizonCorrections(
    city: CityConfig,
    forecasts: StandardizedForecast[],
    dayOffset: number,
    horizon: ForecastHorizon,
  ): SpatialCorrectionResult[] {
    const corrections: SpatialCorrectionResult[] = [];
    const season = this.guessSeason(city.timezone);

    for (const forecast of forecasts) {
      try {
        const rawForecastedMaxTemp = this.pickDayTempC(forecast, dayOffset);

        // 1. DEB 温度档 bias（该城市该水平段该数据源的预报温度档）。
        const debBiasC = this.debCalibration.getBiasC(
          city.city,
          horizon,
          forecast.sourceId,
          rawForecastedMaxTemp,
        );

        let biasCorrectedMaxTemp: number;
        if (debBiasC !== 0) {
          biasCorrectedMaxTemp = Math.round((rawForecastedMaxTemp - debBiasC) * 100) / 100;
        } else {
          // 2. 回退：本系统偏差库（历史行为）。
          const bias = this.biasLibrary.getReliableBias(
            city.city,
            forecast.sourceId,
            season,
            'general',
          );
          biasCorrectedMaxTemp = bias
            ? Math.round((rawForecastedMaxTemp + bias.meanBiasC) * 100) / 100
            : rawForecastedMaxTemp;
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
    // 季节影响偏差库的分组，方便按季节精细化校正。
    const now = new Date().toLocaleString('en-US', { timeZone: timezone });
    const month = new Date(now).getMonth() + 1;

    if (month >= 3 && month <= 5) return 'spring';
    if (month >= 6 && month <= 8) return 'summer';
    if (month >= 9 && month <= 11) return 'autumn';
    return 'winter';
  }
}