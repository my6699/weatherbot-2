import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import winston from 'winston';

// 日志是量化系统的“黑匣子”。
// 策略为什么买、为什么不买、数据源为什么失败，都必须能从日志里复盘。

const logLevel = process.env.LOG_LEVEL ?? 'info';
const logDir = process.env.LOG_DIR ?? 'logs';

// 确保日志目录存在。
// 如果目录不存在，winston 写文件会失败，所以启动时先创建。
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const logFormat = winston.format.combine(
  // 给每条日志加时间，方便对齐天气数据、市场价格、策略动作。
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),

  // 捕获 Error 对象里的 stack，排查异常时很重要。
  winston.format.errors({ stack: true }),

  // 统一输出 JSON，方便以后用脚本或日志平台分析。
  winston.format.json(),
);

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf((info) => {
    const { timestamp, level, message, ...rest } = info;
    const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
    return `${timestamp} ${level}: ${message}${extra}`;
  }),
);

export const logger = winston.createLogger({
  level: logLevel,
  format: logFormat,
  defaultMeta: {
    service: 'polymarket-shanghai-weather-bot',
  },
  transports: [
    // 所有 info 及以上日志写到 combined.log。
    // 这里包括正常启动、数据刷新、策略打分、paper trading 决策等。
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
      level: 'info',
    }),

    // error 单独写一份，方便第一时间查看故障。
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
    }),
  ],
});

// 本地开发时同时打印到控制台。
// VPS 上用 PM2 logs 也能看到这些输出。
if (process.env.NODE_ENV !== 'test') {
  logger.add(
    new winston.transports.Console({
      level: logLevel,
      format: consoleFormat,
    }),
  );
}

export function createModuleLogger(moduleName: string): winston.Logger {
  // 每个模块用 child logger 加上 module 字段。
  // 之后看日志时可以按 module=DataHubService 或 module=ExitStrategy 过滤。
  return logger.child({ module: moduleName });
}

export function logError(moduleLogger: winston.Logger, message: string, error: unknown): void {
  // TypeScript 里 catch 到的是 unknown。
  // 这里统一把 unknown 转成可读字段，避免每个模块重复写错误处理。
  if (error instanceof Error) {
    moduleLogger.error(message, {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
    });
    return;
  }

  moduleLogger.error(message, {
    errorMessage: String(error),
  });
}
