# 温度市场双桶区间策略 — 完整逻辑说明

> 最后更新：2026-08-12（对齐生产代码）
> 适用范围：Polymarket 城市日最高温市场（20 城），模拟盘（paper）运行中

---

## 1. 系统概览

```
Open-Meteo 多模型预报 (ECMWF/GFS/ICON + ENS 成员)
        ↓
DataHub（唯一数据生产者，30min 轮询 + 5min 偏差表刷新）
   ├─ 偏差修正（DebCalibration: bias.json 四维表 + MAE 动态权重）
   ├─ 概率分布（AdaptiveProbabilityEngine: ENS 成员频次为主、CDF 兜底）
   └─ 落盘 predictions.json（含 rawAnchorC 修正前后对照）
        ↓
MultiCityStrategy（10min 一轮，串行处理 20 城）
   ├─ 开仓：TradingDecisionEngine（双桶区间选桶 + 凯利）
   └─ 平仓：ExitStrategy（两段式）+ D1 换仓 + 结算兜底
        ↓
数据记录：trades-<city>.json / trade-journal.json / predictions.json
报告：winrate-report（每日胜率）、status-report（每 2h 持仓）
```

## 2. 开仓逻辑

### 2.1 入口门控（MultiCityStrategy.makeEntryDecision）
- 只允许 **d3 / d2**（距结算 48~72h）开仓；d1/d0 只平不买
- 同城市同目标日期已有持仓 → 跳过，防重复开仓

### 2.2 候选桶构建
- 模型概率分布（锚定温度 + 离散度）与市场真实行情（yesPrice/bid/volume）对齐
- 市场行情来自 Polymarket Gamma API（每个温度桶 = 一个独立市场）

### 2.3 决策引擎选桶（TradingDecisionEngine.decide）
1. **准入过滤**：模型概率 ≥ 0.15、价格在 0~1 之间、live 要求有交易量
2. **离散度过滤**：分布标准差 > 5°C → 不做决策（模型不确定）
3. **相邻桶对**：温度边界相连的两个桶，区间概率 `pPair = p(桶A) + p(桶B)`
4. **排序**：按 `|pPair − 买入成本|` 升序（模型与市场最一致的对优先）
5. **成本过滤**：`YES(A) + YES(B) ≤ MAX_ENTRY_COST`
6. **凯利仓位**（双桶 N=2）：
   `f* = (2·pPair − 成本) / (2 − 成本)`，f* ≤ 0 不开仓
   每笔 = 资金池 × f* × 分数凯利系数，封顶单笔上限
7. **无相邻桶对 → 回退单桶**（模型概率最高桶），`f* = (p − 价) / (1 − 价)`

### 2.4 开仓护栏（选桶后的最后三道闸）
| 护栏 | 说明 |
|---|---|
| 资金池 | live=CLOB 真实余额；paper=虚拟 100 − 全部城市已开敞口 |
| 每城敞口上限 | 超限压缩金额 |
| 最小 1 股 | 金额 < 1×买入成本 → 跳过（交易所最小 1 股；2026-08-12 由 5 股放开） |
| **最优单桶 edge 直过滤** | `max(modelProbability − yesPrice) ≥ 0.16`（只看桶对中最优单桶，屏蔽第二优桶市场价噪音） |

### 2.5 落单
- **live**：maker-first（post-only 限价单挂 best bid，超时市价回退）；两桶全部成交才记持仓，任一失败整体放弃
- **paper**：直接记录

### 2.6 当前生产参数（2026-08-12）
| 参数 | 值 | 说明 |
|---|---|---|
| `BEST_SINGLE_EDGE` | 0.16 | 最优单桶 edge 直过滤（回测双窗口最优） |
| `MAX_ENTRY_COST` | **0.75** | 双桶成本上限（0.65→0.75，2026-08-12 回测 EV 双窗口 +68~100%） |
| `MIN_MODEL_PROBABILITY` | 0.15 | 准入过滤 |
| `MAX_DISPERSION` | 5°C | 离散度过大不做决策 |
| `SWITCH_D1` / `SWITCH_THRESHOLD` | 1 / 0.30 | D1 换仓开关与阈值 |
| `KELLY_FRACTION` | 分数凯利 | 单笔仓位系数 |
| `MIN_ORDER_SHARES` | 1 股 | 开仓下限（2026-08-12 由 5 股放开，可 env 调） |

## 3. 平仓逻辑

### 3.1 持仓监控循环（10min 一轮，monitorPositions）
每笔持仓按顺序过 5 道检查：

```
① 补结算（settleDuePositions）→ 结算/平仓记录已到期的先结算
② 结算检测（settleIfResolved）→ 已收敛的判定命中/未中
③ D1 换仓（trySwitchPosition）→ 旧桶概率跌破 0.30 且引擎有新桶对 → 切换
④ 两段式离场（ExitStrategy.checkExit）→ 触发则平仓
⑤ 都不触发 → 继续持有（记录 hold 轨迹）
```

### 3.2 两段式离场（核心）
**阶段一（峰值前）——只看区间目标 0.85**
- 双桶持仓：`bid(A) + bid(B) ≥ 0.85` → 全部平仓（interval_target）
- 不到 0.85 就拿着：**不做止损、不做软止盈、不按钟点强制平**
- 单桶持仓跳过阶段一（仅阶段二覆盖）

**阶段二（峰值后）——到点市价全平**
- 条件：今天 = D0（城市日期 = 目标日）**且** 本地时间 ≥ 该城峰值最晚时间（hardExitLocalTime）
- 触发 → 市价一次性全平（peak_confirmed），不做 TWAP
- D0 限制防 D2/D1 持仓被"当天时间过峰值"误平

### 3.3 峰值时间（hardExitLocalTime）
- 来源：`config/city_peak_times.json`（当前仅 shanghai=14:00 有独立配置），其余城市用 config-loader 的 `peakTimeLocal.latest`
- 当前各城实际值：**15:00~17:00 本地时间**（夏季午后峰值，气象设定）

### 3.4 平仓执行
- **live**：liveClosePosition 卖出（maker-first，失败市价回退），成交后移除内存；失败下轮重试
- **paper**：直接 recordCloseTrade + 移除内存
- 离场价用实时 sumBid 记录，同时写 journal trace

### 3.5 结算兜底
- 结算判定时间已过（目标日 12:00 UTC + 6h）且 bid 收敛到 **≥0.9（命中）/ ≤0.1（未中）** 才判定
- 平仓后/重启失联持仓由补结算兜底，**按平仓实现价算盈亏**（2026-08-12 修复）

### 3.6 D1 换仓（SWITCH_D1）
- 触发：持仓目标日期最新预测中，旧桶对模型区间概率 ≤ 0.30，且决策引擎选出不同新桶对
- 动作：paper/live 卖旧买新，资金始终在场（与提前离场不同）
- 换仓后本轮跳过离场判断；换仓明细记入 trades（switchSell/switchBuy）

## 4. 数据记录（每笔开仓/平仓怎么留痕）

| 文件 | 内容 | 用途 |
|---|---|---|
| `data/trade-journal.json` | `evaluations[]`：每次开仓评估快照（OPEN / SKIP_BEST_SINGLE_EDGE / SKIP_MIN_5_SHARES / SKIP_NO_DECISION，含跳过原因）；`traces{}`：每笔持仓逐轮 sumBid 轨迹（opened→hold→switched→exit→settled） | 复盘每笔开仓如何进行、失败如何造成 |
| `data/trades-<city>.json` | 开/平/结算明细 + pnl + hit + exitTrigger + viaSettleBackfill | 交易统计 |
| `data/predictions.json` | 天气修正预测落盘（含 rawAnchorC） | 胜率报告 |
| `data/processed/winrate_*.md` | 每日胜率报告（城市拆分 + 修正前后对比，推送企业微信） | 效果验证 |

**journal 上限保护**：evaluations 5000 条、单笔 trace 400 点（约 2.7 天），防文件膨胀；原子写入（临时文件 + rename）。

## 5. 回测验证记录

### 5.1 最优单桶 edge（0.16）
- 回测（FILTER_BEST_SINGLE，59 市场）：全量 ROI 3.9%→26.0%、近 7 天 9.7%→27.6%（双窗口一致）
- 加密网格 0.13~0.17：0.16/0.17 为峰值；0.20 后近 7 天断崖（4.9%）；取 0.16 留缓冲
- 2026-08-12 复跑（MAX_ENTRY_COST=0.75 对齐生产）：全量 EV +0.040~0.041、近 7 天 +0.111

### 5.2 MAX_ENTRY_COST（0.65 → 0.75）
- 2026-08-12 网格：0.65→0.75 是最大跳变（EV 全量 +0.040→+0.080，近 7 天 +0.111→+0.187，ROI 翻倍）
- 0.75 之后完全平台（0.85/0.99/完全取消结果相同）——没有单的成本落在 0.75 以上
- **注意**：首次扫描（0.70~0.85 五档相同）是假象——引擎成本上限当时是硬编码 0.65，env 没传进去；已把引擎 MAX_ENTRY_COST env 化后重测

### 5.3 EXIT_SUM（0.85 止盈目标）
- 回测 0.70~0.95 六档结果逐位相同——price-history 快照粒度太粗，sumBid 直接跳变，回测区分不出
- 实盘 journal（10min 粒度，38 笔轨迹）：过 0.85 的 10 笔全部平在 0.90~1.00，无"到 0.85 后回落卖不到"的损失
- 结论：0.85 维持，需 journal 积累 2~4 周后再做细粒度逐档对比

### 5.4 已证伪的实验（不做）
- edge/价格比过滤（0.10~0.20）：ROI 9.7%→1.8%，负优化
- 单桶低价高赔率（≤0.30）：命中率 0~1.7%，ROI 全负
- EDGE_DIV 1.25（edge/买入成本）：全量 12% 但近 7 天崩到 5.7%，不稳定
- 峰值前逢高平仓低阈值（EXIT_PEAK_HIGH 0.65/0.75）：几乎不触发/负优化
- 放宽 MAX_ENTRY_COST 至 0.85+：无增量（平台期）

## 6. 当前数据状态（2026-08-12 同步）

- 76 笔记录 = 23 持仓中（08-13/14 结算）+ 36 已离场 + 17 已结算
- 08-12 平仓 15 笔：10 笔 interval_target（全部 ≥0.90）+ 5 笔 peak（4 笔为失联补平异常，1 笔正常）
- 17 笔补结算全部带 `viaSettleBackfill: true` 标记（08-09/10 正常交易补记，非失联异常）

## 7. 已知边界与待验证点

| 项 | 状态 | 说明 |
|---|---|---|
| 正期望验证 | 点估计为正，CI 跨 0 | 有最终结果样本 12~19 笔，需积累 50~100 笔（约 2 周）才有统计意义 |
| 0.85 阈值 | 维持 | 需 journal 细粒度轨迹积累后复评 |
| 阶段二峰值时间 | 无证据需改 | 正常触发样本仅 1 笔；各城 15:00~17:00 设定合理 |
| 单桶回退 | 基本不触发 | 0.16 edge 过滤后无有效单桶持仓（19 笔记录中 17 笔为历史占位垃圾） |
| 入场率瓶颈 | 候选池规模 | 66% 入场率已接近 20 城候选池上限，提高笔数靠扩市场不靠放松过滤 |
| 失联补平 | 无实质影响 | 重启失联持仓集中补平（4 笔），全为输单/死水，早走晚走无差别 |

## 8. 运维备忘

- VPS：ec2-3-255-158-132.eu-west-1.compute.amazonaws.com（PM2：datahub / strategy / status-report / daily-report / winrate-report）
- 本地同步：`npm run sync`（scp 拉取 data/ 全量）
- 回测：`npx tsx scripts/simulate-all-cities.ts`（env 开关：FILTER_BEST_SINGLE / MIN_PAIR_EDGE / MAX_ENTRY_COST / EXIT_SUM / SWITCH_D1 / SINCE_DAYS 等）
- 扫描：`node scripts/scan-edge-grid.mjs`（edge 网格）；`SCAN_DIM=cost`（成本网格）
- 参数修改后：typecheck → scp → VPS build → `pm2 startOrRestart ecosystem.config.cjs --only strategy`
