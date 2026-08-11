// 这个文件是 MultiCityStrategy，合并所有城市的策略为一个进程。
//
// 相比"每城市一个进程"的旧架构（20 个进程在低配服务器上内存过载），
// 这里用一个进程串行处理所有城市：
//   - 共享 1 个 Redis 连接和 1 个 PolymarketClient。
//   - 每个城市独立保存 positions / discoveryCache / 决策引擎 / 离场引擎。
//   - runLoopOnce() 循环所有城市，逐个执行完整策略循环。
//
// 错误隔离：单个城市异常被捕获，不影响其他城市和整个进程。

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
import type { GammaMarket } from '../utils/polymarket-client.js';
import { delayMs, calculateHorizon, formatISODate, getCityDate, hoursToResolution } from '../utils/time.js';
import { recordOpenTrade, recordCloseTrade, recordSettleTrade, recordSwitchTrade, readTrades } from '../utils/trade-recorder.js';
import { parseMarketQuestion, bucketProbability } from '../utils/market-buckets.js';
import {
  isLiveEnabled,
  clobBuyYesUsd,
  clobSellYesShares,
  clobTryMakerBuy,
  clobTryMakerSell,
  getYesBidDepth,
  getClobClient,
  liveStatus,
} from '../execution/polymarket-live-client.js';
import type {
  ProbabilityDistribution,
  MarketSnapshot,
  OpenPosition,
  ForecastHorizon,
  TemperatureBucket,
  TradingDecision,
} from '../common/types.js';

const logger = createModuleLogger('MultiCityStrategy');

// 策略进程的轮询间隔（毫秒）：10 分钟一次，适合持仓监控。
const STRATEGY_POLL_INTERVAL_MS = 600_000;

// 市场发现缓存 TTL：与轮询间隔一致，最多 10 分钟内看到新上架的 D-3/D-2 市场。
const MARKET_DISCOVERY_TTL_MS = 600_000;

// ==================== D1 换仓（2026-08-09，回测验证正优化） ====================
//
// 规则：持仓监控时，若该持仓目标日期的最新预测分布中"旧桶对模型区间概率"
//   ≤ SWITCH_THRESHOLD，且决策引擎选出了不同的新桶对 → paper 切换持仓到新桶，
//   换仓后继续持有（退出逻辑不变）。与"提前离场"不同：资金始终在场内。
//
// 回测结论（simulate-all-cities.ts SWITCH_D1）：阈值 0.30 最优，
//   总盈亏 +$0.406 → +$2.383（ROI +3.9% → +22.7%），命中率 30.4% → 34.8%。
//
// 默认开启（paper 盘模拟验证），可用 SWITCH_ENABLED=0 关闭、SWITCH_THRESHOLD 调阈值。
const SWITCH_ENABLED = (process.env.SWITCH_ENABLED ?? '1') === '1';
const SWITCH_THRESHOLD = Number(process.env.SWITCH_THRESHOLD ?? '0.30');

// ==================== 双桶入场 edge 直过滤（2026-08-10，网格回测最优 0.05） ====================
//
// 规则：双桶决策后，若"模型区间概率 pPair − 买入成本" < MIN_PAIR_EDGE → 不开仓。
// 回测（simulate-all-cities.ts MIN_PAIR_EDGE 网格，生产口径：换仓 0.30 + 资金约束）：
//   0 → 8.7% ROI / +$0.918；0.05 → 11.9% / +$0.909（利润几乎不变，资金效率提升）。
//   0.07~0.12 是坑（6.6%/-2.0%），0.20 激进但样本太少，故取保守甜点 0.05。
// 可用 MIN_PAIR_EDGE=0 关闭（维持旧行为：只有 MAX_ENTRY_COST 成本上限）。
const MIN_PAIR_EDGE = Number(process.env.MIN_PAIR_EDGE ?? '0.05');

// 入场小时窗（对齐旧项目 scan.ts：MIN_HOURS=2 / MAX_HOURS=80）。
const MIN_ENTRY_HOURS = 2;
const MAX_ENTRY_HOURS = 80;

/** 真实市场发现结果：目标日期 + 对应水平段 + 距结算小时数 + 该事件下的温度桶行情。 */
interface TargetMarket {
  horizon: ForecastHorizon;
  targetDate: string;
  hoursLeft: number;
  markets: GammaMarket[];
}

/** 从 GammaMarket question 解析出的市场桶价格行（原生单位 label + 精确 °C 边界）。 */
interface MarketPriceRow {
  bucket: TemperatureBucket; // 市场原生桶（label 如 "74-75F"、"25C"）
  yesPrice: number;
  noPrice: number;
  bid: number;
  volumeUsd: number;
  isLow: boolean; // "or below" 开放低桶
  isHigh: boolean; // "or higher" 开放高桶
  yesTokenId?: string; // live 下单用：该桶 YES outcome 的 CLOB token id
}

/** 每个城市独立保存的运行时状态。 */
interface CityRuntime {
  config: AppConfig;
  decisionEngine: TradingDecisionEngine;
  exitStrategy: ExitStrategy;
  positions: OpenPosition[];
  discoveryCache: { at: number; result: TargetMarket | null } | null;
}

export class MultiCityStrategy {
  private readonly redis: Redis;
  private readonly polymarket: PolymarketClient;
  private readonly cities: CityRuntime[];
  private running = false;

  constructor(cityConfigs: AppConfig[]) {
    this.redis = createRedisClient();
    this.polymarket = new PolymarketClient();
    this.cities = cityConfigs.map((config) => ({
      config,
      decisionEngine: new TradingDecisionEngine(config.city),
      exitStrategy: new ExitStrategy(config.city, config.projectRoot),
      positions: [],
      discoveryCache: null,
    }));
    if (this.cities.length === 0) {
      throw new Error('未配置任何城市，MultiCityStrategy 无法启动');
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const env = this.cities[0]?.config.env;
    logger.info('MultiCityStrategy 启动', {
      cities: this.cities.map((r) => r.config.city.city),
      tradingMode: env?.TRADING_MODE,
      pollIntervalMs: STRATEGY_POLL_INTERVAL_MS,
    });
    // 真实交易开关诊断：paper 时提醒需要哪些配置才能切 live；live 且缺密钥时告警。
    const live = liveStatus();
    logger.info('真实交易开关状态', {
      enabled: live.enabled,
      reasons: live.reasons,
      hint: 'TRADING_MODE=live + POLYMARKET_PRIVATE_KEY + POLYMARKET_FUNDER_ADDRESS 三者齐备才会真实下单',
    });

    try {
      await this.redis.connect();
    } catch (error) {
      logError(logger, 'Redis 连接失败，策略无法启动', error);
      this.running = false;
      return;
    }

    // 启动后立即跑一轮。
    // 先从持久化 trades 恢复未结算持仓，避免进程重启后持仓失联（不被监控/结算）。
    for (const runtime of this.cities) {
      try {
        this.restorePositions(runtime);
      } catch (error) {
        logError(logger, `恢复城市 ${runtime.config.city.city} 持仓失败`, error);
      }
    }
    await this.runLoopOnce();

    while (this.running) {
      try {
        await delayMs(STRATEGY_POLL_INTERVAL_MS);
        await this.runLoopOnce();
      } catch (error) {
        logError(logger, '策略轮询异常（已隔离，不影响进程）', error);
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
    logger.info('MultiCityStrategy 已停止');
  }

  /**
   * 执行一轮完整的策略循环：循环所有城市。
   */
  private async runLoopOnce(): Promise<void> {
    for (const runtime of this.cities) {
      try {
        await this.runForCity(runtime);
      } catch (error) {
        logError(logger, `策略处理城市 ${runtime.config.city.city} 失败`, error);
      }
    }
  }

  /**
   * 处理单个城市的一轮策略循环。
   */
  private async runForCity(runtime: CityRuntime): Promise<void> {
    const city = runtime.config.city;
    const env = runtime.config.env;

    // 1. 发现真实目标市场（D-3 优先，其次 D-2）。
    const target = await this.resolveTargetHorizon(runtime);
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

    // 4. 监控现有持仓是否需要离场。
    await this.monitorPositions(runtime, weatherData.probability);

    // 5. 做开仓决策：只有发现真实目标市场才尝试开仓。
    if (!target) {
      logger.warn('未来 4 天未发现可入场的 Polymarket 温度市场，本轮跳过开仓', {
        city: city.city,
      });
      return;
    }
    await this.makeEntryDecision(runtime, weatherData.probability, horizon, target.markets, target.targetDate);
  }

  /**
   * 发现当前可入场的真实 Polymarket 目标市场（参考旧项目 scan.ts）。
   */
  private async resolveTargetHorizon(runtime: CityRuntime): Promise<TargetMarket | null> {
    const now = Date.now();
    if (runtime.discoveryCache && now - runtime.discoveryCache.at < MARKET_DISCOVERY_TTL_MS) {
      return runtime.discoveryCache.result;
    }

    const city = runtime.config.city;
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

      const result: TargetMarket = {
        horizon,
        targetDate,
        hoursLeft,
        markets: event.markets ?? [],
      };
      runtime.discoveryCache = { at: now, result };
      logger.info('发现目标市场（D-N 入场）', {
        city: city.city,
        targetDate,
        horizon,
        hoursLeft: Math.round(hoursLeft * 10) / 10,
        nMarkets: result.markets.length,
      });
      return result;
    }

    runtime.discoveryCache = { at: now, result: null };
    return null;
  }

  /**
   * 从持久化 trades 恢复未结算持仓（open 状态）到内存 positions。
   * 进程重启后内存清空，不恢复会导致持仓不被监控、也不被结算。
   */
  private restorePositions(runtime: CityRuntime): void {
    const trades = readTrades(runtime.config.city.city);
    let restored = 0;
    for (const t of trades) {
      if (t.status !== 'open') continue;
      if (!t.targetDate) {
        logger.warn('持仓缺少 targetDate，无法监控/换仓/结算，跳过恢复', {
          city: t.city,
          tradeId: t.id,
        });
        continue;
      }
      // 换仓过的持仓按 switchKeys（新桶）恢复，否则按开仓桶恢复。
      const bucketLabels = t.switched && t.switchKeys?.length ? t.switchKeys : t.buckets;
      // 用持久化的精确 °C 边界还原桶对象（市场原生桶与 config 网格解耦）。
      // 2026-08-11 原生单位改造前的旧记录无 bucketBounds → 不恢复（已接受旧持仓失联），
      // 避免旧 °C 网格桶被误换仓/误结算产生假盈亏。
      const bounds =
        t.switched && t.switchBucketBounds?.length
          ? t.switchBucketBounds
          : t.bucketBounds;
      if (!bounds || bounds.length !== bucketLabels.length) {
        logger.warn('旧格式持仓（无精确桶边界）不再恢复监控，已接受失联', {
          city: t.city,
          tradeId: t.id,
          buckets: bucketLabels,
        });
        continue;
      }
      const buckets = bucketLabels.map((label, i) => ({
        label,
        minTempC: bounds[i]?.minTempC ?? null,
        maxTempC: bounds[i]?.maxTempC ?? null,
      }));
      runtime.positions.push({
        positionId: t.id,
        city: t.city,
        side: t.side,
        bucket: buckets[0]!,
        targetDate: t.targetDate,
        buckets,
        entryPrice: t.switched && t.switchBuy !== undefined ? t.switchBuy : t.entryPrice,
        sizeUsd: t.sizeUsd,
        openedAt: new Date(t.openedAt),
        mode: t.mode ?? 'paper',
        switched: !!t.switched, // 恢复已换仓持仓：防重标记继承，避免重启后再换一次
      });
      restored += 1;
      if (t.switched) {
        logger.info('持仓为换仓后状态，已按新桶恢复', {
          city: t.city,
          tradeId: t.id,
          switchKeys: t.switchKeys,
        });
      }
    }
    if (restored > 0) {
      logger.info('已从 trades 恢复未结算持仓', {
        city: runtime.config.city.city,
        restored,
      });
    }
  }

  /**
   * 检查持仓：先看是否已结算（标记结算），再按 ExitStrategy 决定是否离场。
   * 行情来源为 gamma-api 实时价（bestBid），不再是开仓价占位。
   */
  private async monitorPositions(
    runtime: CityRuntime,
    distribution: ProbabilityDistribution,
  ): Promise<void> {
    if (runtime.positions.length === 0) {
      return;
    }

    const city = runtime.config.city;
    const settledIds: string[] = [];
    for (const position of runtime.positions) {
      try {
        const [y, m, d] = position.targetDate.split('-').map(Number);
        const event = await this.polymarket.findEventBySlug(position.city, y!, m!, d!);
        if (!event) continue;
        const rows = this.parseMarketPrices(event.markets ?? []);
        const buckets =
          position.buckets && position.buckets.length >= 2
            ? position.buckets
            : [position.bucket];
        const bucketBids: Array<{ bucketLabel: string; bid: number }> = buckets.map(
          (bucket) => {
            const row = this.marketPriceFor(bucket, rows);
            return { bucketLabel: bucket.label, bid: row?.bid ?? row?.yesPrice ?? 0.5 };
          },
        );

        // 结算检测：结算时间已过且 bid 收敛到 0/1 才判定命中，未收敛不误判。
        const resolved = this.settleIfResolved(position, bucketBids);
        if (resolved) {
          settledIds.push(position.positionId);
          continue;
        }

        // 换仓检查（D1 漂移调仓）：旧桶概率跌破阈值且引擎选出新桶 → paper 切换持仓。
        // 换仓成功本轮跳过离场判断（调仓本身就是主动操作，不再平仓）。
        const switched = await this.trySwitchPosition(runtime, position, event.markets ?? []);
        if (switched) {
          continue;
        }

        const sumBid = bucketBids.reduce((acc, b) => acc + b.bid, 0);
        const snapshot: MarketSnapshot = {
          marketId: position.positionId,
          city: position.city,
          targetDate: position.targetDate,
          bucket: position.bucket,
          yesPrice: sumBid,
          noPrice: 1 - sumBid,
          volumeUsd: 0,
          orderBookImbalance: 0,
          capturedAt: new Date(),
        };

        const exitInput: ExitCheckInput = {
          city: position.city,
          timezone: city.timezone,
          position,
          currentMarket: snapshot,
          targetDate: position.targetDate,
          peakLocalTime: city.peakTimeLocal.typical,
          bucketBids,
        };

        const exitSignal = runtime.exitStrategy.checkExit(exitInput);

        if (exitSignal) {
          logger.info('触发离场信号', {
            positionId: position.positionId,
            trigger: exitSignal.trigger,
            sellFraction: exitSignal.sellFraction,
            sumBid: Math.round(sumBid * 100) / 100,
            reason: exitSignal.reason,
          });

          if (exitSignal.sellFraction >= 1) {
            // live：真实卖出持仓（maker-first，失败市价回退），卖出成功后从内存移除。
            if (position.mode === 'live') {
              const closed = await this.liveClosePosition(runtime, position, event.markets ?? []);
              if (!closed) {
                logger.warn('【LIVE】真实平仓失败，本轮不更新内存持仓（下轮重试）', {
                  positionId: position.positionId,
                });
                continue;
              }
            }
            runtime.positions = runtime.positions.filter(
              (p) => p.positionId !== position.positionId,
            );
            logger.info(`仓位已全部平仓（${position.mode}）`, { positionId: position.positionId });

            // 离场价用实时 bid 之和（比开仓价占位更真实）。
            const exitPrice = sumBid;
            const exitPriceA = bucketBids[0]?.bid ?? 0;
            const exitPriceB = bucketBids[1]?.bid ?? 0;
            recordCloseTrade(
              position.city,
              position.positionId,
              exitPrice,
              exitPriceA,
              exitPriceB,
            );
          }
        } else {
          logger.info('继续持有', {
            positionId: position.positionId,
            bucket: position.bucket.label,
            buckets: position.buckets?.map((b) => b.label),
            sumBid: Math.round(sumBid * 100) / 100,
          });
        }
      } catch (error) {
        logError(logger, `监控仓位 ${position.positionId} 失败`, error);
      }
    }

    if (settledIds.length > 0) {
      runtime.positions = runtime.positions.filter((p) => !settledIds.includes(p.positionId));
    }
  }

  /**
   * 市场已结算则标记交易并返回 true。
   * 判定条件：目标日期 12:00 UTC 已过 6 小时（等价格收敛）+ 持仓桶 bid 收敛到 >=0.9（命中）或 <=0.1（未命中）。
   */
  private settleIfResolved(
    position: OpenPosition,
    bucketBids: Array<{ bucketLabel: string; bid: number }>,
  ): boolean {
    const settleMs = new Date(`${position.targetDate}T12:00:00Z`).getTime();
    if (Date.now() < settleMs + 6 * 3600 * 1000) return false;
    if (bucketBids.length === 0) return false;

    const hitA = bucketBids[0]!.bid >= 0.9;
    const missA = bucketBids[0]!.bid <= 0.1;
    if (bucketBids.length === 1) {
      if (!hitA && !missA) return false;
      recordSettleTrade(position.city, position.positionId, hitA ? 1 : 0);
    } else {
      const hitB = bucketBids[1]!.bid >= 0.9;
      const missB = bucketBids[1]!.bid <= 0.1;
      if ((!hitA && !missA) || (!hitB && !missB)) return false;
      recordSettleTrade(position.city, position.positionId, hitA ? 1 : 0, hitB ? 1 : 0);
    }

    logger.info('持仓已结算', {
      positionId: position.positionId,
      city: position.city,
      mode: position.mode,
      buckets: position.buckets?.map((b) => b.label) ?? [position.bucket.label],
      bucketBids: bucketBids.map((b) => b.bid),
      targetDate: position.targetDate,
    });
    return true;
  }

  /**
   * 开仓决策：把概率分布转成候选桶（填入市场真实行情），交给 TradingDecisionEngine。
   */
  private async makeEntryDecision(
    runtime: CityRuntime,
    distribution: ProbabilityDistribution,
    horizon: ForecastHorizon,
    markets: GammaMarket[],
    targetDate: string,
  ): Promise<void> {
    if (horizon !== 'd3' && horizon !== 'd2') {
      logger.info('不在入场窗口（仅 d3/d2 开仓），跳过开仓', { horizon });
      return;
    }

    // 防重复开仓：该城市该目标日期已有未结算持仓（内存 + 持久化 trades）则跳过。
    // 否则每 10 分钟轮询 + 每次进程重启都会对同一市场重复开仓。
    const hasOpenPosition = runtime.positions.some((p) => p.targetDate === targetDate);
    const hasOpenTrade = readTrades(distribution.city).some(
      (t) => t.targetDate === targetDate && t.status === 'open',
    );
    if (hasOpenPosition || hasOpenTrade) {
      logger.info('该目标日期已有持仓，跳过重复开仓', {
        city: distribution.city,
        targetDate,
        hasOpenPosition,
        hasOpenTrade,
      });
      return;
    }

    const candidates = this.buildCandidates(distribution, markets);

    if (candidates.length === 0) {
      logger.info('没有候选桶', { city: distribution.city });
      return;
    }

    const decision = runtime.decisionEngine.decide({
      city: distribution.city,
      horizon,
      distribution,
      candidates,
      tradingMode: runtime.config.env.TRADING_MODE,
    });

    if (!decision) {
      logger.info('决策引擎未选出交易', { city: distribution.city });
      return;
    }

    // MIN_PAIR_EDGE 直过滤：双桶"模型区间概率 pPair − 买入成本"不足的不开仓
    // （模型自己都不信的高成本"贵单"不碰，网格回测最优 0.05）。
    if (decision.buckets.length >= 2 && MIN_PAIR_EDGE > 0) {
      const pPair = decision.buckets.reduce((sum, b) => {
        const c = candidates.find((x) => x.bucket.label === b.label);
        return sum + (c?.modelProbability ?? 0);
      }, 0);
      const pairEdge = pPair - decision.entryPrice;
      if (pairEdge < MIN_PAIR_EDGE) {
        logger.info('【EDGE】双桶区间概率 − 成本不足，跳过开仓', {
          city: decision.city,
          buckets: decision.buckets.map((b) => b.label).join('+'),
          pPair: Math.round(pPair * 1000) / 1000,
          entryPrice: decision.entryPrice,
          pairEdge: Math.round(pairEdge * 1000) / 1000,
          minPairEdge: MIN_PAIR_EDGE,
        });
        return;
      }
    }

    const isDualBucket = decision.buckets.length >= 2;

    // ==================== live 真实开仓 ====================
    if (runtime.config.env.TRADING_MODE === 'live') {
      await this.liveOpenPosition(runtime, decision, markets, targetDate);
      return;
    }

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
      targetDate,
    };
    runtime.positions.push(position);

    const prices = decision.buckets.map(() => decision.entryPrice / decision.buckets.length);
    const entryPriceA = prices[0] ?? 0;
    const entryPriceB = prices[1] ?? 0;
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
      targetDate,
    );
  }

  /**
   * live 真实开仓：对决策选出的每个桶做 maker-first 买入（post-only 限价单挂在
   * best bid 等成交，超时未成交回退市价单），全部成交后才记录持仓。
   * 任一桶下单失败则整体放弃开仓（资金安全优先，不半仓进场）。
   */
  private async liveOpenPosition(
    runtime: CityRuntime,
    decision: TradingDecision,
    markets: GammaMarket[],
    targetDate: string,
  ): Promise<void> {
    const env = runtime.config.env;
    const rows = this.parseMarketPrices(markets);
    const sizePerBucket = decision.sizeUsd / decision.buckets.length;
    const tokenIds: string[] = [];
    const asks: number[] = [];

    // 先解析每个桶的 token id + 对手价（best bid 挂单，best ask 兜底市价）。
    for (const bucket of decision.buckets) {
      const row = this.marketPriceFor(bucket, rows);
      const tokenId = row?.yesTokenId;
      if (!tokenId) {
        logger.error('【LIVE】开仓失败：桶缺少 YES token id（无法下单）', {
          city: decision.city,
          bucket: bucket.label,
          yesPrice: row?.yesPrice,
        });
        return;
      }
      tokenIds.push(tokenId);
      asks.push(row!.yesPrice);
    }

    // 每个桶独立成交，记录实际成交价（maker 成交价 / 市价回退价）。
    const fillPrices: number[] = [];
    const usedMaker: boolean[] = [];
    for (let i = 0; i < tokenIds.length; i++) {
      const tokenId = tokenIds[i]!;
      const ask = asks[i]!;
      const bid = await this.clobBidFor(tokenId);
      try {
        if (bid != null) {
          const maker = await clobTryMakerBuy(tokenId, sizePerBucket, bid);
          if (maker.filled && maker.fillPrice != null) {
            fillPrices.push(maker.fillPrice);
            usedMaker.push(true);
            logger.info('【LIVE】maker 买单成交', {
              city: decision.city,
              bucket: decision.buckets[i]!.label,
              usd: sizePerBucket,
              fillPrice: maker.fillPrice,
            });
            continue;
          }
          logger.warn('【LIVE】maker 买单未成交，回退市价', {
            city: decision.city,
            bucket: decision.buckets[i]!.label,
            bid,
            ask,
          });
        }
        await clobBuyYesUsd(tokenId, sizePerBucket);
        fillPrices.push(ask);
        usedMaker.push(false);
        logger.info('【LIVE】市价买单成交', {
          city: decision.city,
          bucket: decision.buckets[i]!.label,
          usd: sizePerBucket,
          ask,
        });
      } catch (error) {
        logError(logger, `【LIVE】开仓下单失败（桶 ${decision.buckets[i]!.label}），整体放弃开仓`, error);
        return;
      }
    }

    // 全部成交 → 记录持仓（成本基准 = 各桶实际成交价之和）。
    const entryPrice = fillPrices.reduce((s, p) => s + p, 0);
    const position: OpenPosition = {
      positionId: `live-${decision.buckets.map((b) => b.label).join('+')}-${Date.now()}`,
      city: decision.city,
      side: decision.side,
      bucket: decision.bucket,
      buckets: decision.buckets,
      entryPrice,
      sizeUsd: decision.sizeUsd,
      openedAt: new Date(),
      mode: 'live',
      targetDate,
    };
    runtime.positions.push(position);
    const entryPriceA = fillPrices[0] ?? 0;
    const entryPriceB = fillPrices[1] ?? 0;
    recordOpenTrade(
      decision.city,
      decision.horizon,
      decision.buckets,
      entryPrice,
      decision.sizeUsd,
      decision.side,
      entryPriceA,
      entryPriceB,
      `${decision.reason}（live 实际成交价 ${fillPrices.map((p) => p.toFixed(3)).join('/')}，${usedMaker.every(Boolean) ? '全部 maker 成交' : '含市价回退'}）`,
      position.positionId,
      targetDate,
      'live',
    );
    logger.info('【LIVE】真实开仓完成', {
      city: decision.city,
      positionId: position.positionId,
      buckets: decision.buckets.map((b) => b.label).join('+'),
      entryPrice: Math.round(entryPrice * 1000) / 1000,
      sizeUsd: decision.sizeUsd,
      fillPrices: fillPrices.map((p) => Math.round(p * 1000) / 1000),
    });
  }

  /** live：读 CLOB 订单簿取 YES 侧 best bid（maker 挂单价）。读不到返回 null 走市价。 */
  private async clobBidFor(tokenId: string): Promise<number | null> {
    try {
      const client = await getClobClient();
      const book = (await client.getOrderBook(tokenId)) as {
        bids?: unknown[];
        asks?: unknown[];
      };
      const bids = Array.isArray(book?.bids) ? book.bids : [];
      if (bids.length === 0) return null;
      const first = bids[0];
      if (Array.isArray(first)) return Number(first[0]);
      return Number((first as { price?: unknown }).price);
    } catch (error) {
      logError(logger, '读取 CLOB 订单簿 best bid 失败，改用市价', error);
      return null;
    }
  }

  /**
   * live 真实平仓：对持仓每个桶卖出全部 YES 股数（maker-first：post-only 限价单
   * 挂在 best ask 等成交，超时回退市价卖）。任一桶卖出失败返回 false（不半仓离场，
   * 由调用方下轮重试）。
   *
   * 股数 = 该桶名义金额 / 该桶实际成交价（开仓时按 sizeUsd/buckets 均分）。
   */
  private async liveClosePosition(
    runtime: CityRuntime,
    position: OpenPosition,
    markets: GammaMarket[],
  ): Promise<boolean> {
    const rows = this.parseMarketPrices(markets);
    const buckets =
      position.buckets && position.buckets.length >= 2
        ? position.buckets
        : [position.bucket];
    const sizePerBucket = position.sizeUsd / buckets.length;

    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i]!;
      const row = this.marketPriceFor(bucket, rows);
      const tokenId = row?.yesTokenId;
      if (!tokenId) {
        logger.error('【LIVE】平仓失败：桶缺少 YES token id', {
          positionId: position.positionId,
          city: position.city,
          bucket: bucket.label,
        });
        return false;
      }
      const fillPrice = this.positionBucketPrice(position, i);
      const shares = sizePerBucket / Math.max(0.001, fillPrice);
      const ask = row?.yesPrice ?? 0;
      try {
        const maker = await clobTryMakerSell(tokenId, shares, ask);
        if (maker.filled && maker.fillPrice != null) {
          logger.info('【LIVE】maker 卖单成交', {
            positionId: position.positionId,
            city: position.city,
            bucket: bucket.label,
            shares: Math.round(shares * 100) / 100,
            fillPrice: maker.fillPrice,
          });
          continue;
        }
        logger.warn('【LIVE】maker 卖单未成交，回退市价', {
          positionId: position.positionId,
          city: position.city,
          bucket: bucket.label,
          ask,
        });
        await clobSellYesShares(tokenId, shares);
        logger.info('【LIVE】市价卖单成交', {
          positionId: position.positionId,
          city: position.city,
          bucket: bucket.label,
          shares: Math.round(shares * 100) / 100,
          ask,
        });
      } catch (error) {
        logError(logger, `【LIVE】平仓卖出失败（桶 ${bucket.label}）`, error);
        return false;
      }
    }
    return true;
  }

  /** 取持仓第 i 个桶的实际成本价（开仓记录 entryPriceA/B，换仓后为 switchBuy 均分）。 */
  private positionBucketPrice(position: OpenPosition, index: number): number {
    const total = position.entryPrice;
    if (total <= 0) return 0.5;
    const n = position.buckets?.length ?? 1;
    if (n <= 1) return total;
    // 双桶：按各桶占比推实际成本（entryPriceA/B 记录于 trades，这里按均分近似）。
    return total / n;
  }

  /**
   * 把市场原生桶转成候选桶列表（2026-08-11 起不依赖 config 摄氏网格）。
   * 候选桶直接来自 parseMarketPrices 的市场行（原生单位 label + 精确 °C 边界），
   * 模型概率用正态 CDF(anchor, dispersion) 在桶边界上重算：
   *   - °F 区间桶 74-75°F → 边界 [72.5,74.5]°F 转 [22.5,23.6]°C，CDF 差即概率
   *   - °C 单值桶 25°C → 边界 [24.5,25.5]°C
   * °F→°C 是线性变换，CDF 数学等价于原生单位直接算，无需取整。
   * 排除开放桶（<=x / >=x）：模型对尾部概率系统性高估（回测验证），
   * 会把选桶劫持到"长尾赌注"（如上海 <=30 模型 87% 但市场仅 1%）。
   */
  private buildCandidates(
    distribution: ProbabilityDistribution,
    markets: GammaMarket[],
  ): CandidateBucket[] {
    const rows = this.parseMarketPrices(markets);
    const anchor = distribution.correctedAnchorTempC;
    const sigma = distribution.dispersionC;
    const candidates: CandidateBucket[] = [];
    for (const r of rows) {
      if (r.isLow || r.isHigh) continue; // 仅保留闭合桶
      const p = bucketProbability(r.bucket, anchor, sigma);
      if (!(p > 0.15)) continue;
      candidates.push({
        bucket: r.bucket,
        modelProbability: p,
        yesPrice: r.yesPrice,
        noPrice: r.noPrice,
        volumeUsd: r.volumeUsd,
        orderBookImbalance: 0,
        spatialConfidence: this.avgSpatialConfidence(distribution),
      });
    }
    return candidates;
  }

  /**
   * 从 GammaMarket question 解析市场桶价格行（2026-08-11 起不换算单位）。
   * 直接用市场原生单位解析：°C 城市单值桶 "be 25°C" → label "25C"；°F 城市区间桶
   * "between 74-75°F" → label "74-75F"；开放桶 "…or below/or higher" → "<=x" / ">=x"。
   * 桶的精确 °C 边界由 parseMarketQuestion 统一计算（±0.5 刻度，°F 区间桶
   * 边界 [lo-0.5, hi+0.5]，°C 单值桶 [v-0.5, v+0.5]），概率/匹配都用边界而非取整。
   */
  private parseMarketPrices(markets: GammaMarket[]): MarketPriceRow[] {
    const rows: MarketPriceRow[] = [];
    for (const m of markets) {
      const q = m.question ?? '';
      const parsed = parseMarketQuestion(q);
      if (!parsed) continue;
      const yesPrice = Number(m.bestAsk) || this.parseOutcomePrice(m.outcomePrices, 0);
      if (!(yesPrice > 0 && yesPrice < 1)) continue;
      // live 下单需要 YES token id（clobTokenIds JSON 数组，[0] 为 YES outcome）。
      const yesTokenId = this.parseYesTokenId(m.clobTokenIds);
      const row: MarketPriceRow = {
        bucket: parsed.bucket,
        yesPrice,
        noPrice: Math.min(0.999, Math.max(0.001, 1 - yesPrice)),
        bid: Number(m.bestBid) || 0,
        volumeUsd: Number(m.volume) || 0,
        isLow: parsed.isLow,
        isHigh: parsed.isHigh,
      };
      if (yesTokenId) row.yesTokenId = yesTokenId;
      rows.push(row);
    }
    return rows;
  }

  /** 解析 outcomePrices JSON（"[\"0.305\", \"0.695\"]"）取第 index 个价格。 */
  private parseOutcomePrice(outcomePrices: unknown, index: number): number {
    try {
      const arr = JSON.parse(outcomePrices as string) as number[];
      return Number(arr[index]);
    } catch {
      return 0;
    }
  }

  /** 解析 clobTokenIds JSON（"[\"0x...\", \"0x...\"]"）取 YES outcome 的 token id。 */
  private parseYesTokenId(raw?: string): string | undefined {
    if (!raw) return undefined;
    try {
      const ids = JSON.parse(raw) as string[];
      return ids[0];
    } catch {
      return undefined;
    }
  }

  /**
   * 给一个桶匹配对应市场桶的价格行（按精确 °C 边界匹配）：
   *  - 开放低桶（minTempC=null）→ 市场 "or below" 桶
   *  - 开放高桶（maxTempC=null）→ 市场 "or higher" 桶
   *  - 闭合桶 → 边界相同（±0.01°C）的市场桶。候选/持仓桶都直接来自市场行，
   *    边界是解析出来的原生精确值（°F 区间桶 [lo-0.5,hi+0.5]、°C 单值桶 [v-0.5,v+0.5]），
   *    相邻桶边界正好相接，能精确回找。
   */
  private marketPriceFor(
    bucket: TemperatureBucket,
    rows: MarketPriceRow[],
  ): MarketPriceRow | null {
    if (bucket.minTempC === null) {
      return rows.find((r) => r.isLow) ?? null;
    }
    if (bucket.maxTempC === null) {
      return rows.find((r) => r.isHigh) ?? null;
    }
    for (const r of rows) {
      if (r.isLow || r.isHigh) continue;
      if (r.bucket.minTempC === null || r.bucket.maxTempC === null) continue;
      if (
        Math.abs(r.bucket.minTempC - bucket.minTempC) < 0.01 &&
        Math.abs(r.bucket.maxTempC - bucket.maxTempC) < 0.01
      ) {
        return r;
      }
    }
    return null;
  }

  private avgSpatialConfidence(distribution: ProbabilityDistribution): number {
    const corrections = distribution.sourceContributions;
    if (corrections.length === 0) return 0.5;
    const healthy = corrections.filter((c) => c.status === 'healthy').length;
    return healthy / corrections.length;
  }

  /**
   * D1 换仓判定与执行（paper）：持仓目标日期对应的最新预测分布中，
   * 旧桶对模型区间概率 ≤ SWITCH_THRESHOLD，且决策引擎选出不同新桶对 → 切换持仓。
   *
   * 换仓与"提前离场"的本质区别：资金始终在场内，只把仓位从"市场已崩盘的旧桶"
   * 切到"最新预测的新桶"。回测验证：阈值 0.30 下总盈亏 +125%（simulate-all-cities SWITCH_D1）。
   *
   * 返回 true 表示本轮已完成换仓（调用方跳过离场判断）。
   */
  private async trySwitchPosition(
    runtime: CityRuntime,
    position: OpenPosition,
    markets: GammaMarket[],
  ): Promise<boolean> {
    if (!SWITCH_ENABLED) return false;
    // 防重：每笔只换一次（与回测 SWITCH_D1 口径一致），避免 10 分钟轮询反复换仓来回摩擦。
    if (position.switched) return false;

    const city = runtime.config.city;
    const env = runtime.config.env;
    const targetDate = position.targetDate;
    if (!targetDate) return false;

    // 目标日期相对城市今天（城市时区）的水平段：d1/d2/d3。
    const cityDate = formatISODate(getCityDate(city.timezone));
    const dayDiff = Math.round(
      (new Date(`${targetDate}T00:00:00Z`).getTime() - new Date(`${cityDate}T00:00:00Z`).getTime()) /
        86400000,
    );
    if (dayDiff < 1 || dayDiff > 3) return false; // D0 不换仓（价格已收敛），>D3 无市场

    const horizon = `d${dayDiff}` as ForecastHorizon;
    const payload = await readWeatherData(this.redis, runtime.config.env.REDIS_KEY_PREFIX, city.city, horizon);
    if (!payload) return false;

    const dist = payload.probability;
    const oldBuckets =
      position.buckets && position.buckets.length >= 2 ? position.buckets : [position.bucket];
    const oldKeys = oldBuckets.map((b) => b.label);
    // 旧桶对模型区间概率：直接在桶边界上用正态 CDF 重算（与候选桶口径一致）。
    // 原生桶 label 与 distribution.buckets 的 config 网格 label 对不上，不能再用 label 匹配。
    const oldPSum = oldBuckets.reduce(
      (s, b) => s + bucketProbability(b, dist.correctedAnchorTempC, dist.dispersionC),
      0,
    );
    if (oldPSum > SWITCH_THRESHOLD) return false;

    // 用最新分布 + 当前行情重建候选，决策引擎选新桶对。
    const candidates = this.buildCandidates(dist, markets);
    if (candidates.length === 0) return false;
    const decision = runtime.decisionEngine.decide({
      city: city.city,
      horizon,
      distribution: dist,
      candidates,
      tradingMode: runtime.config.env.TRADING_MODE,
    });
    if (!decision) return false;
    const newKeys = decision.buckets.map((b) => b.label);
    const same =
      newKeys.length === oldKeys.length && newKeys.every((k, i) => k === oldKeys[i]);
    if (same) return false;

    // 换仓参考价（当前 bestAsk 之和）。paper 用价格参考，live 用真实成交价。
    // 桶对象直接用旧桶/新桶（候选桶都来自市场行，边界精确匹配回找）。
    const rows = this.parseMarketPrices(markets);
    const sell = oldBuckets.reduce(
      (s, b) => s + (this.marketPriceFor(b, rows)?.yesPrice ?? 0),
      0,
    );
    const buy = decision.buckets.reduce(
      (s, b) => s + (this.marketPriceFor(b, rows)?.yesPrice ?? 0),
      0,
    );

    // live 换仓：先真实卖出旧桶全部股数（回收资金），再真实买入新桶，
    // 全部成交后才更新内存持仓 + 持久化换仓记录。任何一步失败 → 不换仓（下轮重试）。
    if (runtime.config.env.TRADING_MODE === 'live') {
      const ok = await this.liveSwitchPosition(position, oldKeys, decision, markets);
      if (!ok) {
        logger.warn('【换仓】live 真实卖旧买新失败，本轮保持旧持仓', {
          positionId: position.positionId,
          city: position.city,
          old: oldKeys.join('+'),
          next: newKeys.join('+'),
        });
        return false;
      }
      const rec = recordSwitchTrade(position.city, position.positionId, newKeys, sell, buy, decision.buckets);
      logger.info(
        rec
          ? '【换仓】live 切换持仓桶对（真实卖旧买新完成，已持久化）'
          : '【换仓】live 切换持仓桶对（真实卖旧买新完成，持久化失败）',
        {
          positionId: position.positionId,
          city: position.city,
          targetDate,
          old: oldKeys.join('+'),
          next: newKeys.join('+'),
          sellRef: Math.round(sell * 1000) / 1000,
          buyRef: Math.round(buy * 1000) / 1000,
        },
      );
      return true;
    }

    position.buckets = decision.buckets;
    position.bucket = decision.buckets[0]!;
    position.entryPrice = buy; // 成本基准同步为新桶成本（恢复/离场判断口径一致）
    position.switched = true; // 防重：每笔只换一次
    const rec = recordSwitchTrade(position.city, position.positionId, newKeys, sell, buy, decision.buckets);
    logger.info(
      rec
        ? '【换仓】paper 切换持仓桶对（旧桶概率跌破阈值，切到最新预测，已持久化）'
        : '【换仓】paper 切换持仓桶对（旧桶概率跌破阈值，切到最新预测，持久化失败）',
      {
        positionId: position.positionId,
        city: position.city,
        targetDate,
        old: oldKeys.join('+'),
        next: newKeys.join('+'),
        oldPSum: Math.round(oldPSum * 1000) / 1000,
        threshold: SWITCH_THRESHOLD,
        sellRef: Math.round(sell * 1000) / 1000,
        buyRef: Math.round(buy * 1000) / 1000,
      },
    );
    return true;
  }

  /**
   * live 真实换仓：卖旧桶全部股数 → 买新桶（每个新桶 sizeUsd/n 名义金额）。
   * 全部成交返回 true，任一失败返回 false（调用方保持旧持仓，下轮重试）。
   */
  private async liveSwitchPosition(
    position: OpenPosition,
    oldKeys: string[],
    decision: TradingDecision,
    markets: GammaMarket[],
  ): Promise<boolean> {
    const rows = this.parseMarketPrices(markets);
    const oldBuckets =
      position.buckets && position.buckets.length >= 2
        ? position.buckets
        : [position.bucket];
    const sizePerBucket = position.sizeUsd / oldBuckets.length;

    // 1) 卖旧桶（maker-first sell @ best ask，回退市价）。
    for (let i = 0; i < oldBuckets.length; i++) {
      const bucket = oldBuckets[i]!;
      const row = this.marketPriceFor(bucket, rows);
      const tokenId = row?.yesTokenId;
      if (!tokenId) {
        logger.error('【换仓】卖旧失败：旧桶缺少 YES token id', {
          positionId: position.positionId,
          bucket: bucket.label,
        });
        return false;
      }
      const shares = sizePerBucket / Math.max(0.001, this.positionBucketPrice(position, i));
      try {
        const maker = await clobTryMakerSell(tokenId, shares, row?.yesPrice ?? 0);
        if (maker.filled && maker.fillPrice != null) {
          logger.info('【换仓】maker 卖旧成交', {
            bucket: bucket.label,
            shares: Math.round(shares * 100) / 100,
            fillPrice: maker.fillPrice,
          });
          continue;
        }
        await clobSellYesShares(tokenId, shares);
        logger.info('【换仓】市价卖旧成交', {
          bucket: bucket.label,
          shares: Math.round(shares * 100) / 100,
          ask: row?.yesPrice ?? 0,
        });
      } catch (error) {
        logError(logger, `【换仓】卖旧失败（桶 ${bucket.label}）`, error);
        return false;
      }
    }

    // 2) 买新桶（maker-first buy @ best bid，回退市价）。
    const newSizePerBucket = position.sizeUsd / decision.buckets.length;
    for (let i = 0; i < decision.buckets.length; i++) {
      const bucket = decision.buckets[i]!;
      const row = this.marketPriceFor(bucket, rows);
      const tokenId = row?.yesTokenId;
      if (!tokenId) {
        logger.error('【换仓】买新失败：新桶缺少 YES token id', {
          positionId: position.positionId,
          bucket: bucket.label,
        });
        return false;
      }
      try {
        const bid = await this.clobBidFor(tokenId);
        if (bid != null) {
          const maker = await clobTryMakerBuy(tokenId, newSizePerBucket, bid);
          if (maker.filled && maker.fillPrice != null) {
            logger.info('【换仓】maker 买新成交', {
              bucket: bucket.label,
              usd: newSizePerBucket,
              fillPrice: maker.fillPrice,
            });
            continue;
          }
          logger.warn('【换仓】maker 买新未成交，回退市价', {
            bucket: bucket.label,
            bid,
            ask: row?.yesPrice ?? 0,
          });
        }
        await clobBuyYesUsd(tokenId, newSizePerBucket);
        logger.info('【换仓】市价买新成交', {
          bucket: bucket.label,
          usd: newSizePerBucket,
          ask: row?.yesPrice ?? 0,
        });
      } catch (error) {
        logError(logger, `【换仓】买新失败（桶 ${bucket.label}）`, error);
        return false;
      }
    }

    // 全部成交 → 更新内存持仓到新桶对（成本基准 = 新桶成本）。
    position.buckets = decision.buckets;
    position.bucket = decision.buckets[0]!;
    position.entryPrice = newKeysCost(decision.buckets, rows, this.marketPriceFor);
    position.switched = true; // 防重：每笔只换一次
    return true;
  }
}

/**
 * 换仓后成本基准：新桶对 bestAsk 之和（后续离场/结算口径）。
 * 注意：priceFor 必须是"不依赖 this"的纯函数（这里传 this.marketPriceFor，
 * 其内部只用参数和 rows，安全）。
 */
function newKeysCost(
  buckets: TemperatureBucket[],
  rows: MarketPriceRow[],
  priceFor: (b: TemperatureBucket, rows: MarketPriceRow[]) => MarketPriceRow | null,
): number {
  let sum = 0;
  for (const b of buckets) {
    sum += priceFor(b, rows)?.yesPrice ?? 0;
  }
  return sum;
}

/**
 * 命令行入口：`tsx src/strategies/MultiCityStrategy.ts`
 * 启动一个进程处理所有城市。
 */
async function main(): Promise<void> {
  const { loadEnv, loadAllCityConfigs } = await import('../common/config-loader.js');
  const env = loadEnv();
  const cityConfigs = loadAllCityConfigs();

  logger.info(`加载到 ${cityConfigs.length} 个城市配置`);

  const appConfigs = cityConfigs.map((city) => ({
    env,
    city,
    projectRoot: process.cwd(),
  }));

  const service = new MultiCityStrategy(appConfigs);

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

main().catch((error) => {
  logError(logger, 'MultiCityStrategy 启动失败', error);
  process.exit(1);
});