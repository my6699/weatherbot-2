// 这是本系统的核心模块之一（需求明确标注"重点详细实现"）。
//
// 职责：对主站点预报进行空间加权修正。
//
// 核心逻辑流程：
//   1. 从 config/stations/<city>_nearby.json 读取该城市周边站点列表。
//   2. 用 Haversine 公式计算每个周边站点到主站点的距离。
//   3. 根据距离计算权重（IDW 或高斯核，由城市配置决定）。
//   4. 请求周边站点的实时温度观测（优先 METAR，备用 Open-Meteo）。
//   5. 用加权平均修正主站点预报值。
//   6. 输出修正后的温度值 + 修正置信度。
//
// 每个城市的空间权重和修正参数独立存储，禁止跨城市共用。

import type { SpatialCorrectionInput, SpatialCorrectionResult, NearbyStationObservation, CityId } from '../common/types.js';
import type { CityConfig } from '../common/config-loader.js';
import { createModuleLogger, logError } from '../common/logger.js';
import { computeWeightedStations, spatialCorrectionConfidence, haversineDistanceKm } from '../utils/station-utils.js';
import { DataIngestionLayer } from './DataIngestionLayer.js';
import { BiasCharacterizationLibrary } from './BiasCharacterizationLibrary.js';

const logger = createModuleLogger('SpatialCorrectionEngine');

export interface NearbyStationConfig {
  stationId: string;
  name: string;
  lat: number;
  lon: number;
  sourcePriority: string[];
  manualWeight: number | null;
}

export interface NearbyStationsFile {
  city: CityId;
  settlementStation: {
    stationId: string;
    name: string;
    lat: number;
    lon: number;
  };
  nearbyStations: NearbyStationConfig[];
}

export class SpatialCorrectionEngine {
  constructor(
    private readonly cityConfig: CityConfig,
    private readonly ingestionLayer: DataIngestionLayer,
    private readonly biasLibrary: BiasCharacterizationLibrary,
    private readonly nearbyStations: NearbyStationConfig[],
  ) {}

  /**
   * 执行完整的空间修正流程。
   *
   * 输入：原始预报 + 城市偏差 + 周边站点数据
   * 输出：修正后的温度 + 置信度 + 每个站点权重明细
   */
  async correct(input: SpatialCorrectionInput): Promise<SpatialCorrectionResult> {
    const { city, targetStation, rawForecast, cityBiasProfile } = input;

    // 第一步：城市独立偏差修正。
    // 先修正该数据源在该城市的系统性偏差。
    const biasCorrectedMaxTemp = cityBiasProfile
      ? rawForecast.forecastedMaxTemp + cityBiasProfile.meanBiasC
      : rawForecast.forecastedMaxTemp;

    // 第二步：空间加权修正。
    // 用周边站点实时观测修正局部微气候偏差。
    const spatialResult = await this.performSpatialCorrection(
      city,
      targetStation,
      biasCorrectedMaxTemp,
    );

    const result: SpatialCorrectionResult = {
      city,
      targetStation: targetStation.stationId,
      sourceId: rawForecast.sourceId,
      rawForecastedMaxTemp: rawForecast.forecastedMaxTemp,
      biasCorrectedMaxTemp,
      spatialCorrectedMaxTemp: spatialResult.correctedTemp,
      spatialAdjustmentC: spatialResult.correctedTemp - biasCorrectedMaxTemp,
      confidence: spatialResult.confidence,
      nearbyStationWeights: spatialResult.weights,
      updatedAt: new Date(),
    };

    logger.info('空间修正完成', {
      city,
      station: targetStation.stationId,
      source: rawForecast.sourceId,
      raw: result.rawForecastedMaxTemp.toFixed(1),
      biasCorrected: result.biasCorrectedMaxTemp.toFixed(1),
      spatialCorrected: result.spatialCorrectedMaxTemp.toFixed(1),
      adjustment: result.spatialAdjustmentC.toFixed(2),
      confidence: result.confidence.toFixed(3),
      nearbyCount: result.nearbyStationWeights.length,
    });

    return result;
  }

  private async performSpatialCorrection(
    city: CityId,
    targetStation: { lat: number; lon: number; stationId: string },
    biasCorrectedTemp: number,
  ): Promise<{
    correctedTemp: number;
    confidence: number;
    weights: Array<{ stationId: string; distanceKm: number; weight: number; temp: number }>;
  }> {
    const { maxRadiusKm, minNearbyStations, method, idwPower, gaussianBandwidthKm } =
      this.cityConfig.spatialCorrection;

    // 1. 计算距离并过滤超出半径的站点。
    const stationsWithDistance = this.nearbyStations
      .map((s) => ({
        ...s,
        distanceKm: haversineDistanceKm(targetStation, { lat: s.lat, lon: s.lon }),
      }))
      .filter((s) => s.distanceKm <= maxRadiusKm);

    if (stationsWithDistance.length < minNearbyStations) {
      logger.warn('周边站点不足，跳过空间修正', {
        city,
        required: minNearbyStations,
        available: stationsWithDistance.length,
      });
      // 站点不足时直接返回偏差修正后的温度，不做空间修正。
      return {
        correctedTemp: biasCorrectedTemp,
        confidence: 0.2,
        weights: [],
      };
    }

    // 2. 批量获取周边站点的实时温度观测。
    const observations = await this.ingestionLayer.fetchNearbyStationsBatch(
      stationsWithDistance.map((s) => ({
        stationId: s.stationId,
        lat: s.lat,
        lon: s.lon,
      })),
    );

    // 3. 过滤出有观测数据的站点，计算权重。
    const stationsWithTemp = stationsWithDistance
      .filter((s) => observations.has(s.stationId))
      .map((s) => {
        const obs = observations.get(s.stationId)!;
        return {
          stationId: s.stationId,
          lat: s.lat,
          lon: s.lon,
          distanceKm: s.distanceKm,
          temp: obs.temp,
          // 残差修正需要该站同一日期的模型预报。
          forecastTemp: obs.forecastTemp,
        };
      });

    if (stationsWithTemp.length < minNearbyStations) {
      logger.warn('有观测数据的周边站点不足', {
        city,
        required: minNearbyStations,
        available: stationsWithTemp.length,
      });
      return {
        correctedTemp: biasCorrectedTemp,
        confidence: 0.2,
        weights: [],
      };
    }

    // 4. 使用 station-utils 计算权重并做加权平均。
    const weightedStations = computeWeightedStations(
      targetStation,
      stationsWithTemp.map((s) => ({
        stationId: s.stationId,
        name: s.stationId,
        lat: s.lat,
        lon: s.lon,
      })),
      maxRadiusKm,
      method,
      idwPower,
      gaussianBandwidthKm,
    );

    // 填入实际温度。
    for (const ws of weightedStations) {
      const obs = stationsWithTemp.find((s) => s.stationId === ws.stationId);
      if (obs) {
        ws.temp = obs.temp;
      }
    }

    // 5. 残差修正（方案 A，2026-08-07 启用）：
    //    不再对周边站的"绝对温度"做加权平均 —— 那会把热岛站（虹桥/徐家汇
    //    网格值高估 2~4°C）和海洋站（洋山低估 -3°C）的系统偏差混进主站，
    //    导致锚温度整体偏高约 1°C（8-04~08-06 实测验证）。
    //
    //    正确做法：对每个周边站计算"观测 − 预报"残差，只对残差做空间加权，
    //    再把加权残差加到主站预报上。
    //       residual_i = temp_i − forecastTemp_i   （该站模型偏差）
    //       spatialAdj = Σ w_i × residual_i        （空间插值出主站位置的偏差）
    //       corrected  = 主站预报 + spatialAdj
    //    如果模型在空间上系统性偏低（残差都为正），主站预报也应跟着上调；
    //    反之亦然。这样热岛/海洋的"绝对水平"差异被抵消，只剩模型偏差被传递。
    let residualSum = 0;
    let weightSum = 0;
    for (const ws of weightedStations) {
      const obs = stationsWithTemp.find((s) => s.stationId === ws.stationId);
      if (obs && obs.forecastTemp != null && Number.isFinite(obs.forecastTemp)) {
        // 残差 = 观测 − 该站模型预报。无预报数据的站跳过（权重不参与）。
        residualSum += (obs.temp - obs.forecastTemp) * ws.normalizedWeight;
        weightSum += ws.normalizedWeight;
      }
    }

    const spatialAdj = weightSum > 0 ? residualSum / weightSum : 0;
    const correctedTemp = biasCorrectedTemp + spatialAdj;

    // 6. 计算置信度。
    const confidence = spatialCorrectionConfidence(weightedStations, minNearbyStations);

    // 7. 权重明细。
    const weights = weightedStations.map((ws) => ({
      stationId: ws.stationId,
      distanceKm: ws.distanceKm,
      weight: ws.normalizedWeight,
      temp: ws.temp,
    }));

    return {
      correctedTemp,
      confidence,
      weights,
    };
  }
}