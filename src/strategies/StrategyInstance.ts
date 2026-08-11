// 这个文件是 StrategyInstance，每个城市一个独立进程。
//
// 职责：
//   1. 从 Redis 读取 DataHubService 写好的概率分布（不直接拉天气 API）。
//   2. 检查数据新鲜度（超过 DATA_MAX_AGE_SECONDS 暂停开仓并告警）。
//   3. 用 TradingDecisionEngine 做多因子选桶决策。
//   4. paper trading：只记录决策日志，不真实下单。
//   5. live trading：调用下单模块执行（当前阶段预留）。
//   6. 监控持仓，用 ExitStrategy 判断 D0 是否该离场。
//
// 每个城市一个进程（由 PM2 管理），一个策略崩溃不影响其他城市。
// 错误隔离：本进程内部任何异常都被捕获，不影响 DataHub 和其他策略进程。

import type { Redis } from 'ioredis';
import type { AppConfig } from '../common/config-loader.js';
import { createModuleLogger, logError } from '../common/logger.js';
import {
  createRedisClient,
  readWeatherData,
  checkDataFreshness,
} from '../data/redis-config.js';
import { TradingDecisionEngine } from './TradingDecisionEngine.js';
import type { CandidateBucket } from './TradingDecisionEngine.js';
import { ExitStrategy } from './ExitStrategy.js';
import type { ExitCheckInput } from './ExitStrategy.js';
import { PolymarketClient } from '../utils/polymarket-client.js';
import { delayMs, calculateHorizon, formatISODate, getCityDate, hoursToResolution } from '../utils/time.js';
import { recordOpenTrade, recordCloseTrade } from '../utils/trade-recorder.js';
import type {
  ProbabilityDistribution,
  MarketSnapshot,
  OpenPosition,
  TradingDecision,
  ForecastHorizon,
  CityId,
} from '../common/types.js';

const logger = createModuleLogger('StrategyInstance');

// 策略进程的轮询间隔（毫秒）：10 分钟一次，适合持仓监控。
const STRATEGY_POLL_INTERVAL_MS = 600_000;

// 市场发现缓存 TTL：与轮询间隔一致，最多 10 分钟内看到新上架的 D-3/D-2 市场
// （"市场上架即买"）。避免每轮打 4 次 Polymarket API。
const MARKET_DISCOVERY_TTL_MS = 600_000;

// 入场小时窗（对齐旧项目 scan.ts：MIN_HOURS=2 / MAX_HOURS=80）。
// 市场上架约 h50-56（D-2 中段），D-3 若上架在 h72-80。
const MIN_ENTRY_HOURS = 2;
const MAX_ENTRY_HOURS = 80;

/** 真实市场发现结果：目标日期 + 对应水平段 + 距结算小时数。 */
interface TargetMarket {
  horizon: ForecastHorizon;
  targetDate: string;
  hoursLeft: number;
}

export class StrategyInstance {
  private readonly redis: Redis;
  private readonly decisionEngine: TradingDecisionEngine;
  private readonly exitStrategy: ExitStrategy;
  private readonly polymarket: PolymarketClient;
  private readonly config: AppConfig;
  private running = false;
  private positions: OpenPosition[] = [];
  private discoveryCache: { at: number; result: TargetMarket | null } | null = null;

  constructor(config: AppConfig) {
    this.config = config;
    this.redis = createRedisClient();
    this.decisionEngine = new TradingDecisionEngine(config.city);
    this.exitStrategy = new ExitStrategy(config.city, config.projectRoot);
    this.polymarket = new PolymarketClient();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    logger.info('StrategyInstance 启动', {
      city: this.config.city.city,
      tradingMode: this.config.env.TRADING_MODE,
      pollIntervalMs: STRATEGY_POLL_INTERVAL_MS,
    });

    try {
      await this.redis.connect();
    } catch (error) {
      logError(logger, 'Redis 连接失败，策略无法启动', error);
      this.running = false;
      return;
    }

    // 启动后立即跑一轮。
    await this.runLoopOnce();

    while (this.running) {
      try {
        await delayMs(STRATEGY_POLL_INTERVAL_MS);
        await this.runLoopOnce();
      } catch (error) {
        logError(logger, '策略轮询异常（已隔离，不影响其他进程）', error);
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
    logger.info('StrategyInstance 已停止', { city: this.config.city.city });
  }

  /**
   * 执行一轮完整的策略循环。
   */
  private async runLoopOnce(): Promise<void> {
    const city = this.config.city;
    const env = this.config.env;

    // 1. 发现真实目标市场（D-3 优先，其次 D-2），用市场日期精确算水平段。
    //    取代原硬编码 'd2'：D-3 市场上架即可入场（h72-80），没有则 D-2。
    const target = await this.resolveTargetHorizon();
    const horizon: ForecastHorizon = target?.horizon ?? 'd2';

    // 2. 读取 DataHub 写好的概率分布。
    const weatherData = await readWeatherData(
      this.redis,
      env.REDIS_KEY_PREFIX,
      city.city,
      horizon,
    );

    if (!weatherData) {
      logger.warn('Redis 中没有概率分布数据，跳过本轮', {
        city: city.city,
        horizon,
        targetDate: target?.targetDate ?? null,
      });
      return;
    }

    // 3. 检查数据新鲜度：过期数据不能用于开仓决策。
    const fresh = await checkDataFreshness(
      this.redis,
      env.REDIS_KEY_PREFIX,
      city.city,
      horizon,
      env.DATA_MAX_AGE_SECONDS,
    );

    if (!fresh) {
      logger.warn('天气数据已过期，暂停开仓（数据新鲜度保护）', {
        city: city.city,
        horizon,
        maxAgeSeconds: env.DATA_MAX_AGE_SECONDS,
      });
      return;
    }

    // 4. 监控现有持仓是否需要离场（不依赖是否发现新市场）。
    await this.monitorPositions(weatherData.probability);

    // 5. 做开仓决策：只有发现真实目标市场才尝试开仓。
    if (!target) {
      logger.warn('未来 4 天未发现可入场的 Polymarket 温度市场，本轮跳过开仓', {
        city: city.city,
      });
      return;
    }
    await this.makeEntryDecision(weatherData.probability, horizon);
  }

  /**
   * 发现当前可入场的真实 Polymarket 目标市场（参考旧项目 scan.ts）。
   *
   * 从 D-3 到 D-2 依次扫描（D-3 最早入场、价格更便宜）：
   *   1. 用城市日期构建 slug，查 Polymarket 真实事件（findEventBySlug）。
   *   2. 用 event.endDate 算距结算小时数，落在 [MIN_ENTRY_HOURS, MAX_ENTRY_HOURS]
   *      窗口内才算可入场（旧项目 MIN_HOURS=2 / MAX_HOURS=80）。
   *   3. 用 calculateHorizon(targetDate) 精确计算水平段（d3/d2）。
   * D-1/D-0 不在此窗口（用户方案：D3/D2 买入，D-1/D-0 已充分定价不入场）。
   * 结果缓存 MARKET_DISCOVERY_TTL_MS（10 分钟），避免每轮打 4 次 API。
   */
  private async resolveTargetHorizon(): Promise<TargetMarket | null> {
    const now = Date.now();
    if (this.discoveryCache && now - this.discoveryCache.at < MARKET_DISCOVERY_TTL_MS) {
      return this.discoveryCache.result;
    }

    const city = this.config.city;
    const tz = city.timezone;
    const cityDate = getCityDate(tz);

    for (const dayOffset of [3, 2]) {
      const target = new Date(cityDate);
      target.setDate(target.getDate() + dayOffset);
      const targetDate = formatISODate(target);
      const [y, m, day] = targetDate.split('-').map(Number);

      let event;
      try {
        event = await this.polymarket.findEventBySlug(city.city, y!, m!, day!);
      } catch (error) {
        logError(logger, `查找 ${city.city} ${targetDate} 市场事件失败`, error);
        continue;
      }
      if (!event) continue;

      const endDate = event.endDate ?? '';
      const hoursLeft = endDate ? hoursToResolution(endDate) : 0;
      const horizon = calculateHorizon(targetDate, tz);

      if (hoursLeft <= 0) {
        logger.info('目标市场已结算，跳过', { targetDate, hoursLeft });
        continue;
      }
      if (hoursLeft < MIN_ENTRY_HOURS || hoursLeft > MAX_ENTRY_HOURS) {
        logger.info('目标市场不在入场小时窗内，跳过', {
          targetDate,
          hoursLeft,
          window: `${MIN_ENTRY_HOURS}-${MAX_ENTRY_HOURS}h`,
        });
        continue;
      }

      const result: TargetMarket = { horizon, targetDate, hoursLeft };
      this.discoveryCache = { at: now, result };
      logger.info('发现目标市场（D-N 入场）', {
        city: city.city,
        targetDate,
        horizon,
        hoursLeft: Math.round(hoursLeft * 10) / 10,
      });
      return result;
    }

    // 未来 4 天都没有可入场的市场（未上架/已结算/不在窗口）。
    this.discoveryCache = { at: now, result: null };
    return null;
  }

  /**
   * 检查持仓，按 ExitStrategy 决定是否离场。
   */
  private async monitorPositions(distribution: ProbabilityDistribution): Promise<void> {
    if (this.positions.length === 0) {
      return;
    }

    for (const position of this.positions) {
      try {
        // 获取该仓位的当前市场快照。
        const market = await this.polymarket.fetchOrderBookImbalance(
          position.positionId, // 简化：paper 阶段用 positionId 占位
        );
        const snapshot: MarketSnapshot = {
          marketId: position.positionId,
          city: position.city,
          targetDate: '',
          bucket: position.bucket,
          yesPrice: position.entryPrice, // paper 阶段简化
          noPrice: 1 - position.entryPrice,
          volumeUsd: 0,
          orderBookImbalance: market,
          capturedAt: new Date(),
        };

        // 双桶区间持仓：构造两桶各自的当前 bid，供 ExitStrategy 判断"两桶 bid 之和 >= 0.85"。
        // paper 阶段没有逐桶实时行情，用"该桶入场价"占位（不会触发 0.85 退出）；
        // live 阶段应改为调用 PolymarketClient 分别拉取两个桶的实时 bestBid。
        const dualBuckets =
          position.buckets && position.buckets.length >= 2 ? position.buckets : null;
        const bucketBids: Array<{ bucketLabel: string; bid: number }> | undefined = dualBuckets
          ? dualBuckets.map((bucket) => ({
              bucketLabel: bucket.label,
              bid: position.entryPrice / dualBuckets.length,
            }))
          : undefined;

        const exitInput: ExitCheckInput = {
          city: position.city,
          timezone: this.config.city.timezone,
          position,
          currentMarket: snapshot,
          targetDate: position.targetDate ?? '',
          peakLocalTime: this.config.city.peakTimeLocal.typical,
        };
        if (bucketBids) {
          exitInput.bucketBids = bucketBids;
        }

        const exitSignal = this.exitStrategy.checkExit(exitInput);

        if (exitSignal) {
          logger.info('触发离场信号', {
            positionId: position.positionId,
            trigger: exitSignal.trigger,
            sellFraction: exitSignal.sellFraction,
            reason: exitSignal.reason,
          });

          // paper 模式：只记录离场日志，不真实下单。
          if (exitSignal.sellFraction >= 1) {
            // 全部平仓，从持仓列表移除。
            this.positions = this.positions.filter((p) => p.positionId !== position.positionId);
            logger.info('仓位已全部平仓（paper）', { positionId: position.positionId });

            // 持久化平仓记录，供每日报告统计。
            // paper 阶段用入场价作为离场价（退出策略触发时默认满盈离场）。
            const exitPrice = position.entryPrice;
            const exitPriceA = position.entryPrice / (position.buckets?.length ?? 1);
            const exitPriceB = position.buckets && position.buckets.length >= 2
              ? position.entryPrice / position.buckets.length
              : 0;
            recordCloseTrade(position.city, position.positionId, exitPrice, exitPriceA, exitPriceB);
          }
        } else {
          logger.info('继续持有', {
            positionId: position.positionId,
            bucket: position.bucket.label,
            buckets: position.buckets?.map((b) => b.label),
          });
        }
      } catch (error) {
        logError(logger, `监控仓位 ${position.positionId} 失败`, error);
      }
    }
  }

  /**
   * 开仓决策：把概率分布转成候选桶，交给 TradingDecisionEngine。
   *
   * 入场窗口门控（用户方案 2026-08-07：D3/D2 买入，D0 结算前平仓）：
   *   只在 d3/d2 开仓。D-1/D-0 市场已充分定价（回测：D-1 放开价格
   *   edge 全被吃掉），且临近结算风险上升，禁止新开仓；
   *   已有持仓的离场仍由 ExitStrategy 负责（峰值前 0.85 目标 + 峰值到点市价平）。
   */
  private async makeEntryDecision(
    distribution: ProbabilityDistribution,
    horizon: ForecastHorizon,
  ): Promise<void> {
    if (horizon !== 'd3' && horizon !== 'd2') {
      logger.info('不在入场窗口（仅 d3/d2 开仓），跳过开仓', { horizon });
      return;
    }

    const candidates = this.buildCandidates(distribution);

    if (candidates.length === 0) {
      logger.info('没有候选桶', { city: distribution.city });
      return;
    }

    const decision = this.decisionEngine.decide({
      city: distribution.city,
      horizon,
      distribution,
      candidates,
      tradingMode: this.config.env.TRADING_MODE,
    });

    if (!decision) {
      logger.info('决策引擎未选出交易', { city: distribution.city });
      return;
    }

    // paper 模式：只记录模拟交易。
    const isDualBucket = decision.buckets.length >= 2;
    logger.info('【PAPER】模拟开仓', {
      city: decision.city,
      horizon: decision.horizon,
      bucket: isDualBucket
        ? decision.buckets.map((b) => b.label).join('+')
        : decision.bucket.label,
      side: decision.side,
      entryPrice: decision.entryPrice,
      sizeUsd: decision.sizeUsd,
      reason: decision.reason,
    });

    // 记录为持仓，供后续离场监控。
    const position: OpenPosition = {
      positionId: `paper-${decision.buckets.map((b) => b.label).join('+')}-${Date.now()}`,
      city: decision.city,
      side: decision.side,
      bucket: decision.bucket,
      buckets: decision.buckets,
      entryPrice: decision.entryPrice,
      sizeUsd: decision.sizeUsd,
      openedAt: new Date(),
      mode: 'paper',
      targetDate: '',
    };
    this.positions.push(position);

    // 持久化交易记录，供每日报告统计。
    // 双桶区间：entryPriceA = 价格较低的桶，entryPriceB = 价格较高的桶。
    const prices = decision.buckets.map((b, i) => {
      // 估算每个桶的入场价（按 buckets 长度均分 entryPrice，paper 阶段简化）。
      const avgPrice = decision.entryPrice / decision.buckets.length;
      return { label: b.label, price: avgPrice };
    });
    const entryPriceA = prices[0]?.price ?? 0;
    const entryPriceB = prices[1]?.price ?? 0;
    recordOpenTrade(
      decision.city,
      decision.horizon,
      decision.buckets,
      decision.entryPrice,
      decision.sizeUsd,
      decision.side,
      entryPriceA,
      entryPriceB,
      decision.reason,
      position.positionId,
    );
  }

  /**
   * 把概率分布转换成候选桶列表。
   * 只选择模型概率 > 0.15 的桶作为候选（避免概率过低的桶）。
   */
  private buildCandidates(distribution: ProbabilityDistribution): CandidateBucket[] {
    return distribution.buckets
      .filter((b) => b.probability > 0.15)
      .map((b) => ({
        bucket: b.bucket,
        modelProbability: b.probability,
        yesPrice: b.yesPrice ?? 0.5,
        noPrice: b.noPrice ?? 0.5,
        volumeUsd: 0, // paper 阶段无真实成交量，后续接入市场数据填充
        orderBookImbalance: 0, // paper 阶段无真实订单簿，后续填充
        spatialConfidence: this.avgSpatialConfidence(distribution),
      }));
  }

  private avgSpatialConfidence(distribution: ProbabilityDistribution): number {
    const corrections = distribution.sourceContributions;
    if (corrections.length === 0) return 0.5;
    // 简化：用数据源健康度作为空间修正置信度代理。
    const healthy = corrections.filter((c) => c.status === 'healthy').length;
    return healthy / corrections.length;
  }
}

/**
 * 命令行入口：`tsx src/strategies/StrategyInstance.ts`
 * 支持 `--city=shanghai` 参数选择城市。
 */
async function main(): Promise<void> {
  const cityArg = process.argv.find((arg) => arg.startsWith('--city='));
  const city = (cityArg?.split('=')[1] as CityId | undefined) ?? 'shanghai';

  const { loadAppConfig } = await import('../common/config-loader.js');
  const config = loadAppConfig(city);

  const instance = new StrategyInstance(config);

  // 优雅关闭：收到 Ctrl+C 或 PM2 stop 时释放资源。
  process.on('SIGINT', async () => {
    await instance.stop();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await instance.stop();
    process.exit(0);
  });

  await instance.start();
}

// 直接运行时启动（tsx 直接执行本文件）。
main().catch((error) => {
  logError(logger, 'StrategyInstance 启动失败', error);
  process.exit(1);
});