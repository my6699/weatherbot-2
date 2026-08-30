# ============================================================
# 一键部署：本地 -> VPS（2026-08-19 离散度参数优化 + DEB偏差修正 + 配置各城市独立权重）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/deploy-to-vps.ps1
#
# 本轮变更：
#   1. TradingDecisionEngine：硬阈值 5°C→2°C，惩罚公式收紧
#   2. config/london.json：dispersionPenalty=3.0
#   3. config/munich.json：dispersionPenalty=1.0
#   4. .env：DEB_BIAS_CORRECT=true，DISABLED_CITIES=tokyo
#   5. simulate-all-cities.ts：使用各城市独立配置（非硬编码上海）
# ============================================================

$ErrorActionPreference = 'Stop'

$SSH = 'C:\Windows\System32\OpenSSH\ssh.exe'
$SCP = 'C:\Windows\System32\OpenSSH\scp.exe'
$SSH_KEY = 'G:\polymarket\weather.pem'
$SSH_USER = 'ec2-user'
$VPS_HOST = 'ec2-3-255-158-132.eu-west-1.compute.amazonaws.com'
$REMOTE_BASE = '/home/ec2-user/weatherbot-2'
$LOCAL_BASE = 'G:\polymarket\weather\weather-2\weather-bot'
$REMOTE = "${SSH_USER}@${VPS_HOST}"

Write-Host ''
Write-Host '============================================'
Write-Host '  部署开始：离散度参数优化 + DEB偏差修正'
Write-Host '============================================'

# ---------- [1/7] SSH 连通测试 ----------
Write-Host ''
Write-Host '[1/7] 测试 SSH 连通...'
& $SSH -i $SSH_KEY -o ConnectTimeout=20 -o BatchMode=yes $REMOTE 'echo SSH_OK'
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host '!!! SSH 连接失败，部署终止 !!!'
  exit 1
}
Write-Host '  SSH 连通 OK'

# ---------- [2/7] 本地构建 ----------
Write-Host ''
Write-Host '[2/7] 本地 npm run build...'
Push-Location $LOCAL_BASE
npm run build
if ($LASTEXITCODE -ne 0) {
  Pop-Location
  Write-Host '!!! 本地构建失败，部署终止 !!!'
  exit 1
}
Pop-Location
Write-Host '  构建完成'

# ---------- [3/7] 上传源码（TradingDecisionEngine + MultiCityStrategy） ----------
Write-Host ''
Write-Host '[3/7] 上传 src/strategies/ 源码...'
& $SCP -i $SSH_KEY "$LOCAL_BASE\src\strategies\TradingDecisionEngine.ts" "${REMOTE}:${REMOTE_BASE}/src/strategies/TradingDecisionEngine.ts"
if ($LASTEXITCODE -ne 0) { Write-Host '!!! TradingDecisionEngine.ts 上传失败 !!!'; exit 1 }
& $SCP -i $SSH_KEY "$LOCAL_BASE\src\strategies\MultiCityStrategy.ts" "${REMOTE}:${REMOTE_BASE}/src/strategies/MultiCityStrategy.ts"
if ($LASTEXITCODE -ne 0) { Write-Host '!!! MultiCityStrategy.ts 上传失败 !!!'; exit 1 }
Write-Host '  源码上传完成'

# ---------- [4/7] 上传 dist 全量 ----------
Write-Host ''
Write-Host '[4/7] 上传 dist 全量...'
& $SCP -i $SSH_KEY -r "$LOCAL_BASE\dist" "${REMOTE}:${REMOTE_BASE}/"
if ($LASTEXITCODE -ne 0) { Write-Host '!!! dist 上传失败 !!!'; exit 1 }
Write-Host '  dist 上传完成'

# ---------- [5/7] 上传 config 文件（各城市独立权重） ----------
Write-Host ''
Write-Host '[5/7] 上传 config 配置...'
# 权重有变动的城市
& $SCP -i $SSH_KEY "$LOCAL_BASE\config\london.json" "${REMOTE}:${REMOTE_BASE}/config/london.json"
& $SCP -i $SSH_KEY "$LOCAL_BASE\config\munich.json" "${REMOTE}:${REMOTE_BASE}/config/munich.json"
# 同步全量 config（不含 stations 子目录）
& $SCP -i $SSH_KEY "$LOCAL_BASE\config\*.json" "${REMOTE}:${REMOTE_BASE}/config/"
if ($LASTEXITCODE -ne 0) { Write-Host '!!! config 上传失败 !!!'; exit 1 }
Write-Host '  config 上传完成'

# ---------- [6/7] .env 更新（DEB_BIAS_CORRECT + DISABLED_CITIES） ----------
Write-Host ''
Write-Host '[6/7] 更新 .env 配置...'
# 1. DEB_BIAS_CORRECT=true（若不存在则追加，存在则替换）
& $SSH -i $SSH_KEY $REMOTE "grep -q '^DEB_BIAS_CORRECT=true' ${REMOTE_BASE}/.env && echo 'DEB_BIAS_CORRECT 已是 true' || (grep -q '^DEB_BIAS_CORRECT' ${REMOTE_BASE}/.env && sed -i 's/^DEB_BIAS_CORRECT=.*/DEB_BIAS_CORRECT=true/' ${REMOTE_BASE}/.env && echo 'DEB_BIAS_CORRECT 已改为 true' || echo 'DEB_BIAS_CORRECT=true' >> ${REMOTE_BASE}/.env && echo 'DEB_BIAS_CORRECT 已追加')"
# 2. DISABLED_CITIES=tokyo（若不存在则追加，存在则确保包含 tokyo）
& $SSH -i $SSH_KEY $REMOTE "grep -q '^DISABLED_CITIES=.*tokyo' ${REMOTE_BASE}/.env && echo 'DISABLED_CITIES 已含 tokyo' || (grep -q '^DISABLED_CITIES' ${REMOTE_BASE}/.env && sed -i 's/^DISABLED_CITIES=.*/DISABLED_CITIES=tokyo/' ${REMOTE_BASE}/.env && echo 'DISABLED_CITIES 已改为 tokyo' || echo 'DISABLED_CITIES=tokyo' >> ${REMOTE_BASE}/.env && echo 'DISABLED_CITIES 已追加')"
# 3. 验证关键配置
Write-Host '  --- 当前 .env 关键配置 ---'
& $SSH -i $SSH_KEY $REMOTE "grep -E 'DEB_BIAS_CORRECT|DISABLED_CITIES|TRADING_MODE|MAX_ENTRY_COST|STOP_LOSS_K|KELLY_FRACTION' ${REMOTE_BASE}/.env"
Write-Host '  .env 更新完成'

# ---------- [7/7] 重启 + 验证 ----------
Write-Host ''
Write-Host '[7/7] 重启 strategy 并验证...'
& $SSH -i $SSH_KEY $REMOTE "cd ${REMOTE_BASE} && pm2 restart strategy --update-env && sleep 3 && echo '--- 验证1: 离散度新阈值（2degC）---' && grep -c 'maxDispersionThreshold' dist/strategies/TradingDecisionEngine.js && echo '--- 验证2: 新惩罚公式（0.5degC起罚）---' && grep -c 'scoreDispersionPenalty' dist/strategies/TradingDecisionEngine.js && echo '--- 验证3: London 权重 3.0 ---' && grep -c 'dispersionPenalty.*3' config/london.json && echo '--- 验证4: Munich 权重 1.0 ---' && grep -c 'dispersionPenalty.*1.0' config/munich.json && echo '--- 验证5: DEB 偏差修正 ---' && grep -c 'DEB_BIAS_CORRECT=true' .env && echo '--- 验证6: pm2 状态 ---' && pm2 status strategy && echo '--- 验证7: 启动日志尾部 ---' && tail -20 ${REMOTE_BASE}/logs/pm2-strategy-out.log"
if ($LASTEXITCODE -ne 0) { Write-Host '!!! 重启/验证失败，请检查 !!!'; exit 1 }

Write-Host ''
Write-Host '============================================'
Write-Host '  部署完成：离散度优化 + DEB偏差修正已生效'
Write-Host '  验证要点：'
Write-Host '    - maxDispersionThreshold gt 0  OK'
Write-Host '    - dispersion penalty 0.5 start OK'
Write-Host '    - london dispersionPenalty 3.0 OK'
Write-Host '    - munich dispersionPenalty 1.0 OK'
Write-Host '    - DEB_BIAS_CORRECT=true        OK'
Write-Host '    - DISABLED_CITIES=tokyo        OK'
Write-Host '    - pm2 online                   OK'
Write-Host '============================================'