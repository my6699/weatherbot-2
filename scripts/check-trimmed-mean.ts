// 一次性验证脚本（2026-08-07）：
// 评估用户提出的空间修正方案 —— "剔除主站，剩余站点去掉最高和最低后求平均，与主站对比"。
// 运行：npx tsx scripts/check-trimmed-mean.ts
import axios from 'axios';

// 站点坐标（与 zspd_nearby.json 一致）
const STATIONS: Array<{ id: string; lat: number; lon: number }> = [
  { id: 'ZSPD', lat: 31.1443, lon: 121.8083 }, // 主站 浦东机场
  { id: 'ZSSS', lat: 31.1979, lon: 121.3363 }, // 虹桥
  { id: 'Baoshan', lat: 31.4053, lon: 121.4897 }, // 宝山
  { id: 'Xujiahui', lat: 31.1836, lon: 121.433 }, // 徐家汇
  { id: 'Nanhui', lat: 30.9289, lon: 121.8797 }, // 南汇
  { id: 'Chongming', lat: 31.626, lon: 121.397 }, // 崇明
  { id: 'Yangshan', lat: 30.6267, lon: 122.0644 }, // 洋山
];

const DATES = ['2026-08-04', '2026-08-05', '2026-08-06']; // 已结算，实际温度 33/33/33

async function fetchDailyMax(station: { id: string; lat: number; lon: number }): Promise<Record<string, number | null>> {
  const res = await axios.get('https://api.open-meteo.com/v1/forecast', {
    params: {
      latitude: station.lat,
      longitude: station.lon,
      daily: 'temperature_2m_max',
      past_days: 10,
      forecast_days: 0,
      timezone: 'Asia/Shanghai',
    },
    timeout: 10000,
  });
  const times = res.data?.daily?.time ?? [];
  const temps = res.data?.daily?.temperature_2m_max ?? [];
  const out: Record<string, number | null> = {};
  for (let i = 0; i < times.length; i++) {
    const t = temps[i];
    out[times[i]] = t == null ? null : Number(t);
  }
  return out;
}

async function main() {
  // 拉全站 daily max
  const all: Record<string, Record<string, number | null>> = {};
  for (const s of STATIONS) {
    all[s.id] = await fetchDailyMax(s);
  }

  console.log('方案验证：剔除主站，周边站去高低平均 vs 主站\n');
  for (const d of DATES) {
    const main = all['ZSPD'][d];
    const nearbyIds = STATIONS.map((s) => s.id).filter((id) => id !== 'ZSPD');
    const nearbyTemps = nearbyIds
      .map((id) => all[id][d])
      .filter((t): t is number => t != null && Number.isFinite(t))
      .sort((a, b) => a - b);

    if (main == null || nearbyTemps.length < 3) {
      console.log(`${d}: 数据不足 main=${main} nearby=${JSON.stringify(nearbyTemps)}`);
      continue;
    }

    // 方案1：全部周边站平均
    const allMean = nearbyTemps.reduce((a, b) => a + b, 0) / nearbyTemps.length;
    // 方案2：去最高最低后平均
    const trimmed = nearbyTemps.slice(1, -1);
    const trimmedMean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;

    console.log(`── ${d}（实际 33°C）──`);
    console.log(`  主站 ZSPD:            ${main.toFixed(1)}  (误差 ${(main - 33).toFixed(1)})`);
    console.log(`  周边原始: ${nearbyTemps.map((t) => t.toFixed(1)).join(', ')}`);
    console.log(`  周边全平均:           ${allMean.toFixed(1)}  (误差 ${(allMean - 33).toFixed(1)})`);
    console.log(`  周边去高低平均:       ${trimmedMean.toFixed(1)}  (误差 ${(trimmedMean - 33).toFixed(1)})`);
    console.log(`  周边均值 − 主站:      ${(trimmedMean - main).toFixed(1)}`);
    console.log();
  }
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
