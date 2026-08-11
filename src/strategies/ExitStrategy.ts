// 这个文件实现 D0 离场策略（ExitStrategy）——双桶区间策略的"两段式平仓"。
//
// 核心目标：峰值前看 0.85 目标，峰值确认后直接市价平仓，绝不拖到结算。
//
// 两段式平仓（2026-08-07 按用户方案）：
//   阶段一（峰值前）：只判断双桶区间目标——两桶 bid 之和 >= 0.85 即全部平仓。
//     不到 0.85 就继续持有（不做止损、不做软止盈、不按钟点强制平仓）。
//     原因：峰值前的价格波动大多是噪音，正确的区间经常在峰值前都到不了 0.85
//     （例如 08-05 市场最热对 33+34 全天 0.72~0.83，结算前才拉满）。
//   阶段二（峰值后）：到达该城市"历史预测的峰值最晚时间"（hardExitLocalTime），
//     直接市价平仓。不加确认缓冲——峰值一旦确认市场就走完了，没有更好的
//     离场机会，按历史预测时间触发最稳。区间对的自然 >= 0.85（赢家桶 ~1.0），
//     区间错的割肉走人，避免拖到结算归零。
//
// 执行方式：阶段二峰值时间到点一次性全部卖出（不再做 TWAP 拆单，避免错过窗口）。

import fs from 'node:fs';
import path from 'node:path';
import type {
  OpenPosition,
  ExitPlan,
  CityId,
  MarketSnapshot,
} from '../common/types.js';
import type { CityConfig } from '../common/config-loader.js';
import { createModuleLogger } from '../common/logger.js';
import { isTimeToExit, parseTimeString } from '../utils/time.js';

const logger = createModuleLogger('ExitStrategy');

// 双桶区间策略的退出目标：两桶 bid 之和 >= 0.85 即平仓。
const INTERVAL_EXIT_SUM = 0.85;

export type ExitTrigger =
  | 'interval_target' // 阶段一：两桶 bid 之和 >= 0.85
  | 'peak_confirmed'; // 阶段二：峰值确认后直接市价平仓

export interface ExitSignal {
  trigger: ExitTrigger;
  // 建议卖出的比例（0-1）。两段式均为全部平仓（1）。
  sellFraction: number;
  // 建议的卖出价格（限价单价格）。
  // paper 阶段为占位值；live 阶段双桶持仓应按两个市场分别下卖单。
  limitPrice: number;
  reason: string;
}

export interface ExitCheckInput {
  city: CityId;
  timezone: string;
  position: OpenPosition;
  currentMarket: MarketSnapshot;
  // 目标日期（YYYY-MM-DD）。阶段二只在目标日期当天（D0）触发，
  // 否则持仓期间任何一天的"当前时间过峰值点"都会被误判为到点平仓。
  targetDate: string;
  // 保留字段（兼容调用方）。当前两段式逻辑使用 city_peak_times.json 的确认时间。
  peakLocalTime: string;
  // 双桶区间持仓时，两个桶各自的当前 bid 价（用于判断合计 >= 0.85）。
  bucketBids?: Array<{ bucketLabel: string; bid: number }>;
}

export class ExitStrategy {
  constructor(
    private readonly cityConfig: CityConfig,
    private readonly projectRoot = process.cwd(),
  ) {}

  /**
   * 根据当前市场状态和仓位，判断是否应该离场。
   *
   * 返回 ExitSignal（如果应该离场），或 null（继续持有）。
   */
  checkExit(input: ExitCheckInput): ExitSignal | null {
    const { timezone, currentMarket } = input;
    const exitConfig = this.loadExitConfig(input.city);

    // 阶段一（峰值前）：只判断双桶区间目标。
    // 两桶 bid 之和 >= 0.85 即全部平仓；不到就继续持有，
    // 等到峰值确认后再按市价离场（阶段二）。
    if (input.bucketBids && input.bucketBids.length >= 2) {
      const sum = input.bucketBids.reduce((acc, b) => acc + b.bid, 0);
      if (sum >= INTERVAL_EXIT_SUM) {
        return {
          trigger: 'interval_target',
          sellFraction: 1,
          limitPrice: currentMarket.yesPrice,
          reason: `区间目标达成：两桶 bid 之和 ${sum.toFixed(2)} >= ${INTERVAL_EXIT_SUM}，全部平仓`,
        };
      }
    }

    // 阶段二（峰值后）：到达该城市历史预测的峰值最晚时间，直接市价平仓。
    // 只在目标日期当天（D0）生效，避免 D2/D1 持仓被"当天时间过峰值"误平仓。
    if (
      this.isSettlementDay(timezone, input.targetDate) &&
      isTimeToExit(timezone, exitConfig.hardExitLocalTime)
    ) {
      return {
        trigger: 'peak_confirmed',
        sellFraction: 1,
        limitPrice: currentMarket.yesPrice,
        reason: `峰值时间 ${exitConfig.hardExitLocalTime} 已到，按市价全部平仓`,
      };
    }

    return null;
  }

  /**
   * 生成离场计划。两段式策略下：阶段一靠 0.85 目标自动触发，
   * 阶段二在确认时间一次性全部平仓（不做 TWAP 拆单）。
   */
  buildExitPlan(
    city: CityId,
    timezone: string,
    position: OpenPosition,
    peakLocalTime: string,
  ): ExitPlan {
    const exitConfig = this.loadExitConfig(city);

    const hardExitAt = new Date();
    const hardConfig = parseTimeString(exitConfig.hardExitLocalTime);
    hardExitAt.setHours(hardConfig.hour, hardConfig.minute, 0, 0);

    logger.info('生成离场计划', {
      city,
      hardExitAt: hardExitAt.toLocaleString(),
      trigger: '峰值时间一次性全部平仓',
    });

    return {
      positionId: position.positionId,
      city,
      // 两段式：峰值前无软止盈窗口，软开始时间与确认时间相同。
      softExitStartsAt: hardExitAt,
      hardExitAt,
      twapSlices: 1,
      takeProfitRatio: 0,
      completed: false,
    };
  }

  // ==================== 内部实现 ====================

  /**
   * 当前城市日期（YYYY-MM-DD）是否为目标日期（D0）。
   * targetDate 为空（旧记录）时兼容为 true，仅按时间判断。
   */
  private isSettlementDay(timezone: string, targetDate: string): boolean {
    if (!targetDate) return true;
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(new Date()) === targetDate;
  }

  private loadExitConfig(city: CityId): {
    softExitBeforePeakHours: number;
    hardExitLocalTime: string;
    twapSlices: number;
    takeProfitRatio: number;
    stopLossRatio: number;
  } {
    // 默认值：峰值最晚时间用城市配置，兜底参数写在这里。
    const defaults = {
      softExitBeforePeakHours: 1.5,
      hardExitLocalTime: this.cityConfig.peakTimeLocal.latest,
      twapSlices: 4,
      takeProfitRatio: 0.25,
      stopLossRatio: 0.15,
    };

    // 从 config/city_peak_times.json 读取"该城市历史最高温出现时间"和离场参数。
    // 这是用户要求的"根据历史数据查看每个城市的最高气温出现的时间"落地：
    // 每个城市在 D0 当天的峰值窗口不同（上海 12:30，其他城市各自独立），
    // 阶段二 = 到达峰值最晚时间直接市价平仓（不加确认缓冲）。
    try {
      const file = path.join(this.projectRoot, 'config', 'city_peak_times.json');
      if (fs.existsSync(file)) {
        const json = JSON.parse(fs.readFileSync(file, 'utf8')) as {
          cities?: Record<
            string,
            { exitStrategy?: Partial<typeof defaults> }
          >;
        };
        const exitStrategy = json.cities?.[city]?.exitStrategy;
        if (exitStrategy) {
          return {
            softExitBeforePeakHours:
              exitStrategy.softExitBeforePeakHours ?? defaults.softExitBeforePeakHours,
            hardExitLocalTime: exitStrategy.hardExitLocalTime ?? defaults.hardExitLocalTime,
            twapSlices: exitStrategy.twapSlices ?? defaults.twapSlices,
            takeProfitRatio: exitStrategy.takeProfitRatio ?? defaults.takeProfitRatio,
            stopLossRatio: exitStrategy.stopLossRatio ?? defaults.stopLossRatio,
          };
        }
      }
    } catch (error) {
      logger.warn('读取 city_peak_times.json 失败，使用默认离场参数', {
        city,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return defaults;
  }
}
