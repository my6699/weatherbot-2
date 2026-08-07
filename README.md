# Polymarket 上海温度预测量化交易系统（weather-2）

基于 **多源气象数据 + 城市独立校正 + 空间加权修正** 的 Polymarket 日最高温度市场量化交易机器人。

核心玩法：**不持仓到结算**。在 D-3 到 D-2 根据多因子条件选桶买入，利用市场情绪波动、模型更新、订单流变化的价格波动，在 D0 当天最高温真正出现前（上海时间 14:00 前）提前离场止盈。

---

## 一、系统架构

```
┌─────────────────────────────────────────────────────────┐
│                     DataHubService（唯一数据生产者）        │
│                                                         │
│  Open-Meteo (ECMWF/GFS/ICON) ─┐                         │
│  METAR 实时观测 ──────────────┤                         │
│                              ▼                         │
│  DataIngestionLayer → BiasCharacterizationLibrary      │
│      （多源接入）     （城市独立偏差库）                    │
│                              ▼                         │
│  SpatialCorrectionEngine → AdaptiveProbabilityEngine    │
│      （周边站点空间修正）      （温度桶概率分布）            │
│                              ▼                         │
│                    写入 Redis（weather:<city>:<horizon>）│
└─────────────────────────────────────────────────────────┘
                              │ 读取
                              ▼
┌─────────────────────────────────────────────────────────┐
│  StrategyInstance（每城市一个独立进程，PM2 管理）          │
│                                                         │
│  读 Redis → 数据新鲜度检查 → TradingDecisionEngine       │
│       （7 因子多因子选桶打分）                            │
│  → paper/live 下单 → ExitStrategy（D0 提前离场）          │
└─────────────────────────────────────────────────────────┘
```

**核心原则**：
- 每个城市必须使用**独立的数据校正**（偏差库、空间权重），禁止跨城市共用。
- 禁止简单平均 ensemble 成员，必须经过空间修正后进入概率引擎。

---

## 二、目录结构

```
weather-bot/
├── src/
│   ├── data/
│   │   ├── DataHubService.ts              # 唯一数据生产者（调度所有数据模块）
│   │   ├── DataIngestionLayer.ts          # 多源气象数据接入
│   │   ├── BiasCharacterizationLibrary.ts # 每城市独立偏差库
│   │   ├── SpatialCorrectionEngine.ts     # 【核心】周边站点空间加权修正
│   │   ├── AdaptiveProbabilityEngine.ts   # 温度桶概率分布
│   │   └── redis-config.ts                # Redis 连接与缓存键管理
│   ├── strategies/
│   │   ├── StrategyInstance.ts            # 城市独立策略进程
│   │   ├── TradingDecisionEngine.ts       # 7 因子多因子选桶
│   │   └── ExitStrategy.ts                # D0 提前离场
│   ├── common/
│   │   ├── types.ts                       # 全系统类型定义
│   │   ├── logger.ts                      # winston 日志
│   │   └── config-loader.ts               # .env + JSON 配置校验
│   └── utils/
│       ├── kelly.ts                       # 凯利公式仓位管理
│       ├── time.ts                        # 时区/D-N/峰值时间
│       ├── station-utils.ts               # Haversine 距离 / IDW / 高斯权重
│       └── polymarket-client.ts           # Polymarket 市场数据读取
├── config/
│   ├── shanghai.json                      # 上海城市配置（示例，可复制扩展）
│   ├── stations/
│   │   └── zspd_nearby.json               # ZSPD 周边站点配置
│   └── city_peak_times.json               # 各城市 D0 峰值时间与离场参数
├── ecosystem.config.js                    # PM2 进程管理
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

---

## 三、从零安装（VPS / 本地）

### 1. 安装 Node.js 20+ 和 Redis

```bash
# Ubuntu VPS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs redis-server
```

### 2. 克隆并安装依赖

```bash
git clone <你的仓库地址> weather-2
cd weather-2
npm install
```

国内网络慢可用镜像：

```bash
npm install --registry=https://registry.npmmirror.com
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env：
#   TRADING_MODE=paper   # 先跑模拟盘！
#   REDIS_URL=redis://127.0.0.1:6379
```

### 4. 类型检查（确认代码无误）

```bash
npm run typecheck
```

### 5. 启动 Redis

```bash
sudo systemctl enable redis-server
sudo systemctl start redis-server
```

---

## 四、运行（开发模式）

### 终端 1：启动 DataHub（数据生产者）

```bash
npm run dev:datahub
```

### 终端 2：启动上海策略进程

```bash
npm run dev:strategy
```

看到日志里出现 `【PAPER】模拟开仓` 即表示策略正常运行（paper 模式不真实下单）。

---

## 五、运行（生产模式，PM2）

### 1. 编译 TypeScript

```bash
npm run build
```

### 2. 启动 PM2

```bash
npm run pm2:start
```

### 3. 查看日志

```bash
npm run pm2:logs
```

### 4. 停止

```bash
npm run pm2:stop
```

PM2 进程布局（ecosystem.config.js）：

| 进程名 | 作用 |
|--------|------|
| datahub | 唯一数据生产者，1 个实例 |
| strategy-shanghai | 上海策略进程（每城市独立） |

---

## 六、从 paper 切换到 live

> ⚠️ 强烈建议先跑至少 2 周 paper trading 验证胜率，再切 live。

1. 编辑 `.env`：
   ```env
   TRADING_MODE=live
   POLYMARKET_PRIVATE_KEY=你的私钥
   POLYMARKET_FUNDER_ADDRESS=你的钱包地址
   ```
2. `requireLiveTradingSafety()` 会在 live 模式缺少关键配置时阻止启动。
3. 重启策略进程。

---

## 七、核心机制说明

### 1. 空间加权修正（SpatialCorrectionEngine）

以 ZSPD（结算站）为中心，读取周边站点（虹桥、宝山、徐家汇、南汇等），
计算每个站点到主站点的 Haversine 距离 → 按 IDW/高斯核生成权重 → 加权平均修正主站点预报。

每个城市的站点列表、权重参数独立配置（`config/stations/<city>_nearby.json`）。

### 2. 城市独立偏差库（BiasCharacterizationLibrary）

按 **城市 + 数据源 + 季节 + 天气类型** 四维分组记录系统性偏差。
市场结算后回填实际温度，动态更新偏差库。
样本不足时自动回退（精确 → 按城市+数据源 → 不做修正）。

### 3. 7 因子选桶（TradingDecisionEngine）

| 因子 | 含义 |
|------|------|
| 尾部便宜度 | YES ≤ 0.15 或 NO ≥ 0.45 |
| 模型更新冲击 | 概率较上次上升 >3% |
| 订单流/情绪 | 成交量 + 订单簿失衡 |
| 空间修正支持 | 周边站点修正置信度 |
| 相对价值 | 相邻桶价格不合理 |
| 概率差 | edge 即使 3-5% 也给分 |
| 离散度 | >5°C 跳过决策 |

### 4. D0 提前离场（ExitStrategy）

| 触发 | 条件 |
|------|------|
| 硬性清仓 | 到达 14:00，全部平仓 |
| 止损 | 价格跌破入场价 85% |
| 软止盈 | 峰值前 1.5h 窗口 + 盈利 ≥25%，TWAP 分批 |
| 情绪高潮 | 订单簿失衡 >0.6 且涨 >10%，卖一半 |

---

## 八、新增城市（模板方式）

1. 复制 `config/shanghai.json` → `config/<city>.json`，改城市参数。
2. 复制 `config/stations/zspd_nearby.json` → `config/stations/<icao>_nearby.json`，填该城周边站点。
3. 在 `config/city_peak_times.json` 添加该城市峰值时间。
4. 在 `src/strategies/StrategyInstance.ts` 的 `main()` 里加城市参数。
5. 在 `ecosystem.config.js` 加一个 strategy-<city> 进程。
6. 启动即可，**核心框架零改动**。

---

## 九、故障排查

| 问题 | 原因 | 解决 |
|------|------|------|
| 日志显示"数据已过期，暂停开仓" | DataHub 没跑 / Redis 数据超 1h | 确认 DataHub 进程在跑 |
| 日志显示"Redis 连接失败" | Redis 没启动 | `systemctl start redis-server` |
| 所有数据源都失败 | 网络问题或 API 限额 | 检查 `logs/error.log`，等待自动恢复 |
| npm 警告 Node 版本不兼容 | 本机 Node 版本过新 | 安装 Node 20 LTS（`nvm install 20`） |
