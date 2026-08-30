// 天气修正胜率报告脚本（对比"修正后预测"与"METAR 结算真值"，推送企业微信）。
//
// 数据链路：
//   1. datahub 每轮把修正后的预测（日最高温锚点 + top/次高温度桶及概率）落盘到
//      data/predictions.json（key = city|date，每个 (城市, 目标日期, 水平段) 保留最新一轮）。
//   2. 旧项目 collector 把 METAR 实际日最高温写入 metar_max.json（站 → {日期: °C}），
//      这是 Polymarket 温度市场的结算真值。
//   3. 本脚本 join 两张表：对已过去的日期，判定"修正后预测的最高温桶"是否命中实际温度。
//
// 胜率口径：
//   - top1 命中：实际温度落在模型最高概率桶的 [min, max) 区间内。
//   - 区间命中：实际温度落在 top1 或 top2 桶之一（贴近双桶区间策略语义）。
//   - 平均误差：|修正后预测温度 − 实际温度|。
//
// 部署方式（PM2，每天 06:00 UTC——前一天全部结算后）：
//   cron_restart: '0 6 * * *'
// 手动运行：
//   npx tsx scripts/winrate-report.ts

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { sendWeComMarkdown } from '../src/utils/wecom-notifier.js';
import { createModuleLogger } from '../src/common/logger.js';
import { parseBoundsFromLabel } from '../src/strategies/MultiCityStrategy.js';
import { parseDisabledCities, loadEnv } from '../src/common/config-loader.js';
import { runWhitelistEvalAndNotify } from '../src/whitelist/CityWhitelistManager.js';

const logger = createModuleLogger('WinrateReport');

interface HorizonPred {
  anchorC: number;
  topBucket: string;
  topMinC: number | null;
  topMaxC: number | null;
  topProb: number;
  secondBucket: string | null;
  secondMinC: number | null;
  secondMaxC: number | null;
  secondProb: number | null;
  // 修正前锚点（原始预报加权平均）及其所在桶——08-11 晚间落盘才开始有。
  rawAnchorC?: number;
  rawTopBucket?: string | null;
  rawTopMinC?: number | null;
  rawTopMaxC?: number | null;
  updatedAt: string;
}

interface PredictionRecord {
  city: string;
  stationId: string;
  date: string;
  horizons: Record<string, HorizonPred>;
}

interface HorizonStats {
  n: number;
  top1Hit: number;
  intervalHit: number;
  errSumC: number;
}

// 企业微信 markdown 支持粗体/列表，不支持表格 → 推送用列表，落盘 md 用表格。
const HORIZON_CN: Record<string, string> = {
  d0: '当天 D+0',
  d1: '明天 D+1',
  d2: '后天 D+2',
  d3: '大后天 D+3',
};
const HORIZON_ORDER = ['d0', 'd1', 'd2', 'd3'];

// 城市中文名（企业微信消息用大白话）。
const CITY_CN: Record<string, string> = {
  shanghai: '上海',
  nyc: '纽约',
  chicago: '芝加哥',
  miami: '迈阿密',
  dallas: '达拉斯',
  seattle: '西雅图',
  atlanta: '亚特兰大',
  london: '伦敦',
  paris: '巴黎',
  munich: '慕尼黑',
  ankara: '安卡拉',
  seoul: '首尔',
  tokyo: '东京',
  singapore: '新加坡',
  lucknow: '勒克瑙',
  'tel-aviv': '特拉维夫',
  toronto: '多伦多',
  'sao-paulo': '圣保罗',
  'buenos-aires': '布宜诺斯艾利斯',
  wellington: '惠灵顿',
};

function inBucket(tempC: number, minC: number | null, maxC: number | null): boolean {
  if (minC !== null && tempC < minC) return false;
  if (maxC !== null && tempC >= maxC) return false;
  return true;
}

function pct(hit: number, n: number): string {
  return n === 0 ? '—' : `${((hit / n) * 100).toFixed(0)}%`;
}

// ==================== 选桶与策略表现监控（2026-08-12 加入） ====================
// 数据源：
//   1. data/trades-*.json —— 滚动表现（近 7 天 vs 全量命中率/ROI/EV）
//   2. data/trade-journal.json —— 开仓评估快照（当日 OPEN/SKIP 分布、edge 过滤监控、
//      反事实、排序一致性）。
// 反事实口径：被"最优单桶 edge 0.16"挡掉的对，若当时开了会怎样——
//   命中 = 实际温度（metar_max 真值）落在被挡桶对任一桶；回收按 1、未中按 0 估算。
//   这是验证过滤/排序是否"误杀"的直接量化。
interface TradeLike {
  city?: string;
  targetDate?: string;
  status?: string;
  pnl?: number | null;
  sizeUsd?: number;
  hit?: boolean | null;
  buckets?: string[];
  entryPrice?: number;
  exitPrice?: number;
}
interface JournalEval {
  t?: string;
  city?: string;
  targetDate?: string;
  horizon?: string;
  decision?: string;
  buckets?: string[];
  entryPrice?: number;
  pPair?: number;
  bestSingleEdge?: number;
}
function buildStrategyMonitor(
  projectRoot: string,
  today: string,
  metarMax: Record<string, Record<string, number>>,
  cityStation: Record<string, string>,
): { md: string[]; wecom: string[] } {
  const dataDir = path.join(projectRoot, 'data');
  const md: string[] = [];
  const wecom: string[] = [];

  // ---------- 1. 滚动表现（trades-*.json） ----------
  const trades: TradeLike[] = [];
  if (fs.existsSync(dataDir)) {
    for (const f of fs.readdirSync(dataDir)) {
      if (!/^trades-.+\.json$/.test(f)) continue;
      try {
        trades.push(...(JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')) as TradeLike[]));
      } catch {
        /* 单文件损坏跳过 */
      }
    }
  }
  // 排除历史占位垃圾（原生单位改造前 shanghai <=30 假记录：0.5/0.5/单桶/$20，
  // 共 16 笔，entry=exit=0.5 → pnl=0 会稀释命中率），lucknow 双桶 0.5/0.5 是真实记录不误伤。
  const isPlaceholder = (t: TradeLike): boolean =>
    t.entryPrice === 0.5 &&
    t.exitPrice === 0.5 &&
    t.sizeUsd === 20 &&
    Array.isArray(t.buckets) &&
    t.buckets.length === 1;
  const done = trades.filter(
    (t) => t.pnl !== null && t.pnl !== undefined && t.status !== 'open' && !isPlaceholder(t),
  );
  const cutoff7 = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const sumPnl = (arr: TradeLike[]) => arr.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const sumSize = (arr: TradeLike[]) => arr.reduce((s, t) => s + (t.sizeUsd ?? 0), 0);
  const winCount = (arr: TradeLike[]) => arr.filter((t) => (t.pnl ?? 0) > 0).length;
  const hitCount = (arr: TradeLike[]) => arr.filter((t) => t.hit === true).length;
  const fmtUsd = (v: number) => `$${(v >= 0 ? '+' : '')}${v.toFixed(2)}`;
  const row = (arr: TradeLike[]): string => {
    const n = arr.length;
    if (n === 0) return '| — | — | — | — | — | — |';
    const invested = sumSize(arr);
    const roi = invested > 0 ? ((sumPnl(arr) / invested) * 100).toFixed(0) : '—';
    return `| ${n} | ${pct(hitCount(arr), n)} | ${winCount(arr)} | ${fmtUsd(sumPnl(arr))} | ${roi}% | ${fmtUsd(sumPnl(arr) / n)} |`;
  };
  const done7 = done.filter(
    (t) => (t.targetDate ?? '') >= cutoff7 && (t.targetDate ?? '') < today,
  );

  // ---------- 2. journal：选桶质量 + 反事实 + 排序一致性 ----------
  const journalFile = path.join(dataDir, 'trade-journal.json');
  const evs: JournalEval[] = fs.existsSync(journalFile)
    ? (JSON.parse(fs.readFileSync(journalFile, 'utf8')).evaluations as JournalEval[])
    : [];
  const todayEvs = evs.filter((e) => (e.t ?? '').startsWith(today));
  const decCount = new Map<string, number>();
  for (const e of todayEvs) decCount.set(e.decision ?? '?', (decCount.get(e.decision ?? '?') ?? 0) + 1);

  // 反事实：SKIP_BEST_SINGLE_EDGE 中被挡的对（targetDate 已过 + 有真值）
  const skips = evs.filter(
    (e) =>
      e.decision === 'SKIP_BEST_SINGLE_EDGE' &&
      typeof e.entryPrice === 'number' &&
      Array.isArray(e.buckets) &&
      e.buckets.length >= 2,
  );
  const cfSettled: Array<{ hit: boolean; cost: number }> = [];
  let cfPending = 0;
  for (const e of skips) {
    if (!e.targetDate || e.targetDate >= today) {
      cfPending += 1;
      continue;
    }
    const stationId = e.city ? cityStation[e.city] : undefined;
    const actualC = stationId ? metarMax[stationId]?.[e.targetDate] : undefined;
    if (actualC === undefined) {
      cfPending += 1;
      continue;
    }
    const hit = (e.buckets ?? []).some((label) => {
      const b = parseBoundsFromLabel(label);
      return b !== null && inBucket(actualC, b.minTempC, b.maxTempC);
    });
    cfSettled.push({ hit, cost: e.entryPrice as number });
  }
  const cfPnl = cfSettled.reduce((s, c) => s + (c.hit ? 1 - c.cost : -c.cost), 0);
  const cfInvested = cfSettled.reduce((s, c) => s + c.cost, 0);
  const cfRoi = cfInvested > 0 ? ((cfPnl / cfInvested) * 100).toFixed(0) : '—';

  // 排序一致性：OPEN 记录的 |pPair − 成本|（越小 = 模型与市场越一致）
  const opens = evs.filter(
    (e) =>
      e.decision === 'OPEN' &&
      typeof e.pPair === 'number' &&
      typeof e.entryPrice === 'number',
  );
  const agreements = opens.map((e) => Math.abs((e.pPair as number) - (e.entryPrice as number)));
  const avgAgree = agreements.length > 0
    ? (agreements.reduce((s, v) => s + v, 0) / agreements.length).toFixed(3)
    : '—';

  const edgeVals = skips.map((e) => e.bestSingleEdge).filter((v): v is number => typeof v === 'number');
  const edgeRange = edgeVals.length > 0
    ? `${Math.min(...edgeVals).toFixed(3)}~${Math.max(...edgeVals).toFixed(3)}`
    : '—';

  md.push(
    ``,
    `## 选桶与策略表现`,
    ``,
    `### 当日开仓评估（${today}）`,
    ``,
    `| 决策 | 笔数 |`,
    `| --- | --- |`,
    `| OPEN（开仓） | ${decCount.get('OPEN') ?? 0} |`,
    `| SKIP_BEST_SINGLE_EDGE（最优单桶 edge 不足） | ${decCount.get('SKIP_BEST_SINGLE_EDGE') ?? 0} |`,
    `| SKIP_MIN_ORDER_SHARES（不足最小股数） | ${decCount.get('SKIP_MIN_ORDER_SHARES') ?? 0} |`,
    `| SKIP_NO_DECISION（引擎未选出） | ${decCount.get('SKIP_NO_DECISION') ?? 0} |`,
    ``,
    `### 最优单桶 edge 过滤监控（累计 ${skips.length} 笔被挡）`,
    ``,
    `- 被挡对的 edge 范围：${edgeRange}`,
    `- 反事实（已结算日期，假如开了）：命中 ${cfSettled.filter((c) => c.hit).length}/${cfSettled.length}，估算盈亏 ${fmtUsd(cfPnl)}（ROI ${cfRoi}%）`,
    `- 反事实待结算：${cfPending} 笔（结算后自动计入）`,
    ``,
    `> 反事实口径：实际温度落在被挡桶对任一桶即命中；回收按 1、未中按 0 估算。`,
    `> 命中率显著 > 平衡点（≈ 30%）说明过滤在误杀；持续低命中说明 0.16 挡得对。`,
    ``,
    `### 排序一致性（OPEN 累计 ${agreements.length} 笔）`,
    ``,
    `- 平均 |pPair − 成本|：${avgAgree}（越小 = 模型与市场越一致，排序在选"最有把握"的对）`,
    ``,
    `### 策略滚动表现（trades）`,
    ``,
    `| 窗口 | 笔数 | 命中率 | 盈利笔 | 盈亏 | ROI | EV/笔 |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
    `| 近 7 天 | ${row(done7)}`,
    `| 全量 | ${row(done)}`,
    ``,
  );

  wecom.push(
    ``,
    `**选桶与策略表现**`,
    `- 当日评估：OPEN ${decCount.get('OPEN') ?? 0} / edge不足 ${decCount.get('SKIP_BEST_SINGLE_EDGE') ?? 0} / 不足最小股数 ${decCount.get('SKIP_MIN_ORDER_SHARES') ?? 0} / 引擎未选 ${decCount.get('SKIP_NO_DECISION') ?? 0}`,
    `- 过滤反事实（累计被挡 ${skips.length}）：已结算 ${cfSettled.length} 笔中命中 ${cfSettled.filter((c) => c.hit).length}（${pct(cfSettled.filter((c) => c.hit).length, cfSettled.length)}），若开了估算 ${fmtUsd(cfPnl)}（ROI ${cfRoi}%）；待结算 ${cfPending}`,
    `- 滚动（近7天/全量）：命中 ${pct(hitCount(done7), done7.length)}/${pct(hitCount(done), done.length)}、ROI ${done7.length > 0 && sumSize(done7) > 0 ? ((sumPnl(done7) / sumSize(done7)) * 100).toFixed(0) : '—'}%/${done.length > 0 && sumSize(done) > 0 ? ((sumPnl(done) / sumSize(done)) * 100).toFixed(0) : '—'}%、EV ${done7.length > 0 ? fmtUsd(sumPnl(done7) / done7.length) : '—'}/${done.length > 0 ? fmtUsd(sumPnl(done) / done.length) : '—'}`,
  );

  return { md, wecom };
}

function main(): void {
  const projectRoot = process.cwd();

  // 1. 读取修正后预测。
  const predFile = path.join(projectRoot, 'data', 'predictions.json');
  if (!fs.existsSync(predFile)) {
    logger.warn('predictions.json 不存在，先让 datahub 跑几轮积累预测', { predFile });
    process.exit(0);
  }
  const predictions = JSON.parse(fs.readFileSync(predFile, 'utf8')) as Record<
    string,
    PredictionRecord
  >;

  // city → stationId 映射（反事实结算判定用，journal 只记 city 不记站）。
  const cityStation: Record<string, string> = {};
  for (const r of Object.values(predictions)) {
    if (r.city && r.stationId) cityStation[r.city] = r.stationId;
  }

  // 2. 读取 METAR 结算真值（旧项目 collector 产物，路径与 DebCalibration 一致）。
  const oldDataDir =
    process.env.OLD_PROJECT_DATA_DIR ??
    path.resolve(projectRoot, '..', '..', 'weather-bot', 'polymarket-weather-bot', 'data');
  const metarFile = path.join(oldDataDir, 'metar_max.json');
  if (!fs.existsSync(metarFile)) {
    logger.warn('metar_max.json 不存在（结算真值缺失），无法对比', { metarFile });
    process.exit(0);
  }
  const metarMax = JSON.parse(fs.readFileSync(metarFile, 'utf8')) as Record<
    string,
    Record<string, number>
  >;

  const today = new Date().toISOString().slice(0, 10);

  // 3. 逐条样本判定命中。
  const stats: Record<string, HorizonStats> = {};
  const cityStats: Record<string, HorizonStats> = {};
  const all: HorizonStats = { n: 0, top1Hit: 0, intervalHit: 0, errSumC: 0 };
  // 修正效果对比：只用"同时有修正前/修正后记录"的交集样本。
  // corrStats = 交集样本的修正后表现；rawStats = 同一批样本的未修正表现。
  const corrStats: HorizonStats = { n: 0, top1Hit: 0, intervalHit: 0, errSumC: 0 };
  const rawStats: HorizonStats = { n: 0, top1Hit: 0, intervalHit: 0, errSumC: 0 };
  const samples: Array<{
    city: string;
    date: string;
    horizon: string;
    predC: number;
    actualC: number;
    top1Hit: boolean;
    intervalHit: boolean;
  }> = [];

  for (const record of Object.values(predictions)) {
    const actualC = metarMax[record.stationId]?.[record.date];
    // 只统计已过去的日期（结算已定），且该站当天有 METAR 真值。
    if (actualC === undefined || record.date >= today) continue;

    for (const [horizon, h] of Object.entries(record.horizons)) {
      const top1Hit = inBucket(actualC, h.topMinC, h.topMaxC);
      const intervalHit =
        top1Hit ||
        (h.secondMinC !== null || h.secondMaxC !== null
          ? inBucket(actualC, h.secondMinC, h.secondMaxC)
          : false);

      (stats[horizon] ??= { n: 0, top1Hit: 0, intervalHit: 0, errSumC: 0 });
      stats[horizon].n += 1;
      stats[horizon].top1Hit += top1Hit ? 1 : 0;
      stats[horizon].intervalHit += intervalHit ? 1 : 0;
      stats[horizon].errSumC += Math.abs(h.anchorC - actualC);

      const cs = (cityStats[record.city] ??= { n: 0, top1Hit: 0, intervalHit: 0, errSumC: 0 });
      cs.n += 1;
      cs.top1Hit += top1Hit ? 1 : 0;
      cs.intervalHit += intervalHit ? 1 : 0;
      cs.errSumC += Math.abs(h.anchorC - actualC);

      all.n += 1;
      all.top1Hit += top1Hit ? 1 : 0;
      all.intervalHit += intervalHit ? 1 : 0;
      all.errSumC += Math.abs(h.anchorC - actualC);

      // 修正前后对比（仅对带 raw 字段的新记录）。
      if ('rawTopMinC' in h) {
        const rawHit = inBucket(actualC, h.rawTopMinC ?? null, h.rawTopMaxC ?? null);
        const rawErr = Math.abs((h.rawAnchorC ?? 0) - actualC);
        const corrErr = Math.abs(h.anchorC - actualC);

        corrStats.n += 1;
        corrStats.top1Hit += top1Hit ? 1 : 0;
        corrStats.errSumC += corrErr;

        rawStats.n += 1;
        rawStats.top1Hit += rawHit ? 1 : 0;
        rawStats.errSumC += rawErr;
      }

      samples.push({
        city: record.city,
        date: record.date,
        horizon,
        predC: h.anchorC,
        actualC,
        top1Hit,
        intervalHit,
      });
    }
  }

  if (all.n === 0) {
    logger.info('尚无已结算样本（predictions 需要积累，且日期需已过去）', {
      today,
      predictions: Object.keys(predictions).length,
    });
    process.exit(0);
  }

  // 4. 生成报告（落盘 md + 企业微信推送）。
  const genAt = new Date();
  const maec = (s: HorizonStats): string =>
    s.n === 0 ? '—' : `±${(s.errSumC / s.n).toFixed(1)}°C`;

  const mdLines = [
    `# 天气修正胜率报告`,
    ``,
    `- 生成时间：${genAt.toISOString().slice(0, 16)} UTC`,
    `- 样本：${all.n} 个（城市 × 日期 × 水平段）配对`,
    `- 真值口径：METAR 站日最高温（结算依据）`,
    ``,
    `## 总体`,
    ``,
    `| 指标 | 数值 |`,
    `| --- | --- |`,
    `| 最高温桶命中率（top1） | ${pct(all.top1Hit, all.n)}（${all.top1Hit}/${all.n}） |`,
    `| 双桶区间命中率（top1+top2） | ${pct(all.intervalHit, all.n)}（${all.intervalHit}/${all.n}） |`,
    `| 平均温度误差 | ${maec(all)} |`,
    ``,
    `## 按预报提前量`,
    ``,
    `| 提前量 | 样本 | top1 命中 | 区间命中 | 平均误差 |`,
    `| --- | --- | --- | --- | --- |`,
  ];
  for (const h of HORIZON_ORDER) {
    const s = stats[h];
    if (!s) continue;
    mdLines.push(
      `| ${HORIZON_CN[h] ?? h} | ${s.n} | ${pct(s.top1Hit, s.n)} | ${pct(s.intervalHit, s.n)} | ${maec(s)} |`,
    );
  }

  // 按城市拆分（top1 命中率降序；样本 <2 的排最后，参考价值低）。
  const cityEntries = Object.entries(cityStats)
    .map(([city, s]) => ({ city, s }))
    .sort((a, b) => {
      const aStrong = a.s.n >= 2;
      const bStrong = b.s.n >= 2;
      if (aStrong !== bStrong) return aStrong ? -1 : 1;
      return b.s.top1Hit / b.s.n - a.s.top1Hit / a.s.n;
    });

  mdLines.push(
    ``,
    `## 按城市`,
    ``,
    `> 样本数越少，命中率参考价值越低（1 个样本 100% 不代表真准）。`,
    ``,
    `| 城市 | 样本 | top1 命中 | 区间命中 | 平均误差 |`,
    `| --- | --- | --- | --- | --- |`,
  );
  for (const { city, s } of cityEntries) {
    mdLines.push(
      `| ${CITY_CN[city] ?? city} | ${s.n} | ${pct(s.top1Hit, s.n)} | ${pct(s.intervalHit, s.n)} | ${maec(s)} |`,
    );
  }

  // 修正效果对比（仅对带 raw 字段的记录，评估偏差修正净效果）。
  let hitDeltaPp = 0;
  let maeDelta = 0;
  if (corrStats.n > 0) {
    hitDeltaPp = ((corrStats.top1Hit - rawStats.top1Hit) / corrStats.n) * 100;
    maeDelta = corrStats.errSumC / corrStats.n - rawStats.errSumC / rawStats.n; // 负 = 改善
    const hitDeltaStr = hitDeltaPp >= 0 ? `+${hitDeltaPp.toFixed(0)}pp` : `${hitDeltaPp.toFixed(0)}pp`;
    const maeDeltaStr = maeDelta <= 0
      ? `改善 ${(-maeDelta).toFixed(1)}°C`
      : `恶化 ${maeDelta.toFixed(1)}°C`;
    mdLines.push(
      ``,
      `## 修正效果（vs 未修正）`,
      ``,
      `> 仅统计同时有修正前/修正后记录的样本（${corrStats.n} 个，从 08-11 晚间开始积累）。`,
      ``,
      `| 指标 | 未修正 | 修正后 | 变化 |`,
      `| --- | --- | --- | --- |`,
      `| top1 命中率 | ${pct(rawStats.top1Hit, rawStats.n)}（${rawStats.top1Hit}/${rawStats.n}） | ${pct(corrStats.top1Hit, corrStats.n)}（${corrStats.top1Hit}/${corrStats.n}） | ${hitDeltaStr} |`,
      `| 平均误差 | ${maec(rawStats)} | ${maec(corrStats)} | ${maeDeltaStr} |`,
    );
  }

  const top1 = pct(all.top1Hit, all.n);
  const intv = pct(all.intervalHit, all.n);
  const d0s = stats.d0;
  const d3s = stats.d3;
  // 大白话提最好/最差城市（只点名样本 >=2 的城市）。
  const strongCities = cityEntries.filter(({ s }) => s.n >= 2);
  const bestCity = strongCities[0];
  const worstCity = strongCities[strongCities.length - 1];
  const plainLines = [];
  plainLines.push(`大白话：`);
  plainLines.push(
    `模型修正后，预测最高温桶的整体命中率 ${top1}，双桶区间命中率 ${intv}。`,
  );
  if (d0s && d3s) {
    plainLines.push(
      `当天（D+0）预测命中率 ${pct(d0s.top1Hit, d0s.n)}，提前 3 天（D+3）只有 ${pct(d3s.top1Hit, d3s.n)}——临近日期的预测明显更可靠，提前量越大越仅供参考。`,
    );
  }
  if (bestCity && worstCity && bestCity.city !== worstCity.city) {
    plainLines.push(
      `城市对比（样本≥2）：修正效果最好的是${CITY_CN[bestCity.city] ?? bestCity.city}（top1 命中 ${pct(bestCity.s.top1Hit, bestCity.s.n)}，${bestCity.s.n} 样本），最差的是${CITY_CN[worstCity.city] ?? worstCity.city}（top1 命中 ${pct(worstCity.s.top1Hit, worstCity.s.n)}，${worstCity.s.n} 样本）。`,
    );
  }
  if (corrStats.n > 0) {
    const hitDeltaStr = hitDeltaPp >= 0 ? `提升 ${hitDeltaPp.toFixed(0)}pp` : `下降 ${(-hitDeltaPp).toFixed(0)}pp`;
    const maeDeltaStr = maeDelta <= 0
      ? `平均误差减小 ${(-maeDelta).toFixed(1)}°C`
      : `平均误差反而增大 ${maeDelta.toFixed(1)}°C`;
    plainLines.push(
      hitDeltaPp >= 0
        ? `修正是正面的：命中率${hitDeltaStr}、${maeDeltaStr}。`
        : `修正目前是负面的：命中率${hitDeltaStr}、${maeDeltaStr}，需要检查偏差表。`,
    );
  }
  mdLines.push(``, ...plainLines);

  // 选桶与策略表现监控段（选桶质量 + 反事实 + 排序一致性 + 滚动表现）。
  const monitor = buildStrategyMonitor(projectRoot, today, metarMax, cityStation);
  mdLines.push(...monitor.md);
  const reportMd = mdLines.join('\n');

  const processedDir = path.join(projectRoot, 'data', 'processed');
  if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });
  const reportFile = path.join(processedDir, `winrate_${today}.md`);
  fs.writeFileSync(reportFile, reportMd, 'utf8');
  logger.info('胜率报告已生成', { reportFile, samples: all.n });

  // 企业微信推送（markdown 不支持表格 → 列表形式）。
  const wecomLines = [
    `📊 **天气修正胜率报告**`,
    `样本：${all.n} 个（城市×日期×水平段）`,
    ``,
    `**总体**`,
    `- 最高温桶命中率：${top1}（${all.top1Hit}/${all.n}）`,
    `- 双桶区间命中率：${intv}（${all.intervalHit}/${all.n}）`,
    `- 平均温度误差：${maec(all)}`,
    ``,
    `**按提前量**`,
  ];
  for (const h of HORIZON_ORDER) {
    const s = stats[h];
    if (!s) continue;
    wecomLines.push(
      `- ${HORIZON_CN[h] ?? h}：命中 ${pct(s.top1Hit, s.n)} / 区间 ${pct(s.intervalHit, s.n)} / ${maec(s)}（${s.n} 样本）`,
    );
  }
  if (d0s && d3s) {
    wecomLines.push(
      ``,
      `大白话：当天预测命中率 ${pct(d0s.top1Hit, d0s.n)}，提前 3 天只有 ${pct(d3s.top1Hit, d3s.n)}，离结算越近越准。`,
    );
  }

  if (corrStats.n > 0) {
    const hitDeltaStr = hitDeltaPp >= 0 ? `+${hitDeltaPp.toFixed(0)}pp` : `${hitDeltaPp.toFixed(0)}pp`;
    const maeDeltaStr = maeDelta <= 0
      ? `改善 ${(-maeDelta).toFixed(1)}°C`
      : `恶化 ${maeDelta.toFixed(1)}°C`;
    wecomLines.push(
      ``,
      `**修正效果（未修正 → 修正后）**`,
      `- top1 命中率：${pct(rawStats.top1Hit, rawStats.n)} → ${pct(corrStats.top1Hit, corrStats.n)}（${hitDeltaStr}）`,
      `- 平均误差：${maec(rawStats)} → ${maec(corrStats)}（${maeDeltaStr}）`,
    );
  }

  wecomLines.push(``, `**按城市（命中率降序）**`);
  for (const { city, s } of cityEntries) {
    wecomLines.push(
      `- ${CITY_CN[city] ?? city}：命中 ${pct(s.top1Hit, s.n)} / 区间 ${pct(s.intervalHit, s.n)} / ${maec(s)}（${s.n} 样本）`,
    );
  }

  wecomLines.push(...monitor.wecom);

  void sendWeComMarkdown(wecomLines.join('\n')).then((ok) => {
    logger.info('企业微信推送完成', { ok });
  });

  // 6. 黑白名单自动评估：检查各城市命中率/胜率，更新 city-whitelist.json，有变更时推送通知。
  const env = loadEnv();
  const manualDisabled = parseDisabledCities(env);
  void runWhitelistEvalAndNotify(projectRoot, manualDisabled).then((result) => {
    logger.info('黑白名单评估完成', {
      blacklisted: result.disabledCities.length,
      changes: result.changedCities.length,
      disabledCities: result.disabledCities,
    });
  });
}

main();
