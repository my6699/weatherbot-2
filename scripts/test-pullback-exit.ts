// 测试用例：见顶回落止盈（PULLBACK=0.05，无成本门槛）能否正确触发平仓。
//
// 逻辑（与生产 ExitStrategy 增量逻辑保持一致）：
//   1. 每次轮询喂入当前双桶 bid 之和 sumBid；
//   2. sumBid > runningPeak → 创新高，更新峰值，不平仓；
//   3. 否则若 sumBid <= runningPeak × (1 - 回落阈值) → 触发平仓。
//   无成本门槛：跌破成本回落 5% 也割肉离场（回测 18 笔：5% 无门槛 Δ+$7.32，
//   3% 无门槛几乎零变化；10 分钟粒度下价格止损已取消，割肉交给见顶回落）。
//
// 运行：npx tsx scripts/test-pullback-exit.ts

import fs from 'node:fs';
import path from 'node:path';

// ==================== 被测逻辑：状态化见顶回落跟踪器（无成本门槛） ====================

class PullbackTracker {
  private peak = 0;

  constructor(private readonly pullback: number) {}

  /** 当前跟踪到的持仓期峰值（测试/调试用）。 */
  get peakValue(): number {
    return this.peak;
  }

  /** 喂入一个采样，返回触发平仓时的卖出价；未触发返回 null。 */
  onSample(sumBid: number): number | null {
    if (sumBid > this.peak) {
      this.peak = sumBid; // 创新高：重置峰值，继续持有
      return null;
    }
    if (this.peak > 0 && sumBid <= this.peak * (1 - this.pullback)) {
      return sumBid; // 从峰值回落超过阈值 → 平仓（无成本门槛，跌破成本也割肉）
    }
    return null;
  }
}

// ==================== 断言工具 ====================

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${label}${detail ? `（实际：${detail}）` : ''}`);
  }
}

/** 完整跑一遍序列，返回第一次触发的卖出价（无触发返回 null）。 */
function runOnce(pullback: number, series: number[]): number | null {
  const t = new PullbackTracker(pullback);
  for (const s of series) {
    const exit = t.onSample(s);
    if (exit !== null) return exit;
  }
  return null;
}

// ==================== 用例 1：主场景——冲高后回落 5%（paris 式） ====================
console.log('用例1：开仓成本 0.45，冲高到 0.63 后回落 5% → 应触发平仓');
{
  // 10 分钟粒度序列：0.40 → 0.52 → 0.60 → 0.63(峰值) → 0.62 → 0.61 → 0.59
  // 5% 回落线 = 0.63×0.95 = 0.5985，0.59 首次破线
  const series = [0.4, 0.52, 0.6, 0.63, 0.62, 0.61, 0.59];
  const r = runOnce(0.05, series);
  assert(r !== null, '回落 5% 应触发平仓');
  assert(r !== null && Math.abs(r - 0.59) < 1e-9, `卖出价应为 0.59（实测 ${r}）`);
  // 逐采样明细
  const t = new PullbackTracker(0.05);
  console.log('  逐步过程：');
  for (const s of series) {
    const peak = t.peakValue;
    const exit = t.onSample(s);
    console.log(
      `    sumBid=${s.toFixed(3)} 峰值=${peak.toFixed(3)} 回落线=${(peak * 0.95).toFixed(3)} → ${exit !== null ? `🔔 平仓 @${exit}` : '继续持有'}`,
    );
  }
}

// ==================== 用例 2：回落不足 5% → 不触发 ====================
console.log('\n用例2：从峰值 0.60 只回落 2%（0.59/0.585）→ 不应触发');
{
  const series = [0.5, 0.6, 0.59, 0.585];
  assert(runOnce(0.05, series) === null, '回落 2% 不触发平仓');
}

// ==================== 用例 3：中途小回落后又创新高 → 峰值跟随新高，不误触发 ====================
console.log('\n用例3：0.50 见顶回落 2%（0.49）后又创新高 0.55，再回落 → 应以 0.55 为峰值判断');
{
  const series = [0.4, 0.5, 0.49, 0.55, 0.54, 0.52]; // 0.55×0.95=0.5225，0.52 触发
  const r = runOnce(0.05, series);
  assert(r !== null, '以新高 0.55 为峰值，回落 5% 后应触发');
  assert(r !== null && Math.abs(r - 0.52) < 1e-9, `卖出价应为 0.52（实测 ${r}）`);
}

// ==================== 用例 4：回落已跌破成本 → 无门槛也触发（割肉离场） ====================
console.log('\n用例4：成本 0.60，峰值 0.65，跌到 0.58（< 成本且过 5% 回落线 0.6175）→ 应触发割肉');
{
  const series = [0.6, 0.65, 0.58, 0.55];
  const r = runOnce(0.05, series);
  assert(r !== null && Math.abs((r ?? 0) - 0.58) < 1e-9, `跌破成本回落 5% 也触发（卖出价 0.58，实测 ${r}）`);
}

// ==================== 用例 5：开仓后一路阴跌（从没站上成本）→ 无门槛下首采样后回落即触发 ====================
console.log('\n用例5：成本 0.50，序列 0.46→0.44→0.42→0.40 一路阴跌 → 0.42 破 5% 线即割肉（0.46×0.95=0.437）');
{
  const series = [0.46, 0.44, 0.42, 0.4];
  const r = runOnce(0.05, series);
  assert(r !== null && Math.abs((r ?? 0) - 0.42) < 1e-9, `一路阴跌也触发割肉（卖出价 0.42，实测 ${r}）`);
}

// ==================== 用例 6：赢家一路创新高到 0.90 → 不触发，0.85 区间目标先到 ====================
console.log('\n用例6：成本 0.45，序列 0.50→0.90 一路创新高 → 不应触发（0.85 目标会先平仓）');
{
  const series = [0.5, 0.6, 0.72, 0.8, 0.9];
  assert(runOnce(0.05, series) === null, '持续创新高，回落规则不触发');
}

// ==================== 用例 7：边界——恰好回落 5%（相等）应触发 ====================
console.log('\n用例7：峰值 0.60，回落线 = 0.60×0.95 = 0.57，恰好跌到 0.57 → 应触发');
{
  const series = [0.5, 0.6, 0.57];
  const r = runOnce(0.05, series);
  assert(r !== null && Math.abs((r ?? 0) - 0.57) < 1e-9, `恰好 5% 回落触发（卖出价 ${r}）`);
}

// ==================== 复杂回归场景：10 分钟频率模拟 ====================
// 用更长、更贴近实盘节奏的序列（爬升/震荡/冲高/回落/横盘/噪声）验证跟踪器，
// 另含"双桶 0.85 目标优先于回落"的组合退出回归。

/** 组合退出模拟：0.85 区间目标优先、见顶回落其次，返回先触发的退出。 */
function simulateExits(
  pullback: number,
  series: number[],
): { kind: 'interval' | 'pullback' | 'baseline'; price: number | null; at: number } {
  const tracker = new PullbackTracker(pullback);
  for (let i = 0; i < series.length; i++) {
    const s = series[i]!;
    if (s >= 0.85) return { kind: 'interval', price: s, at: i }; // 区间目标优先
    const exit = tracker.onSample(s);
    if (exit !== null) return { kind: 'pullback', price: exit, at: i };
  }
  return { kind: 'baseline', price: null, at: -1 };
}

// 用例 8：多阶段长序列（爬升→高位震荡→冲高→回落触发）
console.log('\n用例8：多阶段序列，成本 0.55，峰值 0.65，回落 5% 触发且只在首次破线触发');
{
  const series = [
    0.48, 0.51, 0.53, 0.52, 0.54, 0.57, 0.56, 0.58, 0.60, 0.62, 0.64, 0.65, // 爬升到峰值
    0.64, 0.63, 0.62, 0.615, // 回落：0.615 破线 0.65×0.95=0.6175 才触发
  ];
  const t = new PullbackTracker(0.05);
  let triggerIdx = -1;
  let triggerPrice: number | null = null;
  for (let i = 0; i < series.length; i++) {
    const exit = t.onSample(series[i]!);
    if (exit !== null) { triggerIdx = i; triggerPrice = exit; break; }
  }
  assert(triggerPrice !== null, '应触发平仓');
  assert(triggerPrice !== null && Math.abs(triggerPrice - 0.615) < 1e-9, `触发价应为 0.615（实测 ${triggerPrice}）`);
  assert(triggerIdx === 15, `应在第 15 个采样触发（首次跌破回落线），实际 ${triggerIdx}`);
  const combo = simulateExits(0.05, series);
  assert(combo.kind === 'pullback', `组合退出应判为 pullback（实测 ${combo.kind}）`);
}

// 用例 9：噪声赢家——一路爬升到 0.85+，穿插 ≤2% 回落，回落不触发、0.85 目标先平
console.log('\n用例9：噪声赢家，成本 0.50，一路到 0.85，回落规则不触发、0.85 先到');
{
  const series = [0.50, 0.52, 0.51, 0.53, 0.55, 0.54, 0.56, 0.58, 0.57, 0.59, 0.61, 0.60,
    0.62, 0.64, 0.63, 0.65, 0.67, 0.66, 0.68, 0.70, 0.69, 0.71, 0.73, 0.72,
    0.74, 0.76, 0.75, 0.77, 0.79, 0.78, 0.80, 0.82, 0.81, 0.83, 0.85];
  assert(runOnce(0.05, series) === null, '全程无 5% 回落，回落规则不触发');
  const combo = simulateExits(0.05, series);
  assert(combo.kind === 'interval' && combo.at === series.length - 1, `0.85 目标在最后采样触发（实测 ${combo.kind} @${combo.at}）`);
}

// 用例 10：精密边界批量（阈值 0.02/0.03/0.05/0.10，峰值 0.60）
console.log('\n用例10：回落线上下 0.0001 的精密边界（多阈值）');
{
  const P = 0.6;
  for (const pb of [0.02, 0.03, 0.05, 0.1]) {
    const line = P * (1 - pb);
    const above = +(line + 0.0001).toFixed(6);
    const below = +(line - 0.0001).toFixed(6);
    assert(runOnce(pb, [0.5, P, above]) === null, `pb=${pb.toFixed(2)}：线上方 ${above}（>线）不触发`);
    const r = runOnce(pb, [0.5, P, above, below]);
    assert(r !== null && Math.abs((r ?? 0) - below) < 1e-6, `pb=${pb.toFixed(2)}：恰好过线 ${below} 触发（实测 ${r}）`);
  }
}

// 用例 11：横盘（连续等于峰值）后再回落 → 正常触发
console.log('\n用例11：横盘于峰值后再回落 → 应触发');
{
  const r = runOnce(0.05, [0.5, 0.6, 0.6, 0.6, 0.56]);
  assert(r !== null && Math.abs((r ?? 0) - 0.56) < 1e-9, `触发价 0.56（0.6×0.95=0.57 线，实测 ${r}）`);
}

// 用例 12：连续跌破线时取"首个"采样，而非最深处
console.log('\n用例12：连续跌破线时取首个采样');
{
  const r = runOnce(0.05, [0.5, 0.6, 0.581, 0.579, 0.57]);
  assert(r !== null && Math.abs((r ?? 0) - 0.57) < 1e-9, `首个触发价 0.57（0.6×0.95=0.57 线，实测 ${r}）`);
}

// 用例 13：无门槛——回到成本价也触发（只要过 5% 回落线）
console.log('\n用例13：峰值 0.60 回落到成本价 0.50（< 回落线 0.57）→ 无门槛下应触发割肉');
{
  const r = runOnce(0.05, [0.5, 0.6, 0.5]);
  assert(r !== null && Math.abs((r ?? 0) - 0.5) < 1e-9, `跌破成本也触发（卖出价 0.50，实测 ${r}）`);
}

// 用例 14：空序列 / 单采样 → 不触发、不崩溃
console.log('\n用例14：空序列与单采样');
{
  assert(runOnce(0.05, []) === null, '空序列不触发');
  assert(runOnce(0.05, [0.5]) === null, '单采样不触发');
}

// 用例 15：真实数据回归——paris 08-09 实际 10 分钟轨迹（combined.log 存在才跑）
console.log('\n用例15：真实数据回归（paris 08-09，combined.log 10 分钟轨迹）');
{
  const tradesFile = path.join('data', 'trades-paris.json');
  const logFile = path.join('logs', 'combined.log');
  if (!fs.existsSync(tradesFile) || !fs.existsSync(logFile)) {
    console.log('  ⏭️  data/trades-paris.json 或 logs/combined.log 缺失，跳过真实数据回归');
  } else {
    const trades = JSON.parse(fs.readFileSync(tradesFile, 'utf8')) as Array<Record<string, unknown>>;
    const pos = trades.find((t) => t.status === 'closed' && t.switched !== true && (t.entryPrice as number) > 0.05);
    if (!pos) {
      console.log('  ⏭️  trades-paris.json 无符合条件的已平仓单，跳过');
    } else {
      const id = pos.id as string;
      const cost = pos.entryPrice as number;
      const pts: Array<{ t: number; sumBid: number }> = [];
      for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
        if (!line.includes('"sumBid"')) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj.positionId !== id || typeof obj.sumBid !== 'number' || !obj.timestamp) continue;
          // 日志时间戳为 UTC 墙钟（"2026-08-09 12:00:00"），需补 'Z' 按 UTC 解析。
          const ts = Date.parse((obj.timestamp as string).replace(' ', 'T') + 'Z');
          pts.push({ t: ts, sumBid: obj.sumBid as number });
        } catch { /* skip */ }
      }
      if (pts.length < 10) {
        console.log(`  ⏭️  paris 轨迹仅 ${pts.length} 个采样，跳过`);
      } else {
        pts.sort((a, b) => a.t - b.t);
        const tracker = new PullbackTracker(0.05);
        let exitPrice: number | null = null;
        let exitAt: Date | null = null;
        for (const p of pts) {
          const e = tracker.onSample(p.sumBid);
          if (e !== null) { exitPrice = e; exitAt = new Date(p.t); break; }
        }
        assert(exitPrice !== null, 'paris 真实轨迹应触发回落平仓（无成本门槛）');
        if (exitPrice !== null && exitAt) {
          console.log(`    真实轨迹 ${pts.length} 采样，成本 ${cost} → 🔔 平仓 @${exitPrice.toFixed(3)}，${exitAt.toISOString().slice(5, 16).replace('T', ' ')} UTC`);
        }
      }
    }
  }
}

// ==================== 汇总 ====================
console.log(`\n===== 测试结果：${passed} 通过 / ${failed} 失败 =====`);
if (failed > 0) process.exit(1);
