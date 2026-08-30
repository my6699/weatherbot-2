import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import { z } from 'zod';
import type { CityId, TradingMode } from './types.js';
import { ALL_CITIES } from './types.js';
import { loadDisabledCitiesFromWhitelist } from '../whitelist/CityWhitelistManager.js';

// 这个文件负责读取配置。
// 量化系统里不要把参数写死在代码中，因为城市、风控、交易模式、数据源权重都需要经常调整。
// 这里采用两层配置：
// 1. .env：放运行环境、Redis、私钥、风控开关等敏感或部署相关配置。
// 2. config/*.json：放城市专属参数，例如 ZSPD 主站点、周边站点文件、桶范围、打分权重。

dotenv.config();

const tradingModeSchema = z.enum(['paper', 'live']);
const cityIdSchema = z.enum([
  'shanghai', 'nyc', 'chicago', 'miami', 'dallas',
  'seattle', 'atlanta', 'london', 'paris', 'munich',
  'ankara', 'seoul', 'tokyo', 'singapore', 'lucknow',
  'tel-aviv', 'toronto', 'sao-paulo', 'buenos-aires', 'wellington',
]);

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  TRADING_MODE: tradingModeSchema.default('paper'),
  DEFAULT_CITY: cityIdSchema.default('shanghai'),

  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  REDIS_KEY_PREFIX: z.string().default('weather'),
  DATA_MAX_AGE_SECONDS: z.coerce.number().positive().default(3600),

  DATAHUB_POLL_INTERVAL_SECONDS: z.coerce.number().positive().default(3600),
  DATA_SOURCE_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),

  // 集合预报（ensemble）接入参数：
  //   ENSEMBLE_ENABLED：true=DataHub 拉取集合成员并用 KDE 概率与高斯融合；false=沿用纯高斯。
  //   ENSEMBLE_MODEL：集合模型名，open-meteo ensemble API：ecmwf_ifs025（ECMWF 51 成员，
  //     python 公认最准）/ gfs025（GFS 31 成员）/ icon_seamless（ICON 40 成员）。
  //   ENSEMBLE_WEIGHT：融合权重（0-1），最终概率 = (1-w)×高斯 + w×集合KDE。
  //   ENSEMBLE_BIAS_CORRECT：true=对集合成员应用该城市 ecmwf 温度档偏差平移（与确定性源同口径）。
  //   ENSEMBLE_MAX_MEMBERS：实际使用成员数上限（0=全部）。请求体积大时用于抽样降载。
  ENSEMBLE_ENABLED: z
    .string()
    .default('false')
    .transform((value) => value.toLowerCase() === 'true'),
  ENSEMBLE_MODEL: z.string().default('ecmwf_ifs025'),
  ENSEMBLE_WEIGHT: z.coerce.number().min(0).max(1).default(0.5),
  ENSEMBLE_BIAS_CORRECT: z
    .string()
    .default('true')
    .transform((value) => value.toLowerCase() === 'true'),
  ENSEMBLE_MAX_MEMBERS: z.coerce.number().int().min(0).default(0),

  // DEB 偏差修正开关：true=对确定性预报源（ecmwf/gfs/icon）应用 DebCalibration 温度档偏差修正；
  // false=使用原始预报温度，不修正。偏差表来自旧项目 collector，基于少量样本（n=12），
  // 部分城市偏差极大（如 nyc +7.4°C），回测验证关闭后策略表现更稳定。
  DEB_BIAS_CORRECT: z
    .string()
    .default('false')
    .transform((value) => value.toLowerCase() === 'true'),

  POLYMARKET_CLOB_API_URL: z.string().url().default('https://clob.polymarket.com'),
  POLYMARKET_GAMMA_API_URL: z.string().url().default('https://gamma-api.polymarket.com'),
  POLYMARKET_PRIVATE_KEY: z.string().default(''),
  POLYMARKET_FUNDER_ADDRESS: z.string().default(''),
  POLYMARKET_SIGNATURE_TYPE: z.coerce.number().int().default(0),
  // 真实交易（CLOB 下单）参数：TRADING_MODE=live 时生效。
  // POLYMARKET_CHAIN_ID：137=Polygon 主网（默认），80002=Amoy 测试网。
  // POLYMARKET_MAKER_MODE：true=maker-first（post-only 限价单优先，失败市价回退，默认）。
  // POLYMARKET_ENTRY_ORDER_TYPE / POLYMARKET_EXIT_ORDER_TYPE：市价回退单类型 FAK/FOK。
  POLYMARKET_CHAIN_ID: z.coerce.number().int().default(137),
  POLYMARKET_MAKER_MODE: z
    .string()
    .default('true')
    .transform((value) => value.toLowerCase() === 'true'),
  POLYMARKET_ENTRY_ORDER_TYPE: z.enum(['FAK', 'FOK']).default('FAK'),
  POLYMARKET_EXIT_ORDER_TYPE: z.enum(['FAK', 'FOK']).default('FAK'),

  MAX_POSITION_USD: z.coerce.number().positive().default(20),
  MAX_CITY_EXPOSURE_USD: z.coerce.number().positive().default(80),
  // 凯利动态投注参数：
  //   BANKROLL_USD：paper 模式的虚拟资金池（live 用 CLOB 真实余额，此值无效）。
  //   KELLY_FRACTION：分数凯利系数（0-1，默认 1/4）。模型概率有误差，全凯利过度投注。
  BANKROLL_USD: z.coerce.number().positive().default(100),
  KELLY_FRACTION: z.coerce.number().positive().default(0.25),
  ENABLE_NO_TRADES: z
	    .string()
	    .default('false')
	    .transform((value) => value.toLowerCase() === 'true'),
	  // 黑名单城市：多个城市用逗号分隔，如 "tokyo,sao-paulo"。
	  // 被禁城市在策略和数据采集阶段都会被跳过。
	  DISABLED_CITIES: z.string().default(''),
	  HARD_EXIT_LOCAL_TIME: z.string().default('14:00'),

  LOG_LEVEL: z.string().default('info'),
  LOG_DIR: z.string().default('logs'),
});

const geoPointSchema = z.object({
  lat: z.number(),
  lon: z.number(),
});

const temperatureBucketSchema = z.object({
  label: z.string(),
  minTempC: z.number().nullable(),
  maxTempC: z.number().nullable(),
});

const scoringWeightsSchema = z.object({
  cheapTail: z.number().nonnegative(),
  modelShock: z.number().nonnegative(),
  orderFlow: z.number().nonnegative(),
  spatialSupport: z.number().nonnegative(),
  relativeValue: z.number().nonnegative(),
  probabilityGap: z.number().nonnegative(),
  dispersionPenalty: z.number().nonnegative(),
});

const cityConfigSchema = z.object({
  city: cityIdSchema,
  timezone: z.string(),
  settlementStation: z.object({
    stationId: z.string(),
    name: z.string(),
    lat: z.number(),
    lon: z.number(),
  }),
  nearbyStationsFile: z.string(),
  peakTimeLocal: z.object({
    earliest: z.string(),
    typical: z.string(),
    latest: z.string(),
  }),
  buckets: z.array(temperatureBucketSchema).min(1),
  spatialCorrection: z.object({
    method: z.enum(['idw', 'gaussian']),
    maxRadiusKm: z.number().positive(),
    minNearbyStations: z.number().int().positive(),
    idwPower: z.number().positive(),
    gaussianBandwidthKm: z.number().positive(),
  }),
  scoringWeights: scoringWeightsSchema,
  risk: z.object({
    maxPositionUsd: z.number().positive(),
    maxCityExposureUsd: z.number().positive(),
  }),
});

export type AppEnv = z.infer<typeof envSchema> & {
  TRADING_MODE: TradingMode;
  DEFAULT_CITY: CityId;
};

export type CityConfig = z.infer<typeof cityConfigSchema>;

export interface AppConfig {
  env: AppEnv;
  city: CityConfig;
  projectRoot: string;
}

export function loadEnv(): AppEnv {
  // safeParse 可以返回清晰的校验错误。
  // 如果 .env 写错，比如 MAX_POSITION_USD=abc，系统会在启动阶段直接报错，而不是带着错误参数运行。
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    throw new Error(`.env 配置校验失败：${parsed.error.message}`);
  }

  return parsed.data as AppEnv;
}

export function getProjectRoot(): string {
  // 默认从当前工作目录启动项目。
  // PM2 和 npm scripts 都会在 weather-bot 根目录运行，所以 process.cwd() 是最直接可靠的选择。
  return process.cwd();
}

export function loadCityConfig(city: CityId, projectRoot = getProjectRoot()): CityConfig {
  const configPath = path.join(projectRoot, 'config', `${city}.json`);

  if (!fs.existsSync(configPath)) {
    throw new Error(`找不到城市配置文件：${configPath}`);
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const json = JSON.parse(raw) as unknown;
  const parsed = cityConfigSchema.safeParse(json);

  if (!parsed.success) {
    throw new Error(`${city}.json 配置校验失败：${parsed.error.message}`);
  }

  return parsed.data;
}

export function loadAppConfig(city?: CityId): AppConfig {
  const env = loadEnv();
  const projectRoot = getProjectRoot();
  const selectedCity = city ?? env.DEFAULT_CITY;

  return {
    env,
    city: loadCityConfig(selectedCity, projectRoot),
    projectRoot,
  };
}

/**
 * 加载所有已配置城市的 CityConfig 列表。
 * 用于 DataHubService 在单次 runOnce 中循环采集所有城市。
 */
/**
 * 解析 DISABLED_CITIES 环境变量，返回被禁城市 ID 集合。
 */
export function parseDisabledCities(env: AppEnv): Set<CityId> {
  if (!env.DISABLED_CITIES) return new Set();
  return new Set(
    env.DISABLED_CITIES.split(',')
      .map((s) => s.trim() as CityId)
      .filter((s) => s.length > 0),
  );
}

/**
 * 获取生效的被禁城市集合：合并手动 DISABLED_CITIES + 自动黑白名单。
 * 手动禁用优先级更高（自动黑名单中的城市不会被手动排除）。
 */
export function getEffectiveDisabledCities(projectRoot = getProjectRoot()): Set<CityId> {
  const env = loadEnv();
  const manual = parseDisabledCities(env);
  const autoDisabled = loadDisabledCitiesFromWhitelist(projectRoot);
  const combined = new Set(manual);
  for (const city of autoDisabled) {
    combined.add(city);
  }
  return combined;
}

export function loadAllCityConfigs(projectRoot = getProjectRoot()): CityConfig[] {
  const disabled = getEffectiveDisabledCities(projectRoot);
  const configs: CityConfig[] = [];
  for (const city of ALL_CITIES) {
    if (disabled.has(city)) continue;
    try {
      configs.push(loadCityConfig(city, projectRoot));
    } catch {
      // 城市配置不存在时跳过（如还未生成 config/<city>.json 的城市）
      continue;
    }
  }
  return configs;
}

export function resolveConfigPath(projectRoot: string, relativePath: string): string {
  // JSON 配置里只写相对路径，例如 config/stations/zspd_nearby.json。
  // 这个函数负责转成绝对路径，避免不同启动目录导致读文件失败。
  return path.isAbsolute(relativePath) ? relativePath : path.join(projectRoot, relativePath);
}

export function requireLiveTradingSafety(env: AppEnv): void {
  // live 模式是实盘，必须检查关键字段。
  // paper 模式不做这些限制，方便本地和 VPS 先跑模拟盘。
  if (env.TRADING_MODE !== 'live') {
    return;
  }

  if (!env.POLYMARKET_PRIVATE_KEY) {
    throw new Error('live 模式必须配置 POLYMARKET_PRIVATE_KEY');
  }

  if (!env.POLYMARKET_FUNDER_ADDRESS) {
    throw new Error('live 模式必须配置 POLYMARKET_FUNDER_ADDRESS');
  }
}

export { cityConfigSchema, envSchema, geoPointSchema };
