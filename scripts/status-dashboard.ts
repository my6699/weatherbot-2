/**
 * 状态面板 Web 服务，浏览器打开 http://<服务器IP>:3000 即可查看。
 *
 * 页面内容：
 *   - PM2 进程状态（datahub / strategy / legacy）
 *   - Redis 天气数据（各水平段的数据新鲜度）
 *   - 最近日志（combined.log 最新条目）
 *   - 策略决策摘要（最近一次开仓/平仓）
 */

import http from 'node:http';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT) || 3000;
const LOG_DIR = process.env.LOG_DIR || 'logs';
const PROJECT_ROOT = process.cwd();

// ==================== API 处理器 ====================

function getPm2Status(): Record<string, unknown> {
  try {
    const out = execSync('pm2 jlist', {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const processes = JSON.parse(out) as Array<Record<string, unknown>>;
    return {
      processes: processes.map((p) => ({
        name: p.name,
        status: p.pm2_env?.status,
        pid: p.pid,
        uptime: p.pm2_env?.pm_uptime,
        restart_time: p.pm2_env?.restart_time,
        monit: p.monit,
      })),
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function getRedisStatus(): Record<string, unknown> {
  const script = `
const Redis = require('ioredis');
const c = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: true });
c.connect().then(async () => {
  const keys = await c.keys('*');
  const now = Date.now();
  const result = [];
  for (const k of keys) {
    if (k.endsWith(':ts')) {
      const ts = await c.get(k);
      const age = (now - Number(ts)) / 1000;
      const ttl = await c.ttl(k);
      result.push({ key: k, ageSec: Math.round(age), ttlSec: ttl });
    } else {
      const ttl = await c.ttl(k);
      result.push({ key: k, ttlSec: ttl });
    }
  }
  console.log(JSON.stringify({ keys: result, count: keys.length }));
  c.quit();
}).catch(e => { console.log(JSON.stringify({ error: e.message })); c.quit(); });
`;
  try {
    const out = execSync(`node -e "${script.replace(/"/g, '\\"').replace(/`/g, '\\`')}"`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lastLine = out.trim().split('\n').pop() ?? '{}';
    return JSON.parse(lastLine) as Record<string, unknown>;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function getRecentLogs(lines = 30): Record<string, unknown> {
  try {
    const logFile = path.join(PROJECT_ROOT, LOG_DIR, 'combined.log');
    if (!fs.existsSync(logFile)) return { logs: [] };

    const content = fs.readFileSync(logFile, 'utf-8');
    const allLines = content.trim().split('\n').filter(Boolean);
    const recent = allLines.slice(-lines);

    return {
      logs: recent.map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return { raw: line };
        }
      }),
      totalLines: allLines.length,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function getSummary(): Record<string, unknown> {
  const pm2 = getPm2Status();
  const redis = getRedisStatus();
  const logs = getRecentLogs(5);

  // 从日志中提取最新策略决策
  const decisions = (logs.logs as Array<Record<string, unknown>>)
    ?.filter((l) => l.message === '【PAPER】模拟开仓' || l.message === '仓位已全部平仓（paper）')
    .slice(-3);

  return {
    pm2,
    redis,
    recentDecisions: decisions,
    timestamp: new Date().toISOString(),
  };
}

// ==================== HTML 页面 ====================

function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Weather Bot 状态面板</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 20px; }
    h1 { font-size: 24px; margin-bottom: 20px; color: #38bdf8; }
    h2 { font-size: 18px; margin: 20px 0 10px; color: #94a3b8; border-bottom: 1px solid #1e293b; padding-bottom: 6px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
    .card { background: #1e293b; border-radius: 8px; padding: 16px; }
    .card h3 { font-size: 14px; color: #64748b; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
    .status-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
    .online { background: #166534; color: #86efac; }
    .offline { background: #7f1d1d; color: #fca5a5; }
    .stopped { background: #422006; color: #fdba74; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    td, th { padding: 6px 8px; text-align: left; border-bottom: 1px solid #334155; }
    th { color: #64748b; font-weight: 500; }
    .log-entry { font-size: 12px; padding: 4px 0; border-bottom: 1px solid #1e293b; line-height: 1.5; }
    .log-time { color: #64748b; }
    .log-msg { color: #e2e8f0; }
    .log-warn { color: #fbbf24; }
    .log-error { color: #f87171; }
    .fresh { color: #86efac; }
    .stale { color: #f87171; }
    .value { font-size: 24px; font-weight: 700; }
    .label { font-size: 12px; color: #64748b; }
    #loading { text-align: center; padding: 40px; color: #64748b; }
    .refresh-btn { background: #334155; color: #e2e8f0; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px; margin-top: 10px; }
    .refresh-btn:hover { background: #475569; }
    .header-bar { display: flex; justify-content: space-between; align-items: center; }
    .last-update { font-size: 12px; color: #64748b; }
  </style>
</head>
<body>
  <div class="header-bar">
    <h1>🌤 Weather Bot 状态面板</h1>
    <div class="last-update" id="lastUpdate">加载中...</div>
  </div>
  <button class="refresh-btn" onclick="loadAll()">🔄 刷新</button>

  <h2>📊 进程状态</h2>
  <div class="grid" id="pm2Grid">加载中...</div>

  <h2>🗄 Redis 天气数据</h2>
  <div class="card" id="redisCard">加载中...</div>

  <h2>📝 最近策略决策</h2>
  <div class="card" id="decisionsCard">加载中...</div>

  <h2>📋 最新日志</h2>
  <div class="card" id="logsCard">加载中...</div>

  <script>
    async function fetchJSON(url) {
      const res = await fetch(url);
      return res.json();
    }

    function renderProcesses(processes) {
      if (!processes || !Array.isArray(processes)) return '<div class="card">无数据</div>';
      return processes.map(p => {
        const status = p.status || 'unknown';
        const badgeClass = status === 'online' ? 'online' : status === 'stopped' ? 'stopped' : 'offline';
        const uptime = p.uptime ? new Date(p.uptime).toLocaleString() : '-';
        const mem = p.monit?.memory ? (p.monit.memory / 1024 / 1024).toFixed(0) + ' MB' : '-';
        const cpu = p.monit?.cpu != null ? p.monit.cpu + '%' : '-';
        return '<div class="card">' +
          '<h3>' + (p.name || '?') + '</h3>' +
          '<div style="margin: 8px 0"><span class="status-badge ' + badgeClass + '">' + status + '</span></div>' +
          '<table>' +
          '<tr><td>PID</td><td>' + (p.pid || '-') + '</td></tr>' +
          '<tr><td>重启次数</td><td>' + (p.restart_time || 0) + '</td></tr>' +
          '<tr><td>内存</td><td>' + mem + '</td></tr>' +
          '<tr><td>CPU</td><td>' + cpu + '</td></tr>' +
          '</table></div>';
      }).join('');
    }

    function renderRedis(data) {
      if (!data || data.error) return '<div style="color:#f87171">错误: ' + (data?.error || '无数据') + '</div>';
      if (!data.keys || data.keys.length === 0) return '<div style="color:#fbbf24">Redis 中无天气数据</div>';
      const rows = data.keys.map(k => {
        const isFresh = k.ageSec != null && k.ageSec < 600;
        return '<tr><td>' + k.key + '</td><td class="' + (isFresh ? 'fresh' : 'stale') + '">' +
          (k.ageSec != null ? Math.round(k.ageSec / 60) + ' 分钟前' : '-') + '</td><td>' +
          (k.ttlSec != null ? Math.round(k.ttlSec / 60) + ' 分钟' : '-') + '</td></tr>';
      }).join('');
      return '<table><thead><tr><th>Key</th><th>数据年龄</th><th>过期时间</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div style="margin-top:8px;font-size:12px;color:#64748b">共 ' + data.count + ' 个 key</div>';
    }

    function renderDecisions(decisions) {
      if (!decisions || decisions.length === 0) return '<div style="color:#64748b">暂无策略决策记录</div>';
      return decisions.map(d => {
        const ts = d.timestamp ? new Date(d.timestamp).toLocaleString() : '?';
        return '<div class="log-entry">' +
          '<span class="log-time">' + ts + '</span> ' +
          '<span class="log-msg">' + (d.message || '') + '</span> ' +
          '<span style="color:#94a3b8">' + (d.bucket ? '桶: ' + d.bucket : '') + '</span>' +
          '</div>';
      }).join('');
    }

    function renderLogs(logs) {
      if (!logs || logs.length === 0) return '<div style="color:#64748b">暂无日志</div>';
      return logs.slice(0, 20).map(l => {
        const ts = l.timestamp ? new Date(l.timestamp).toLocaleString() : l.raw?.substring(0, 19) || '?';
        const msg = l.message || l.raw || '';
        const level = l.level || 'info';
        const levelClass = level === 'error' ? 'log-error' : level === 'warn' ? 'log-warn' : 'log-msg';
        return '<div class="log-entry">' +
          '<span class="log-time">' + ts + '</span> ' +
          '<span class="' + levelClass + '">[' + level + ']</span> ' +
          '<span class="log-msg">' + msg + '</span>' +
          '</div>';
      }).join('');
    }

    async function loadAll() {
      document.getElementById('lastUpdate').textContent = '更新中: ' + new Date().toLocaleTimeString();

      try {
        const summary = await fetchJSON('/api/summary');
        const pm2 = summary.pm2;
        document.getElementById('pm2Grid').innerHTML = pm2?.processes
          ? renderProcesses(pm2.processes)
          : '<div class="card" style="color:#f87171">获取 PM2 状态失败: ' + (pm2?.error || '') + '</div>';

        document.getElementById('redisCard').innerHTML = renderRedis(summary.redis);
        document.getElementById('decisionsCard').innerHTML = renderDecisions(summary.recentDecisions);

        const logsData = await fetchJSON('/api/logs');
        document.getElementById('logsCard').innerHTML = renderLogs(logsData.logs) +
          '<div style="margin-top:8px;font-size:12px;color:#64748b">共 ' + (logsData.totalLines || 0) + ' 条日志，显示最近 20 条</div>';

        document.getElementById('lastUpdate').textContent = '最后更新: ' + new Date().toLocaleTimeString();
      } catch (e) {
        document.getElementById('pm2Grid').innerHTML = '<div class="card" style="color:#f87171">加载失败: ' + e.message + '</div>';
      }
    }

    // 首次加载
    loadAll();
    // 每 15 秒自动刷新
    setInterval(loadAll, 15000);
  </script>
</body>
</html>`;
}

// ==================== HTTP 服务器 ====================

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  // API 路由
  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getPm2Status()));
    return;
  }

  if (url.pathname === '/api/redis') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getRedisStatus()));
    return;
  }

  if (url.pathname === '/api/logs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getRecentLogs(50)));
    return;
  }

  if (url.pathname === '/api/summary') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getSummary()));
    return;
  }

  // 根路径 → 返回 HTML 页面
  if (url.pathname === '/' || url.pathname === '') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderDashboard());
    return;
  }

  // 其他 → 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Status dashboard running at http://0.0.0.0:${PORT}`);
  console.log(`  API: http://0.0.0.0:${PORT}/api/summary`);
});