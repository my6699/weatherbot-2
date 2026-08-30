# 数据采集 API 说明文档

> 整理日期：2026-08-18

---

## 一、气象数据源（Open-Meteo）

### 1.1 确定性预报 —— `api.open-meteo.com`

**端点：** `https://api.open-meteo.com/v1/forecast`

**用途：** 拉取 ECMWF / GFS / ICON 三个模型的逐小时最高温预报。

**文件：** `src/data/DataIngestionLayer.ts`

| 方法 | 请求参数 | 说明 |
|------|---------|------|
| `fetchOpenMeteoEcmwf()` | `models=ecmwf_ifs` | ECMWF IFS HRES 高分辨率模型 |
| `fetchOpenMeteoGfs()` | `models=gfs_global` | 美国 GFS 全球预报系统 |
| `fetchOpenMeteoIcon()` | `models=icon_global` | 德国气象局 ICON 模型 |
| `fetchOpenMeteoDailyMax()` | `daily=temperature_2m_max` | 当天最高温（仅残差修正用） |

**公共参数：**
- `latitude`, `longitude` — 站点经纬度
- `hourly=temperature_2m` — 逐小时温度
- `timezone=UTC` — 时区
- `forecast_days` — 预报天数

**频率：** 每轮数据采集（datahub 定时任务）调用一次，约 20 分钟完成 20 城市 × 3 模型。

---

### 1.2 集合预报 —— `ensemble-api.open-meteo.com`

**端点：** `https://ensemble-api.open-meteo.com/v1/ensemble`

**用途：** 拉取 ECMWF 集合预报的 N 个扰动成员，用于 KDE 核密度概率拟合。

**文件：** `src/data/DataIngestionLayer.ts` → `fetchEnsembleModel()`

**参数：**
- `latitude`, `longitude`
- `hourly=temperature_2m` — 逐小时温度
- `models=ecmwf_ifs025` — 当前使用 ECMWF 51 成员
- `timezone=UTC`
- `forecast_days` — 预报天数

**响应：** 返回 `temperature_2m_member01` ~ `temperature_2m_memberNN` 逐小时数据，按 UTC 自然日分组取每成员最高温。

**频率：** 每轮数据采集调用一次，响应较大（51 成员），超时设为 15 秒。

---

### 1.3 验证脚本 —— `check-trimmed-mean.ts`

**端点：** `https://api.open-meteo.com/v1/forecast`

**用途：** 一次性验证空间修正方案（剔除主站、剩余站点去掉最高最低后平均）。

**额外参数：**
- `daily=temperature_2m_max`
- `past_days=10` — 查历史数据
- `forecast_days=0`
- `timezone=Asia/Shanghai`

---

## 二、METAR 实时温度观测

### 2.1 AVWX REST（主用）

**端点：** `https://avwx.rest/api/metar/{stationId}?options=info`

**用途：** 获取机场气象站实时温度观测，用于空间修正的"真实温度"。

**文件：** `src/data/DataIngestionLayer.ts` → `fetchMetarObservation()`

**说明：** 免费版有额度限制，返回 `Temperature` 字段（摄氏度）。

**超时：** 8 秒

---

### 2.2 CheckWX（备用）

**端点：** `https://api.checkwx.com/metar/{stationId}/decoded`

**用途：** AVWX 失败时备用。

**请求头：** `X-API-Key`（当前为空，免费版可不填）

**超时：** 8 秒

---

## 三、Polymarket 市场数据 API

### 3.1 Gamma API（市场信息）

**基础地址：** `https://gamma-api.polymarket.com`（可配置 `POLYMARKET_GAMMA_API_URL` 环境变量）

**文件：** `src/utils/polymarket-client.ts` / `src/execution/polymarket-live-client.ts`

| 端点 | 用途 | 参数 |
|------|------|------|
| `GET /events?slug={slug}` | 按 slug 查找温度市场事件 | `slug=highest-temperature-in-{city}-on-{month}-{day}-{year}` |
| `GET /markets/{marketId}` | 查询市场详情（YES/NO 价格、成交量、CLOB token ID） | marketId |

**频率：** 每轮策略评估（strategy 定时任务）调用所有已发现市场。

---

### 3.2 CLOB API（订单簿与交易）

**基础地址：** `https://clob.polymarket.com`（可配置 `POLYMARKET_CLOB_API_URL`）

**文件：** `src/utils/polymarket-client.ts` / `src/execution/polymarket-live-client.ts`

| 端点 | 用途 | 参数 |
|------|------|------|
| `GET /book?token_id={tokenId}` | 订单簿深度（bids/asks） | tokenId |
| `GET /prices-history?market={token}&interval=max&fidelity=60` | 逐小时价格历史 | token, fidelity=60 分钟 |

**频率：** 策略评估时按需调用，开仓/平仓前检查深度。

---

### 3.3 @polymarket/clob-client SDK（真实交易）

**文件：** `src/execution/polymarket-live-client.ts`

| 方法 | 用途 | 说明 |
|------|------|------|
| `createAndPostMarketOrder()` | 市价单（Taker） | 买入 YES / 卖出 YES |
| `createAndPostOrder()` | 限价单（Maker） | post-only GTC，挂单等成交 |
| `getOrder()` | 查询订单状态 | 轮询 Maker 是否成交 |
| `cancelOrder()` | 撤单 | Maker 超时未成交时撤单 |
| `getBalanceAllowance()` | 查询 USDC 余额 | 资金池基准 |
| `getOrderBook()` | 订单簿 | 离场深度检查 |
| `createOrDeriveApiKey()` | 派生 API key | 首次启动时自动派生 |

**前置条件：** `TRADING_MODE=live` + `POLYMARKET_PRIVATE_KEY` + `POLYMARKET_FUNDER_ADDRESS`

**说明：** 当前为 paper 模式，真实下单未启用。

---

### 3.4 价格历史补拉脚本

**文件：** `scripts/fetch-price-history.ts`

**用途：** 从已结算市场补拉逐桶 YES 价格历史，构建回测数据集。

**调用链：**
1. `GET https://gamma-api.polymarket.com/markets/{marketId}` → 获取 `clobTokenIds`
2. `GET https://clob.polymarket.com/prices-history?market={token}&interval=max&fidelity=60` → 逐小时价格

**请求间隔：** 150ms（防限流）

---

## 四、企业微信通知

### 4.1 群机器人 Webhook

**端点：** 由 `WECOM_WEBHOOK_URL` 环境变量指定

**文件：** `src/utils/wecom-notifier.ts`

| 方法 | 消息类型 | 用途 |
|------|---------|------|
| `sendWeComMarkdown()` | markdown | 日报/状态报告/开仓平仓通知 |
| `sendWeComText()` | text | 纯文本通知（可 @所有人） |

**限制：** 每天每个机器人 1000 条消息

**频率：** 日报每天 1 次（13:00），状态报告每 2 小时 1 次。

---

## 五、本地状态面板

### 5.1 HTTP 服务

**端点：** `http://<服务器IP>:3000`（可配置 `PORT` 环境变量）

**文件：** `scripts/status-dashboard.ts`

**用途：** 浏览器查看 PM2 进程状态、数据新鲜度、最近日志、策略决策摘要。

**说明：** 仅 VPS 部署时使用，本地开发不启动。

---

## 六、代理配置

### 6.1 系统代理探测

**文件：** `src/utils/polymarket-client.ts` / `scripts/fetch-price-history.ts`

**探测顺序：**
1. 环境变量 `HTTPS_PROXY` / `HTTP_PROXY` / `https_proxy` / `http_proxy`
2. Windows 注册表 `HKCU\...\Internet Settings\ProxyEnable` + `ProxyServer`

**用途：** 本地开发（中国网络）需要代理访问 Polymarket API；VPS（欧洲）直连。

---

## 附录：API 汇总表

| 序号 | API | 类型 | 用途 | 频率 | 超时 |
|:----:|-----|:----:|------|:----:|:----:|
| 1 | `api.open-meteo.com/v1/forecast` | 天气 | 确定性预报（ECMWF/GFS/ICON） | 每轮采集 | 10s |
| 2 | `ensemble-api.open-meteo.com/v1/ensemble` | 天气 | 集合预报（ECMWF 51 成员） | 每轮采集 | 15s |
| 3 | `avwx.rest/api/metar/{station}` | 天气 | 实时温度观测（主用） | 每轮采集 | 8s |
| 4 | `api.checkwx.com/metar/{station}/decoded` | 天气 | 实时温度观测（备用） | 失败时 | 8s |
| 5 | `gamma-api.polymarket.com/events` | 市场 | 查找温度市场事件 | 策略评估 | 10s |
| 6 | `gamma-api.polymarket.com/markets/{id}` | 市场 | 查询市场详情 | 策略评估 | 10s |
| 7 | `clob.polymarket.com/book` | 市场 | 订单簿深度 | 开仓前 | 10s |
| 8 | `clob.polymarket.com/prices-history` | 市场 | 价格历史（回测用） | 一次性脚本 | 重试 |
| 9 | `@polymarket/clob-client` SDK | 交易 | 下单/撤单/查单/余额 | 开平仓时 | — |
| 10 | 企业微信 Webhook | 通知 | 日报/状态/开平仓推送 | 定时 + 触发 | 10s |
| 11 | 本地 HTTP 3000 端口 | 监控 | 状态面板（VPS 部署） | 持续运行 | — |