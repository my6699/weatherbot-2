// 这个文件负责对接多源气象数据，统一成标准化格式。
//
// 数据源优先级（免费稳定）：
//   1. Open-Meteo（主推，支持 ECMWF、ICON、GFS、CMA 等模型）
//   2. Real-time METAR（主站点 + 周边站点实时观测）
//
// 每个数据源都返回 StandardizedForecast，后续模块统一处理。
//
// 数据源失败处理：
//   连续失败 3 次后自动降权（权重降低，但仍保留在概率引擎的贡献列表里）。
//   连续失败 5 次后标记为 disabled，不再请求该数据源。

import axios from 'axios';
import type {
  StandardizedForecast,
  NearbyStationObservation,
  EnsembleDailyForecast,
} from '../common/types.js';
import { createModuleLogger, logError } from '../common/logger.js';

const logger = createModuleLogger('DataIngestionLayer');

// 数据源失败阈值：连续失败多少次后降权。
const FAILURE_THRESHOLD = Number(process.env.DATA_SOURCE_FAILURE_THRESHOLD) || 3;

export interface DataSourceStatusEntry {
  sourceId: string;
  consecutiveFailures: number;
  status: 'healthy' | 'degraded' | 'disabled';
  lastSuccessAt?: Date;
  lastError?: string;
}

export class DataIngestionLayer {
  private sourceStatuses: Map<string, DataSourceStatusEntry> = new Map();

  constructor() {
    this.initSourceStatus('open-meteo-ecmwf');
    this.initSourceStatus('open-meteo-gfs');
    this.initSourceStatus('open-meteo-icon');
    this.initSourceStatus('open-meteo-ensemble');
    this.initSourceStatus('metar');
  }

  // ==================== 公开接口 ====================

  async fetchOpenMeteoEcmwf(
    lat: number,
    lon: number,
    forecastDays: number,
    targetStation: string,
  ): Promise<StandardizedForecast | null> {
    return this.safeFetch('open-meteo-ecmwf', () =>
      this.fetchOpenMeteoModel('ecmwf', lat, lon, forecastDays, targetStation),
    );
  }

  async fetchOpenMeteoGfs(
    lat: number,
    lon: number,
    forecastDays: number,
    targetStation: string,
  ): Promise<StandardizedForecast | null> {
    return this.safeFetch('open-meteo-gfs', () =>
      this.fetchOpenMeteoModel('gfs_global', lat, lon, forecastDays, targetStation),
    );
  }

  async fetchOpenMeteoIcon(
    lat: number,
    lon: number,
    forecastDays: number,
    targetStation: string,
  ): Promise<StandardizedForecast | null> {
    return this.safeFetch('open-meteo-icon', () =>
      this.fetchOpenMeteoModel('icon', lat, lon, forecastDays, targetStation),
    );
  }

  async fetchMetarTemp(
    stationId: string,
    lat: number,
    lon: number,
  ): Promise<StandardizedForecast | null> {
    return this.safeFetch('metar', () => this.fetchMetarObservation(stationId, lat, lon));
  }

  /**
   * 拉取 Open-Meteo 集合预报（ensemble）的逐日最高温。
   *
   * 与确定性模型不同，ensemble 返回 N 个"扰动成员"，代表同一时刻的 N 种可能天气。
   * 用成员分布直接估计桶概率，比单点预报 + 高斯拟合更贴近真实不确定性，
   * 尾部（极端温度）概率尤其准。
   *
   * 端点：https://ensemble-api.open-meteo.com/v1/ensemble
   * 返回 hourly temperature_2m + temperature_2m_memberNN，按 UTC 自然日分组取每成员 max。
   *
   * @param model 集合模型名，如 ecmwf_ifs025（ECMWF 51 成员）/ gfs025（GFS 31 成员）/ icon_seamless（ICON 40 成员）。
   * @param maxMembers 实际使用的成员数上限（0 = 全部）。请求体积大时用于抽样降载。
   */
  async fetchEnsembleDailyMaxes(
    lat: number,
    lon: number,
    forecastDays: number,
    targetStation: string,
    model = 'ecmwf_ifs025',
    maxMembers = 0,
  ): Promise<EnsembleDailyForecast | null> {
    return this.safeFetch('open-meteo-ensemble', () =>
      this.fetchEnsembleModel(lat, lon, forecastDays, targetStation, model, maxMembers),
    );
  }

  /**
   * 获取某个周边站点的实时温度观测（用于空间修正）。
   *
   * 残差修正需要"观测 − 预报"成对数据：
   *   - temp：真实观测（优先 METAR 实时温度）
   *   - forecastTemp：该站同一日期的最高温预报（Open-Meteo daily max）
   * 若预报拉取失败，forecastTemp 不填，残差修正会跳过该站（不影响整体）。
   */
  async fetchNearbyStationObservation(
    stationId: string,
    lat: number,
    lon: number,
  ): Promise<NearbyStationObservation | null> {
    try {
      // 优先用 METAR 实时观测。
      const metar = await this.fetchMetarObservation(stationId, lat, lon);
      const temp = metar ? metar.forecastedMaxTemp : null;

      // 并行拉取该站当天的最高温预报（daily max），作为残差修正的 forecastTemp。
      let forecastTemp: number | undefined;
      try {
        const daily = await this.fetchOpenMeteoDailyMax(lat, lon);
        if (daily != null) forecastTemp = daily;
      } catch {
        // 预报拉取失败不影响观测返回。
      }

      if (temp == null) {
        // METAR 失败时用 Open-Meteo 当前温度作为观测。
        const gfs = await this.fetchOpenMeteoModel('gfs_global', lat, lon, 0, stationId);
        if (!gfs) return null;
        return {
          stationId,
          lat,
          lon,
          temp: gfs.forecastedMaxTemp,
          ...(forecastTemp != null ? { forecastTemp } : {}),
          distanceKm: 0,
          observedAt: gfs.issuanceTime,
          sourceId: 'open-meteo-gfs',
        };
      }

      return {
        stationId,
        lat,
        lon,
        temp,
        ...(forecastTemp != null ? { forecastTemp } : {}),
        distanceKm: 0, // 调用方填入
        observedAt: metar!.issuanceTime,
        sourceId: 'metar',
      };
    } catch {
      return null;
    }
  }

  /**
   * 批量获取周边站点的观测数据。
   */
  async fetchNearbyStationsBatch(
    stations: Array<{ stationId: string; lat: number; lon: number }>,
  ): Promise<Map<string, NearbyStationObservation>> {
    const results = new Map<string, NearbyStationObservation>();

    // 并行请求所有站点，不互相阻塞。
    const promises = stations.map(async (s) => {
      const obs = await this.fetchNearbyStationObservation(s.stationId, s.lat, s.lon);
      if (obs) {
        results.set(s.stationId, obs);
      }
    });

    await Promise.allSettled(promises);
    return results;
  }

  /**
   * 获取所有数据源的健康状态。
   */
  getSourceHealthStatuses(): DataSourceStatusEntry[] {
    return Array.from(this.sourceStatuses.values());
  }

  /**
   * 获取各数据源当前权重（用于概率引擎）。
   * 健康 = 1.0，降级 = 0.3，禁用 = 0。
   */
  getSourceWeights(): Map<string, number> {
    const weights = new Map<string, number>();
    for (const [sourceId, entry] of this.sourceStatuses) {
      if (entry.status === 'healthy') weights.set(sourceId, 1.0);
      else if (entry.status === 'degraded') weights.set(sourceId, 0.3);
      else weights.set(sourceId, 0);
    }
    return weights;
  }

  // ==================== 内部实现 ====================

  private initSourceStatus(sourceId: string): void {
    this.sourceStatuses.set(sourceId, {
      sourceId,
      consecutiveFailures: 0,
      status: 'healthy',
    });
  }

  /**
   * 安全执行数据源请求：成功后重置失败计数，失败后递增并自动降权。
   */
  private async safeFetch<T>(
    sourceId: string,
    fetcher: () => Promise<T | null>,
  ): Promise<T | null> {
    const entry = this.sourceStatuses.get(sourceId);
    if (!entry) return null;

    if (entry.status === 'disabled') {
      logger.warn(`数据源 ${sourceId} 已被禁用，跳过请求`);
      return null;
    }

    try {
      const result = await fetcher();

      if (result !== null) {
        // 请求成功，重置失败计数。
        entry.consecutiveFailures = 0;
        entry.status = 'healthy';
        entry.lastSuccessAt = new Date();
        return result;
      }

      // 返回 null 不算网络故障，可能是数据不可用。
      return null;
    } catch (error) {
      entry.consecutiveFailures += 1;
      entry.lastError = error instanceof Error ? error.message : String(error);

      if (entry.consecutiveFailures >= FAILURE_THRESHOLD) {
        entry.status = 'degraded';
        logger.warn(`数据源 ${sourceId} 连续失败 ${entry.consecutiveFailures} 次，已降权`);
      }

      if (entry.consecutiveFailures >= FAILURE_THRESHOLD + 2) {
        entry.status = 'disabled';
        logger.error(`数据源 ${sourceId} 连续失败 ${entry.consecutiveFailures} 次，已禁用`);
      }

      logError(logger, `数据源 ${sourceId} 请求失败`, error);
      return null;
    }
  }

  /**
   * 调用 Open-Meteo API 获取某经纬度当天的最高温预报（daily max）。
   * 用于残差修正的 forecastTemp（周边站同一天的最高温预报）。
   */
  private async fetchOpenMeteoDailyMax(
    lat: number,
    lon: number,
  ): Promise<number | null> {
    const response = await axios.get<{
      daily?: {
        time?: string[];
        temperature_2m_max?: (number | null)[];
      };
    }>('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude: lat,
        longitude: lon,
        daily: 'temperature_2m_max',
        timezone: 'UTC',
        forecast_days: 1,
      },
      timeout: 10_000,
    });

    const data = response.data?.daily;
    if (!data?.temperature_2m_max?.length) return null;

    // 取当天（第一个元素）的最高温预报。
    const maxTemp = data.temperature_2m_max[0];
    if (maxTemp == null || !Number.isFinite(maxTemp)) return null;
    return maxTemp;
  }

  /**
   * 调用 Open-Meteo API 获取某模型的预报。
   *
   * Open-Meteo 免费且支持多种全球模型：
   *   ecmwf：ECMWF IFS HRES（高分辨率）
   *   gfs_global：GFS（全球预报系统）
   *   icon：ICON（德国气象局）
   *
   * API 文档：https://open-meteo.com/en/docs
   */
  private async fetchOpenMeteoModel(
    model: string,
    lat: number,
    lon: number,
    forecastDays: number,
    targetStation: string,
  ): Promise<StandardizedForecast | null> {
    const params: Record<string, string | number> = {
      latitude: lat,
      longitude: lon,
      hourly: 'temperature_2m',
      timezone: 'UTC',
      forecast_days: Math.max(forecastDays, 1),
    };

    // 只有 ECMWF 需要指定 model 参数，其他模型是 Open-Meteo 默认的。
    // Open-Meteo 在 2026 年更新了模型名：ecmwf → ecmwf_ifs, icon → icon_global
    if (model === 'ecmwf') {
      params.models = 'ecmwf_ifs';
    } else if (model === 'icon') {
      params.models = 'icon_global';
    } else if (model === 'gfs_global') {
      params.models = 'gfs_global';
    }

    const response = await axios.get<{
      hourly?: {
        time?: string[];
        temperature_2m?: number[];
      };
    }>('https://api.open-meteo.com/v1/forecast', {
      params,
      timeout: 10_000,
    });

    const data = response.data?.hourly;
    if (!data?.time?.length || !data?.temperature_2m?.length) {
      return null;
    }

    // 取预报的最高温度。
    // Open-Meteo 返回的是逐小时数据，取最大值作为日最高温预报。
    const times = data.time ?? [];
    const values = data.temperature_2m ?? [];
    const temps = values.filter((t) => t !== undefined && t !== null);
    if (temps.length === 0) return null;

    const maxTemp = Math.max(...temps);
    const issuanceTime = new Date(times[0] ?? Date.now());

    // 逐日最高温预报（℃）：按 UTC 自然日分组 hourly 数据。
    // 索引 0 = 预报发布当天，1 = 明天，依此类推。DataHub 按水平段
    // （d0/d1/d2/d3）取对应日期的温度，避免"5 天窗口最大温"污染所有水平段。
    const dailyMaxes = new Map<string, number>();
    for (let i = 0; i < times.length && i < values.length; i++) {
      const t = values[i];
      if (t === undefined || t === null) continue;
      const day = times[i]?.slice(0, 10);
      if (!day) continue;
      dailyMaxes.set(day, Math.max(dailyMaxes.get(day) ?? -Infinity, t));
    }
    const dailyMaxC = [...dailyMaxes.values()].map((v) => Math.round(v * 100) / 100);

    return {
      sourceId: `open-meteo-${model}`,
      issuanceTime,
      forecastHour: forecastDays * 24,
      targetStation,
      forecastedMaxTemp: maxTemp,
      // Open-Meteo 免费版不提供集合成员，所以这里 ensembleMembers 为空。
      metadata: {
        model,
        lat,
        lon,
        forecastDays,
        hourlyCount: temps.length,
        dailyMaxC,
      },
    };
  }

  /**
   * 调用 Open-Meteo ensemble API 获取集合预报逐日最高温。
   *
   * 响应结构（hourly）：
   *   time: ["2026-08-15T00:00", ...]
   *   temperature_2m: [.. ensemble mean ..]
   *   temperature_2m_member01: [..成员1..]
   *   temperature_2m_memberNN: [...]
   * 每个成员按 UTC 自然日分组，取当天最高温作为该成员的日最高温预报。
   */
  private async fetchEnsembleModel(
    lat: number,
    lon: number,
    forecastDays: number,
    targetStation: string,
    model: string,
    maxMembers: number,
  ): Promise<EnsembleDailyForecast | null> {
    const response = await axios.get<{
      hourly?: Record<string, unknown>;
    }>('https://ensemble-api.open-meteo.com/v1/ensemble', {
      params: {
        latitude: lat,
        longitude: lon,
        hourly: 'temperature_2m',
        models: model,
        timezone: 'UTC',
        forecast_days: Math.max(forecastDays, 1),
      },
      timeout: 15_000,
    });

    const hourly = response.data?.hourly;
    if (!hourly || !Array.isArray(hourly.time) || hourly.time.length === 0) {
      return null;
    }
    const times = hourly.time as string[];

    // 收集所有成员 key（temperature_2m_memberNN）。
    const memberKeys = Object.keys(hourly).filter(
      (k) => /^temperature_2m_member\d+$/.test(k),
    );
    if (memberKeys.length === 0) {
      logger.warn('ensemble 响应无成员数据', { model });
      return null;
    }

    // 按 UTC 自然日建立日期 → 列下标映射。
    const dayIndex = new Map<string, number>();
    const dayDates: string[] = [];
    for (const t of times) {
      const day = t.slice(0, 10);
      if (!dayIndex.has(day)) {
        dayIndex.set(day, dayDates.length);
        dayDates.push(day);
      }
    }

    // 抽取成员数组（含均匀抽样降载）。
    const memberArrays = memberKeys.map(
      (k) => (hourly[k] as (number | null)[] | undefined) ?? [],
    );
    const selected =
      maxMembers > 0 && memberArrays.length > maxMembers
        ? pickEvery(memberArrays, maxMembers)
        : memberArrays;

    // 每个成员 → 每天最高温。
    const dayTemps: number[][] = [];
    for (const arr of selected) {
      const perDay = new Array<number | null>(dayDates.length).fill(null);
      for (let i = 0; i < times.length && i < arr.length; i++) {
        const v = arr[i];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        const d = dayIndex.get(times[i]!.slice(0, 10));
        if (d === undefined) continue;
        perDay[d] = Math.max(perDay[d] ?? -Infinity, v);
      }
      // 过滤掉完全无数据的成员。
      if (perDay.some((v) => v !== null)) {
        dayTemps.push(perDay.map((v) => (v === null ? NaN : Math.round(v * 100) / 100)));
      }
    }

    if (dayTemps.length === 0) return null;

    // ensemble mean：所有成员每天的平均。
    const mean = dayDates.map((_, d) => {
      const vals: number[] = dayTemps.map((m) => m[d]).filter(isFiniteNumber);
      return vals.length > 0
        ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100
        : NaN;
    });

    return {
      sourceId: 'open-meteo-ensemble',
      model,
      targetStation,
      issuanceTime: new Date(times[0] ?? Date.now()),
      memberCount: dayTemps.length,
      dayTemps,
      mean,
    };
  }

  /**
   * 调用 avwx.rest 获取 METAR 实时温度观测。
   *
   * METAR 是机场气象报，每 30 分钟更新一次，能反映真实温度。
   * 这是空间修正的重要数据来源，因为 METAR 是"真实观测"而非模型预报。
   *
   * 注意：avwx.rest 免费版有限额，正式部署时可能需要注册 API key。
   */
  private async fetchMetarObservation(
    stationId: string,
    lat: number,
    lon: number,
  ): Promise<StandardizedForecast | null> {
    // 先用 avwx.rest 免费接口
    try {
      const response = await axios.get<{
        Temperature?: number | string;
        altimeter?: { value?: number };
        meta?: { timestamp?: string };
      }>(`https://avwx.rest/api/metar/${stationId}`, {
        params: { options: 'info' },
        timeout: 8_000,
      });

      const temp = Number(response.data?.Temperature);
      if (Number.isFinite(temp)) {
        return {
          sourceId: 'metar',
          issuanceTime: new Date(),
          forecastHour: 0,
          targetStation: stationId,
          forecastedMaxTemp: temp,
          metadata: {
            lat,
            lon,
            source: 'avwx-rest',
          },
        };
      }
    } catch {
      // avwx.rest 失败，备用方案
    }

    // 备用：用 checkwx.com 免费接口
    try {
      const response = await axios.get<{
        data?: Array<{
          temperature?: { celsius?: { value?: number } };
        }>;
      }>(`https://api.checkwx.com/metar/${stationId}/decoded`, {
        headers: { 'X-API-Key': '' },
        timeout: 8_000,
      });

      const temp = response.data?.data?.[0]?.temperature?.celsius?.value;
      if (temp !== undefined && Number.isFinite(temp)) {
        return {
          sourceId: 'metar',
          issuanceTime: new Date(),
          forecastHour: 0,
          targetStation: stationId,
          forecastedMaxTemp: temp,
          metadata: {
            lat,
            lon,
            source: 'checkwx',
          },
        };
      }
    } catch {
      // 两个接口都失败，返回 null
    }

    return null;
  }
}

/**
 * 从数组里均匀抽取 `count` 个元素（成员降载用）。
 * 例如 51 个成员抽 10 个：按下标 0,5,10,... 均匀取，既保留分布宽度又降请求体积。
 */
function pickEvery<T>(arr: T[], count: number): T[] {
  if (count <= 0 || arr.length <= count) return arr;
  const out: T[] = [];
  const step = (arr.length - 1) / (count - 1);
  for (let i = 0; i < count; i++) {
    out.push(arr[Math.round(i * step)]!);
  }
  return out;
}

/** 类型守卫：判断一个未知值是否为有限数字（配合 noUncheckedIndexedAccess 过滤数组）。 */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}