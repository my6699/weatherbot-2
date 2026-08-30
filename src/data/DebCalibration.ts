// 生产校准模块（DEB 借鉴，2026-08-07）
//
// 把回测验证有效的两项校准（温度档 bias + 动态 MAE 权重）落地到生产：
//   - 温度档 bias：bias.json 的 4 维 key（city|horizon|source|stratum），
//     James-Stein 收缩 b_eff = (n/(n+5))×b_档 + (1−n/(n+5))×b_城市。
//     weather-2 回测最大赢家（PnL 翻倍）。
//   - 动态 MAE 权重：residual_stats.json 的 mae 表（unit|horizon|source），
//     ecwmf/gfs 按 1/MAE 倒数缩放，icon 无历史快照保持静态占比 0.2。
//
// 数据来源：旧项目（polymarket-weather-bot）积累的已结算市场校准表，
// 路径通过 env OLD_PROJECT_DATA_DIR 或默认相对路径指向旧项目 data 目录。
// 与 simulate-all-cities.ts 的 LOO 口径一致（生产场景直接用最新积累表，
// 没有"未来数据"问题——bias 表只由已结算市场刷新）。

import fs from 'node:fs';
import path from 'node:path';
import { createModuleLogger } from '../common/logger.js';

const logger = createModuleLogger('DebCalibration');

// 温度档划分（℃, 忠实 PolyWeather TEMP_BUCKET_KEYS 与回测脚本）。
export function tempStratumC(fc: number): string {
  if (fc <= 32) return '<=32';
  if (fc <= 36) return '33-36';
  return '>=37';
}

// weather-2 sourceId → 旧项目 bias 表 source（best/ecmwf/hrrr）。
const SOURCE_TO_OLD: Record<string, string> = {
  'open-meteo-ecmwf': 'ecmwf',
  'open-meteo-gfs': 'hrrr', // 旧项目 gfs_seamless 记作 hrrr
  'open-meteo-icon': 'best', // icon 无独立 bias 记录，用 ensemble mean 代理
};

// weather-2 horizon（d3/d2/d1/d0）→ 旧项目 bias 表 horizon（D+3/D+2/D+1/D+0）。
const HORIZON_TO_OLD: Record<string, string> = {
  d3: 'D+3',
  d2: 'D+2',
  d1: 'D+1',
  d0: 'D+0',
};

// 与回测脚本（simulate-all-cities.ts）一致的参数。
const STRATUM_SHRINK_K = 5;
const BIAS_MIN_N = 2;
const BIAS_SHRINK_N = 4;
const BIAS_MAX_C = 2.0; // ℃ 幅度钳位
const MAE_MIN_N = 3;

interface BiasEntry {
  bias: number;
  n: number;
}

interface ResidualEntry {
  mae?: number;
  n?: number;
}

export class DebCalibration {
  private biasTable: Record<string, BiasEntry> = {};
  private residualStats: Record<string, ResidualEntry> = {};
  private dataDir = '';
  // 已加载文件的 mtime（ms），用于检测偏差表更新并自动重载（不重启进程）。
  private biasMtimeMs = -1;
  private residualMtimeMs = -1;

  constructor(projectRoot: string) {
    this.dataDir =
      process.env.OLD_PROJECT_DATA_DIR ??
      path.resolve(projectRoot, '..', '..', 'weather-bot', 'polymarket-weather-bot', 'data');
    this.load(this.dataDir);
  }

  /**
   * 检查 bias.json / residual_stats.json 的 mtime 是否变化。
   * 任一文件更新则重新加载校准表（每轮采集时调用，无需重启进程）。
   * 返回 true 表示本轮发生了重载。
   */
  reloadIfChanged(): boolean {
    const biasPath = path.join(this.dataDir, 'bias.json');
    const residualPath = path.join(this.dataDir, 'residual_stats.json');
    let changed = false;
    try {
      if (fs.existsSync(biasPath) && fs.statSync(biasPath).mtimeMs !== this.biasMtimeMs) {
        changed = true;
      }
    } catch {
      // stat 失败（文件被占用等）不触发重载，沿用当前表。
    }
    try {
      if (fs.existsSync(residualPath) && fs.statSync(residualPath).mtimeMs !== this.residualMtimeMs) {
        changed = true;
      }
    } catch {
      // 同上。
    }
    if (changed) {
      this.load(this.dataDir);
    }
    return changed;
  }

  private load(oldDataDir: string): void {
    const biasPath = path.join(oldDataDir, 'bias.json');
    const residualPath = path.join(oldDataDir, 'residual_stats.json');

    try {
      if (fs.existsSync(biasPath)) {
        this.biasTable = JSON.parse(fs.readFileSync(biasPath, 'utf8')) as Record<string, BiasEntry>;
        this.biasMtimeMs = fs.statSync(biasPath).mtimeMs;
        logger.info('加载温度档 bias 表', { keyCount: Object.keys(this.biasTable).length });
      }
    } catch (error) {
      logger.warn('加载 bias.json 失败，温度档 bias 不可用', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      if (fs.existsSync(residualPath)) {
        const raw = JSON.parse(fs.readFileSync(residualPath, 'utf8')) as {
          sigma?: Record<string, ResidualEntry>;
        };
        this.residualStats = raw.sigma ?? {};
        this.residualMtimeMs = fs.statSync(residualPath).mtimeMs;
        logger.info('加载残差统计表（MAE）', { keyCount: Object.keys(this.residualStats).length });
      }
    } catch (error) {
      logger.warn('加载 residual_stats.json 失败，动态 MAE 权重不可用', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 与回测 computeCityBias 同口径：样本收缩（n/BIAS_SHRINK_N）+ 幅度钳位。 */
  private shrunkBias(entry: BiasEntry | undefined): number {
    if (!entry || entry.n < BIAS_MIN_N) return 0;
    const shrink = Math.min(1, entry.n / BIAS_SHRINK_N);
    const capped = Math.max(-BIAS_MAX_C, Math.min(BIAS_MAX_C, entry.bias));
    return Math.round(capped * shrink * 1000) / 1000;
  }

  /**
   * 温度档 bias（℃，James-Stein 收缩，与回测 computeBiasWithStratum 同口径）：
   *   b_eff = (n/(n+5))×b_档 + (1−n/(n+5))×b_城市
   * 档内样本不足回退三维城市基准（行为与无档一致）。
   * 返回 0 = 不修正。
   */
  getBiasC(city: string, horizon: string, sourceId: string, forecastC: number): number {
    const oldHorizon = HORIZON_TO_OLD[horizon] ?? 'D+2';
    const oldSource = SOURCE_TO_OLD[sourceId];
    if (!oldSource) return 0;

    // 三维城市基准缺失时完全不修正（与回测 computeBiasWithStratum 的 !base 分支一致）。
    const b3Entry = this.biasTable[`${city}|${oldHorizon}|${oldSource}`];
    if (!b3Entry || b3Entry.n < BIAS_MIN_N) return 0;
    const b3 = this.shrunkBias(b3Entry);

    const stratum = tempStratumC(forecastC);
    const sEntry = this.biasTable[`${city}|${oldHorizon}|${oldSource}|${stratum}`];
    if (!sEntry || sEntry.n < BIAS_MIN_N) return b3;

    const s = this.shrunkBias(sEntry);
    const eff = (sEntry.n / (sEntry.n + STRATUM_SHRINK_K)) * s +
      (1 - sEntry.n / (sEntry.n + STRATUM_SHRINK_K)) * b3;
    return Math.round(eff * 1000) / 1000;
  }

  /**
   * 动态 MAE 权重（sourceId → weight，与回测 dynamicSourceWeights 同口径）。
   * ecmwf/gfs 按 1/MAE 倒数缩放（基数 0.5/0.3），icon 无历史快照保持静态 0.2，
   * 归一化到总和 1。任一源 MAE 样本不足则回退空 Map（调用方用健康权重/简单平均）。
   */
  getMaeWeights(unit: string, horizon: string): Map<string, number> {
    const oldHorizon = HORIZON_TO_OLD[horizon] ?? 'D+2';
    const maeOf = (src: string): number | null => {
      const e = this.residualStats[`${unit}|${oldHorizon}|${src}`];
      if (!e || e.mae == null || (e.n ?? 0) < MAE_MIN_N) return null;
      return e.mae;
    };

    const maeE = maeOf('ecmwf');
    const maeG = maeOf('hrrr');
    const have = [maeE, maeG].filter((m): m is number => m != null);
    if (have.length === 0) return new Map();
    if (maeE != null && maeE === 0) return new Map();
    if (maeG != null && maeG === 0) return new Map();
    const best = Math.min(...have);

    const weights = new Map<string, number>([
      ['open-meteo-ecmwf', maeE != null ? 0.5 * (best / maeE) : 0],
      ['open-meteo-gfs', maeG != null ? 0.3 * (best / maeG) : 0],
      ['open-meteo-icon', 0.2],
    ]);
    const sum = Array.from(weights.values()).reduce((a, b) => a + b, 0);
    if (sum <= 0) return new Map();
    for (const [k, v] of weights) weights.set(k, Math.round((v / sum) * 1000) / 1000);
    return weights;
  }
}
