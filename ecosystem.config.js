// PM2 进程管理配置。
//
// 布局：
//   1 个 DataHub（唯一数据生产者）
//   N 个 StrategyInstance（每个城市一个独立进程，错误隔离）
//
// 特性：
//   - 崩溃自动重启（max_restarts + min_uptime 防死循环）
//   - 日志按进程分文件输出
//   - 内存超限自动重启

module.exports = {
  apps: [
    {
      // ==================== DataHub：数据生产者 ====================
      name: 'datahub',
      script: './dist/data/DataHubService.js',
      instances: 1, // 只允许 1 个实例，避免重复拉取数据
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s', // 启动后至少存活 10s 才计入"正常启动"
      max_memory_restart: '300M',
      out_file: './logs/pm2-datahub-out.log',
      error_file: './logs/pm2-datahub-error.log',
      merge_logs: true,
      time: true, // 日志加时间戳
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      // ==================== 上海策略进程 ====================
      name: 'strategy-shanghai',
      script: './dist/strategies/StrategyInstance.js',
      args: '--city=shanghai',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '200M',
      out_file: './logs/pm2-strategy-shanghai-out.log',
      error_file: './logs/pm2-strategy-shanghai-error.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },

    // ==================== 新增城市示例 ====================
    // 复制上面的 strategy-shanghai 块，改 name 和 args：
    // {
    //   name: 'strategy-beijing',
    //   script: './dist/strategies/StrategyInstance.js',
    //   args: '--city=beijing',
    //   instances: 1,
    //   autorestart: true,
    //   max_restarts: 10,
    //   min_uptime: '10s',
    //   max_memory_restart: '200M',
    //   out_file: './logs/pm2-strategy-beijing-out.log',
    //   error_file: './logs/pm2-strategy-beijing-error.log',
    //   merge_logs: true,
    //   time: true,
    //   env: { NODE_ENV: 'production' },
    // },
  ],
};
