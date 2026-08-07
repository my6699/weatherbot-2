// 这个文件负责所有"气象站距离和权重"计算，是 SpatialCorrectionEngine 的基础工具。
// 核心逻辑：距离越近的站点，温度数据越有参考价值。
// 包含两个权重方法：反距离加权 (IDW) 和高斯核，可配置选用。

import type { GeoPoint } from '../common/types.js';

const EARTH_RADIUS_KM = 6371;

export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function haversineDistanceKm(pointA: GeoPoint, pointB: GeoPoint): number {
  // Haversine 公式计算球面上两点距离，单位：公里。
  // 输入：两个经纬度坐标（单位：度）。
  // 输出：两点间大圆距离，单位：公里。
  //
  // 为什么不用更简单的近似算法？
  // 上海周边站点虽然纬度相近，但经度跨度超过 1 度时平面近似误差会被放大。
  // Haversine 在 50km 半径内精度足够，且计算量对 Node.js 来说可以忽略不计。

  const dLat = toRadians(pointB.lat - pointA.lat);
  const dLon = toRadians(pointB.lon - pointA.lon);

  const sinHalfLat = Math.sin(dLat / 2);
  const sinHalfLon = Math.sin(dLon / 2);

  const a =
    sinHalfLat * sinHalfLat +
    Math.cos(toRadians(pointA.lat)) *
      Math.cos(toRadians(pointB.lat)) *
      sinHalfLon * sinHalfLon;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_KM * c;
}

export function idwWeight(
  distanceKm: number,
  power: number,
  maxRadiusKm: number,
): number {
  // 反距离加权 (IDW, Inverse Distance Weighting)。
  // 距离越近权重越大，距离越远权重越小。
  //
  // 公式：weight = 1 / distance^power
  //
  // 参数：
  //   power = 2 时（默认），距离 10km 的站点权重是 20km 的 4 倍。
  //   power = 1 时，权重衰减更慢，适合站点稀疏时使用。
  //
  // 原理：
  // 气象学里，温度的空间相关性在 30-50km 内比较强。
  // 距离超过 maxRadiusKm 的站点权重为 0，不参与计算。

  if (distanceKm <= 0) {
    // 距离为 0 表示就是主站点本身，权重最高。
    return 1;
  }

  if (distanceKm > maxRadiusKm) {
    return 0;
  }

  return 1 / Math.pow(distanceKm, power);
}

export function gaussianWeight(
  distanceKm: number,
  bandwidthKm: number,
  maxRadiusKm: number,
): number {
  // 高斯核权重。
  //
  // 公式：weight = exp(-0.5 * (distance / bandwidth)^2)
  //
  // 相比 IDW：高斯核在近距离内权重衰减更平滑，更符合温度场空间相关性的物理特性。
  // 适用场景：站点密度较高、距离分布均匀时。
  //
  // 参数：
  //   bandwidthKm：带宽，控制衰减速度。
  //   带宽越大，权重衰减越慢，远端站点的影响更大。
  //
  // 上海建议 bandwidth = 18km：
  //   - 10km 处权重约 0.87
  //   - 20km 处权重约 0.54
  //   - 30km 处权重约 0.25
  //   - 50km 处权重约 0.02

  if (distanceKm <= 0) {
    return 1;
  }

  if (distanceKm > maxRadiusKm) {
    return 0;
  }

  const ratio = distanceKm / bandwidthKm;
  return Math.exp(-0.5 * ratio * ratio);
}

export interface WeightedStation {
  stationId: string;
  lat: number;
  lon: number;
  // 该站点到主站点的距离，单位公里。
  distanceKm: number;
  // 计算得到的原始权重（未归一化），范围 0 到 1。
  rawWeight: number;
  // 归一化后的权重，所有站点的 normalizedWeight 之和为 1。
  // 归一化是为了让最终修正结果具有明确的比例意义。
  normalizedWeight: number;
  // 该站点的温度观测值，单位摄氏度。
  temp: number;
}

export interface NearbyStationConfig {
  stationId: string;
  name: string;
  lat: number;
  lon: number;
  distanceKm?: number;
}

export function computeWeightedStations(
  settlementStation: GeoPoint,
  nearbyStations: NearbyStationConfig[],
  maxRadiusKm: number,
  method: 'idw' | 'gaussian',
  idwPower: number,
  gaussianBandwidthKm: number,
): WeightedStation[] {
  // 1. 计算每个周边站点到主站点的距离。
  const withDistance = nearbyStations.map((station) => {
    const distanceKm = haversineDistanceKm(settlementStation, {
      lat: station.lat,
      lon: station.lon,
    });
    return { ...station, distanceKm };
  });

  // 2. 过滤掉超过最大半径的站点（距离太远的站点没有参考价值）。
  const withinRadius = withDistance.filter(
    (s) => s.distanceKm <= maxRadiusKm,
  );

  if (withinRadius.length === 0) {
    // 没有可用的周边站点，返回空数组。
    // 调用方（SpatialCorrectionEngine）会处理这种情况，例如只做偏差修正不做空间修正。
    return [];
  }

  // 3. 计算权重。
  const weighted = withinRadius.map((station) => {
    let rawWeight: number;

    if (method === 'idw') {
      rawWeight = idwWeight(station.distanceKm, idwPower, maxRadiusKm);
    } else {
      rawWeight = gaussianWeight(station.distanceKm, gaussianBandwidthKm, maxRadiusKm);
    }

    return {
      stationId: station.stationId,
      lat: station.lat,
      lon: station.lon,
      distanceKm: station.distanceKm,
      rawWeight,
      normalizedWeight: 0, // 暂填，下一步归一化。
      temp: 0, // 暂填，由调用方填入实际温度。
    };
  });

  // 4. 归一化权重（所有站点的 rawWeight 之和为分母）。
  const totalRawWeight = weighted.reduce((sum, w) => sum + w.rawWeight, 0);

  if (totalRawWeight <= 0) {
    return [];
  }

  for (const w of weighted) {
    w.normalizedWeight = w.rawWeight / totalRawWeight;
  }

  return weighted;
}

export function spatialWeightedAverage(
  weightedStations: WeightedStation[],
): number | null {
  // 用归一化权重计算加权平均温度。
  // 这是空间修正的核心：周边站点温度 × 归一化权重，求和得到"空间修正温度"。
  //
  // 如果站点列表为空，返回 null，表示无法做空间修正。

  if (weightedStations.length === 0) {
    return null;
  }

  const weightedSum = weightedStations.reduce(
    (sum, s) => sum + s.normalizedWeight * s.temp,
    0,
  );

  return weightedSum;
}

export function spatialCorrectionConfidence(
  weightedStations: WeightedStation[],
  minNearbyStations: number,
): number {
  // 计算空间修正的置信度，范围 0 到 1。
  //
  // 因素：
  // 1. 站点数量：越多越好，达到 minNearbyStations 后增益递减。
  // 2. 距离分布：站点越靠近主站点，置信度越高。
  //
  // 用于 TradingDecisionEngine 的多因子打分，以及 ExitStrategy 判断是否应该提前离场。
  //
  // 如果站点少于 minNearbyStations，返回 0.3 以下，表示置信度低，策略应更保守。

  if (weightedStations.length === 0) {
    return 0;
  }

  // 数量得分：达到 minNearbyStations 后开始饱和。
  const countRatio = weightedStations.length / minNearbyStations;
  const countScore = Math.min(countRatio, 1) * 0.5;

  // 距离得分：站点越近越好。
  // 平均距离 10km 以内得 0.5 分，超过 50km 接近 0 分。
  const avgDistance =
    weightedStations.reduce((sum, s) => sum + s.distanceKm, 0) /
    weightedStations.length;
  const distanceScore = Math.max(0, 1 - avgDistance / 50) * 0.5;

  return Math.min(countScore + distanceScore, 1);
}