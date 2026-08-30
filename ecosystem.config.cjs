// PM2 进程管理配置（VPS 版本，与 VPS ~/weatherbot-2/ecosystem.config.cjs 对齐）。
//
// 布局（2026-08-08 优化：从 22 进程减至 3 进程，解决低配服务器内存过载）：
//   1 个 DataHub（唯一数据生产者，自动采集所有已配置城市）
//   1 个 MultiCityStrategy（合并所有城市策略，串行处理）
//   1 个 DailyReport（每日结算报告，cron 触发）
//
// 特性：
//   - 崩溃自动重启（max_restarts + min_uptime 防死循环）
//   - 日志按进程分文件输出
//   - 内存超限自动重启

module.exports = {
  apps: [
    // ==================== DataHub：数据生产者 ====================
    {
      name: 'datahub',
      script: './dist/data/DataHubService.js',
      exec_mode: 'fork',
      instances: 1, // 只允许 1 个实例，避免重复拉取数据
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '300M',
      out_file: './logs/pm2-datahub-out.log',
      error_file: './logs/pm2-datahub-error.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },

    // ==================== 多城市策略进程（合并所有城市，单进程串行） ====================
    {
      name: 'strategy',
      script: './dist/strategies/MultiCityStrategy.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '300M',
      out_file: './logs/pm2-strategy-out.log',
      error_file: './logs/pm2-strategy-error.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        // 双桶入场成本上限 0.65 → 0.75（2026-08-12 回测：EV 双窗口 +68~100%，0.75 起平台）
        MAX_ENTRY_COST: '0.75',
      },
    },

    // ==================== 每日结算报告（UTC 13:00 = 北京时间 21:00） ====================
    {
      name: 'daily-report',
      script: './scripts/daily-report.ts',
      instances: 1,
      autorestart: false,
      cron_restart: '0 13 * * *',
      exec_interpreter: './node_modules/.bin/tsx',
      out_file: './logs/pm2-daily-report-out.log',
      error_file: './logs/pm2-daily-report-error.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },

    // ==================== 持仓状态报告（每 2 小时，含持仓明细） ====================
    {
      name: 'status-report',
      script: './scripts/status-report.ts',
      instances: 1,
      autorestart: false,
      cron_restart: '0 */2 * * *',
      exec_interpreter: './node_modules/.bin/tsx',
      out_file: './logs/pm2-status-report-out.log',
      error_file: './logs/pm2-status-report-error.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
