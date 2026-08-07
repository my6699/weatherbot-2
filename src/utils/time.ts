// 这个文件负责时间相关的工具函数。
// 量化系统里时间处理是一个常见的错误来源，尤其涉及跨时区、D-N 计算、峰值时间判断时。
// 把所有时间逻辑集中在这里，避免各个模块各写一套。

import type { ForecastHorizon } from '../common/types.js';

export function getCityDate(cityTimezone: string): Date {
  // 获取某个城市的当前日期（不含时间部分）。
  // 例如上海时区是 Asia/Shanghai，函数返回上海当天的起始时间。
  // 服务器 UTC 时间和上海时间不同，不能在策略里直接用 new Date() 判断日期。

  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: cityTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const [year, month, day] = formatter.format(now).split('-').map(Number);
  return new Date(year!, month! - 1, day!);
}

export function getCityNow(cityTimezone: string): Date {
  // 获取某个城市的当前时间，返回 Date 对象。
  // 注意：Date 本身存储的是 UTC 毫秒数，但 toLocaleString 等方法会按城市时区格式化。

  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: cityTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);

  return new Date(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
}

export function getLocalHour(cityTimezone: string): number {
  // 获取城市当前小时数（0-23），用于判断是否接近峰值时间或硬性清仓时间。

  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: cityTimezone,
    hour: '2-digit',
    hour12: false,
  });
  return Number(formatter.format(now));
}

export function getLocalMinutes(cityTimezone: string): number {
  // 获取城市当前分钟数，用于精确判断离场时间。

  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: cityTimezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const [hour, minute] = formatter.format(now).split(':').map(Number);
  return hour! * 60 + minute!;
}

export function calculateHorizon(
  marketTargetDate: string,
  cityTimezone: string,
): ForecastHorizon {
  // 根据市场目标日期计算当前是 D-3、D-2、D-1 还是 D-0。
  //
  // 参数：
  //   marketTargetDate：目标日期，格式 YYYY-MM-DD。
  //   cityTimezone：城市时区，例如 Asia/Shanghai。
  //
  // 返回：
  //   'd3'：距离目标日期还有 3 天或以上。
  //   'd2'：距离目标日期还有 2 天。
  //   'd1'：距离目标日期还有 1 天。
  //   'd0'：目标日期当天。
  //
  // 示例：
  //   上海 08-10 的市场，在 08-07 时返回 'd3'。
  //   上海 08-10 的市场，在 08-08 时返回 'd2'。
  //   上海 08-10 的市场，在 08-09 时返回 'd1'。
  //   上海 08-10 的市场，在 08-10 时返回 'd0'。

  const cityDate = getCityDate(cityTimezone);
  const targetDate = new Date(marketTargetDate + 'T00:00:00');

  // 计算城市当前日期和目标日期相差的天数。
  const diffMs = targetDate.getTime() - cityDate.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) {
    return 'd0';
  }
  if (diffDays === 1) {
    return 'd1';
  }
  if (diffDays === 2) {
    return 'd2';
  }
  return 'd3';
}

export function parseTimeString(timeStr: string): { hour: number; minute: number } {
  // 解析时间字符串，例如 '14:00' → { hour: 14, minute: 0 }。
  // 用于读取 city_peak_times.json 中的 hardExitLocalTime 等配置。

  const [hour, minute] = timeStr.split(':').map(Number);
  return { hour: hour ?? 0, minute: minute ?? 0 };
}

export function isTimeToExit(
  cityTimezone: string,
  hardExitLocalTime: string,
): boolean {
  // 判断当前城市时间是否已经到了硬性清仓时间。
  //
  // 参数：
  //   cityTimezone：城市时区。
  //   hardExitLocalTime：硬性清仓时间，格式 'HH:MM'。
  //
  // 返回：
  //   true：当前时间已经达到或超过了硬性清仓时间，策略应该立即平仓。
  //   false：还没到清仓时间。

  const currentMinutes = getLocalMinutes(cityTimezone);
  const { hour, minute } = parseTimeString(hardExitLocalTime);
  const exitMinutes = hour * 60 + minute;

  return currentMinutes >= exitMinutes;
}

export function isWithinSoftExitWindow(
  cityTimezone: string,
  peakLocalTime: string,
  softExitBeforeHours: number,
): boolean {
  // 判断当前是否处于软止盈窗口。
  // 软止盈窗口 = 预测峰值时间 - softExitBeforeHours。
  //
  // 参数：
  //   peakLocalTime：预测峰值时间，格式 'HH:MM'。
  //   softExitBeforeHours：在峰值前多少小时开始软止盈。
  //
  // 返回：
  //   true：当前时间在软止盈窗口内，策略应该开始分批离场。
  //   false：还没到软止盈窗口。

  const currentMinutes = getLocalMinutes(cityTimezone);
  const { hour, minute } = parseTimeString(peakLocalTime);
  const peakMinutes = hour * 60 + minute;
  const windowStartMinutes = peakMinutes - softExitBeforeHours * 60;

  return currentMinutes >= windowStartMinutes && currentMinutes < peakMinutes;
}

export function formatISODate(date: Date): string {
  // 返回 YYYY-MM-DD 格式的日期字符串。
  // 用于生成 Redis key 和日志里的日期标记。

  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function hoursToResolution(endDate: string): number {
  // 距离市场结算（endDate，ISO 字符串）还有多少小时。
  // 负数表示已结算。旧项目 scan.ts 用它判断市场上架时间窗
  // （MIN_HOURS <= hours <= MAX_HOURS 才允许入场）。

  const end = new Date(endDate);
  if (Number.isNaN(end.getTime())) return 0;
  return (end.getTime() - Date.now()) / (1000 * 60 * 60);
}

export function delayMs(ms: number): Promise<void> {
  // 异步等待指定毫秒数。
  // 用于 DataHubService 里的轮询间隔和 API 请求间的限速。

  return new Promise((resolve) => setTimeout(resolve, ms));
}