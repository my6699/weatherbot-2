// 这个文件实现 D0 离场策略（ExitStrategy）——双桶区间策略的"持有到结算"。
//
// 核心目标：持有到结算（赢方 1.0 / 输方 0.0），不提前平仓。
//
// 策略（2026-08-17 按回测正期望验证结果）：
//   回测对比显示 0.85 提前平仓净效果为负（-$0.216 / 69 笔），
//   6/7 有差异的城市关闭 0.85 后表现更好。
//   不再有峰值时间强制平仓、不再有 0.85 提前止盈——纯持有到结算 ROI 最高。
//
// 价格止损（STOP_LOSS_K）可在 .env 中开启，当前生产配置 K=0（关闭）。

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

const logger = createModuleLogger('ExitStrategy');

// 价格止损（2026-08-11 回测正优化：K=0.7 → 固定口径 ROI 11.9%→21.7%，凯利口径 3.2%→5.7%）。
//   规则：双桶 bid 之和 <= 入场成本 × STOP_LOSS_K → 止损离场，
//   避免"开仓后一路阴跌、从没涨过成本"的坏单持有到结算吃满亏损（回测 5 笔触发，净效果为正）。
// 分时段对齐生产既有约束：D0 当天本地 15:00 前禁用价格止损——当日最高温尚未形成，
//   bid 下跌多为日内噪音，避免 Miami 7-31 式误杀（单次 hrrr dip 在 12:00 被砍、桶后来到 96.5°F）；
//   D0 15:00 后与其他持仓日（D2/D1，bid 下跌是市场对最新预报的真实重定价）止损可用。
//   0 = 关闭（维持原行为）。生产 .env 用 STOP_LOSS_K=0。
const STOP_LOSS_K = Number(process.env.STOP_LOSS_K ?? '0');
// D0 当天此本地时刻（24h）起才允许价格止损。
const STOP_LOSS_LOCAL_HOUR = 15;

export type ExitTrigger =
  | 'stop_loss'; // 价格止损：双桶 bid 之和 <= 入场成本 × K（D0 15:00 前禁用）

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

    // 价格止损（阶段一之前）：双桶 bid 之和 <= 入场成本 × K → 止损离场。
    // 分时段：D0 当天本地 15:00 前禁用（当日最高温未形成，bid 下跌多为噪音）；
    //   D2/D1 持仓不受限（bid 下跌是市场对最新预报的真实重定价）。
    if (
      STOP_LOSS_K > 0 &&
      input.bucketBids &&
      input.bucketBids.length >= 2 &&
      this.priceStopEnabled(timezone, input.targetDate)
    ) {
      const sum = input.bucketBids.reduce((acc, b) => acc + b.bid, 0);
      const stopLevel = input.position.entryPrice * STOP_LOSS_K;
      if (sum <= stopLevel) {
        return {
          trigger: 'stop_loss',
          sellFraction: 1,
          limitPrice: currentMarket.yesPrice,
          reason: `价格止损：两桶 bid 之和 ${sum.toFixed(3)} <= 入场成本 ${input.position.entryPrice.toFixed(3)} × ${STOP_LOSS_K}（止损线 ${stopLevel.toFixed(3)}），全部平仓`,
        };
      }
    }

    // 持有到结算：不提前平仓，与回测策略保持一致。
    // 结算时赢方付 1.0、输方付 0.0，由结算流程自然处理。

    return null;
  }

  /**
   * 生成离场计划。纯持有到结算策略：不提前平仓，
   * 持有到结算（1.0/0.0），无强制平仓时间。
   */
  buildExitPlan(
    city: CityId,
    timezone: string,
    position: OpenPosition,
    peakLocalTime: string,
  ): ExitPlan {
    const settlementAt = new Date();
    settlementAt.setHours(23, 59, 0, 0);

    logger.info('生成离场计划', {
      city,
      strategy: '持有到结算',
      trigger: '结算',
    });

    return {
      positionId: position.positionId,
      city,
      softExitStartsAt: settlementAt,
      hardExitAt: settlementAt,
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

  /**
   * 价格止损分时段门控：
   *   - D2/D1 持仓：始终允许（bid 下跌是市场对最新预报的真实重定价，止损可信）；
   *   - D0 当天：本地 STOP_LOSS_LOCAL_HOUR（15:00）前禁用——当日最高温尚未形成，
   *     bid 下跌多为日内噪音，避免把"还没到顶的桶"误杀（Miami 7-31 教训）。
   */
  private priceStopEnabled(timezone: string, targetDate: string): boolean {
    if (!this.isSettlementDay(timezone, targetDate)) return true;
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .format(new Date())
      .split(':');
    const hour = Number(parts[0] ?? '0');
    return hour >= STOP_LOSS_LOCAL_HOUR;
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
        // 去掉 UTF-8 BOM（EF BB BF），Windows 记事本保存会带上，JSON.parse 会直接失败。
        const json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as {
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
