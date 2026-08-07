// 这个文件负责 Redis 连接和缓存键管理。
//
// 为什么用 Redis？
// 1. DataHubService 定时拉取气象数据，处理后写入 Redis。
// 2. 每个城市的策略进程（StrategyInstance）只从 Redis 读数据，不直接拉天气 API。
// 3. 这样多个城市策略可以共享同一个 DataHub 的输出，减少 API 调用次数。
// 4. Redis 自带 TTL 过期，数据过期可以自动触发告警。
//
// 缓存键结构：
//   weather:<city>:<horizon>          → 概率分布数据
//   weather:<city>:<horizon>:ts       → 数据更新时间戳
//   weather:<city>:spatial:latest     → 最近一次空间修正结果
//   weather:<city>:bias:stats         → 偏差统计数据
//   weather:health:sources            → 各数据源健康状态

import { Redis as Ioredis } from 'ioredis';
import type { CityId, ForecastHorizon, RedisWeatherPayload } from '../common/types.js';
import { createModuleLogger } from '../common/logger.js';

const logger = createModuleLogger('RedisConfig');

const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';
const DEFAULT_KEY_PREFIX = 'weather';

export interface RedisConfig {
  url: string;
  keyPrefix: string;
  dataMaxAgeSeconds: number;
}

export function getRedisConfig(): RedisConfig {
  return {
    url: process.env.REDIS_URL ?? DEFAULT_REDIS_URL,
    keyPrefix: process.env.REDIS_KEY_PREFIX ?? DEFAULT_KEY_PREFIX,
    dataMaxAgeSeconds: Number(process.env.DATA_MAX_AGE_SECONDS) || 3600,
  };
}

export function createRedisClient(config?: RedisConfig): Ioredis {
  const cfg = config ?? getRedisConfig();

  const client = new Ioredis(cfg.url, {
    // 最多重试 10 次连接，避免无限重试导致进程挂起。
    maxRetriesPerRequest: 10,
    retryStrategy(times: number): number | null {
      if (times > 10) {
        logger.error('Redis 重试次数超过上限，放弃连接');
        return null;
      }
      // 指数退避：1s, 2s, 4s, 8s...
      return Math.min(times * 1000, 10_000);
    },
    // 连接超时，单位毫秒。
    connectTimeout: 10_000,
    lazyConnect: true,
  });

  client.on('error', (err: Error) => {
    logger.error('Redis 连接错误', { message: err.message });
  });

  client.on('connect', () => {
    logger.info('Redis 已连接');
  });

  client.on('close', () => {
    logger.warn('Redis 连接关闭');
  });

  return client;
}

export function buildWeatherKey(
  prefix: string,
  city: CityId,
  horizon: ForecastHorizon,
): string {
  // 生成存储概率分布的 Redis key。
  // 例如：weather:shanghai:d3
  return `${prefix}:${city}:${horizon}`;
}

export function buildTimestampKey(
  prefix: string,
  city: CityId,
  horizon: ForecastHorizon,
): string {
  // 生成存储数据时间戳的 Redis key。
  // 策略进程读取数据时，先检查这个时间戳，判断数据是否过期。
  // 例如：weather:shanghai:d3:ts
  return `${prefix}:${city}:${horizon}:ts`;
}

export function buildSpatialKey(prefix: string, city: CityId): string {
  // 存储最近一次空间修正结果。
  // 例如：weather:shanghai:spatial:latest
  return `${prefix}:${city}:spatial:latest`;
}

export function buildBiasStatsKey(prefix: string, city: CityId): string {
  // 存储偏差统计数据。
  // 例如：weather:shanghai:bias:stats
  return `${prefix}:${city}:bias:stats`;
}

export function buildSourcesHealthKey(prefix: string): string {
  // 存储所有数据源的健康状态汇总。
  // 例如：weather:health:sources
  return `${prefix}:health:sources`;
}

export async function writeWeatherData(
  redis: Ioredis,
  prefix: string,
  city: CityId,
  horizon: ForecastHorizon,
  payload: RedisWeatherPayload,
  dataMaxAgeSeconds: number,
): Promise<void> {
  // DataHubService 调用这个函数，把概率分布写入 Redis。
  // 同时写入时间戳，方便策略端检查数据新鲜度。

  const dataKey = buildWeatherKey(prefix, city, horizon);
  const tsKey = buildTimestampKey(prefix, city, horizon);
  const serialized = JSON.stringify(payload);

  // 使用 pipeline 保证两个写入要么都成功，要么都失败。
  const pipeline = redis.pipeline();
  pipeline.set(dataKey, serialized, 'EX', dataMaxAgeSeconds);
  pipeline.set(tsKey, Date.now().toString(), 'EX', dataMaxAgeSeconds);
  await pipeline.exec();
}

export async function readWeatherData(
  redis: Ioredis,
  prefix: string,
  city: CityId,
  horizon: ForecastHorizon,
): Promise<RedisWeatherPayload | null> {
  // 策略进程调用这个函数，从 Redis 读取概率分布。
  // 如果数据不存在或已过期，返回 null。

  const dataKey = buildWeatherKey(prefix, city, horizon);
  const raw = await redis.get(dataKey);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as RedisWeatherPayload;
  } catch {
    logger.error(`反序列化 Redis 数据失败`, { key: dataKey });
    return null;
  }
}

export async function checkDataFreshness(
  redis: Ioredis,
  prefix: string,
  city: CityId,
  horizon: ForecastHorizon,
  maxAgeSeconds: number,
): Promise<boolean> {
  // 检查数据是否新鲜：读取时间戳，判断是否超过最大允许延迟。
  // 返回 true 表示数据新鲜，false 表示数据过期或不存在。
  //
  // 策略进程在每次决策前应该调用这个函数，确保不基于过期数据做交易。

  const tsKey = buildTimestampKey(prefix, city, horizon);
  const tsRaw = await redis.get(tsKey);

  if (!tsRaw) {
    return false;
  }

  const timestamp = Number(tsRaw);
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const ageSeconds = (Date.now() - timestamp) / 1000;
  return ageSeconds <= maxAgeSeconds;
}