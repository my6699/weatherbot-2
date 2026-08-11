/**
 * 生成 20 个城市的 config/<city>.json 配置文件。
 * 严格匹配 config-loader.ts 的 cityConfigSchema。
 * 运行: npx tsx scripts/generate-city-configs.ts
 */
import fs from 'node:fs';
import path from 'node:path';

interface CityData {
  lat: number;
  lon: number;
  station: string;
  tz: string;
  unit: 'F' | 'C';
  region: string;
  peakEarliest: string;
  peakTypical: string;
  peakLatest: string;
  bucketMin: number;
  bucketMax: number;
}

const CITIES: Record<string, CityData> = {
  nyc:         { lat: 40.7772, lon: -73.8726, station: 'KLGA',  tz: 'America/New_York',           unit: 'F', region: 'us', peakEarliest: '12:00', peakTypical: '14:00', peakLatest: '16:00', bucketMin: 0,  bucketMax: 40 },
  chicago:     { lat: 41.9742, lon: -87.9073, station: 'KORD',  tz: 'America/Chicago',            unit: 'F', region: 'us', peakEarliest: '12:00', peakTypical: '14:00', peakLatest: '16:00', bucketMin: 0,  bucketMax: 40 },
  miami:       { lat: 25.7959, lon: -80.287,  station: 'KMIA',  tz: 'America/New_York',           unit: 'F', region: 'us', peakEarliest: '11:00', peakTypical: '13:00', peakLatest: '15:00', bucketMin: 0,  bucketMax: 40 },
  dallas:      { lat: 32.8471, lon: -96.8518, station: 'KDAL',  tz: 'America/Chicago',            unit: 'F', region: 'us', peakEarliest: '12:00', peakTypical: '14:00', peakLatest: '16:00', bucketMin: 0,  bucketMax: 40 },
  seattle:     { lat: 47.4502, lon: -122.3088,station: 'KSEA',  tz: 'America/Los_Angeles',        unit: 'F', region: 'us', peakEarliest: '13:00', peakTypical: '15:00', peakLatest: '17:00', bucketMin: 0,  bucketMax: 35 },
  atlanta:     { lat: 33.6407, lon: -84.4277, station: 'KATL',  tz: 'America/New_York',           unit: 'F', region: 'us', peakEarliest: '12:00', peakTypical: '14:00', peakLatest: '16:00', bucketMin: 0,  bucketMax: 40 },
  london:      { lat: 51.5048, lon: 0.0495,   station: 'EGLC',  tz: 'Europe/London',              unit: 'C', region: 'eu', peakEarliest: '12:00', peakTypical: '14:00', peakLatest: '16:00', bucketMin: -5, bucketMax: 35 },
  paris:       { lat: 48.9962, lon: 2.5979,   station: 'LFPG',  tz: 'Europe/Paris',               unit: 'C', region: 'eu', peakEarliest: '12:00', peakTypical: '14:00', peakLatest: '16:00', bucketMin: -5, bucketMax: 35 },
  munich:      { lat: 48.3537, lon: 11.775,   station: 'EDDM',  tz: 'Europe/Berlin',              unit: 'C', region: 'eu', peakEarliest: '12:00', peakTypical: '14:00', peakLatest: '16:00', bucketMin: -5, bucketMax: 35 },
  ankara:      { lat: 40.1281, lon: 32.9951,  station: 'LTAC',  tz: 'Europe/Istanbul',            unit: 'C', region: 'eu', peakEarliest: '12:00', peakTypical: '14:00', peakLatest: '16:00', bucketMin: 0,  bucketMax: 38 },
  seoul:       { lat: 37.4691, lon: 126.4505, station: 'RKSI',  tz: 'Asia/Seoul',                 unit: 'C', region: 'asia', peakEarliest: '12:00', peakTypical: '14:00', peakLatest: '16:00', bucketMin: 10, bucketMax: 38 },
  tokyo:       { lat: 35.7647, lon: 140.3864, station: 'RJTT',  tz: 'Asia/Tokyo',                 unit: 'C', region: 'asia', peakEarliest: '11:00', peakTypical: '13:00', peakLatest: '15:00', bucketMin: 5,  bucketMax: 38 },
  shanghai:    { lat: 31.1443, lon: 121.8083, station: 'ZSPD',  tz: 'Asia/Shanghai',              unit: 'C', region: 'asia', peakEarliest: '11:00', peakTypical: '12:30', peakLatest: '14:00', bucketMin: 30, bucketMax: 37 },
  singapore:   { lat: 1.3502,  lon: 103.994,  station: 'WSSS',  tz: 'Asia/Singapore',             unit: 'C', region: 'asia', peakEarliest: '12:00', peakTypical: '14:00', peakLatest: '16:00', bucketMin: 25, bucketMax: 38 },
  lucknow:     { lat: 26.7606, lon: 80.8893,  station: 'VILK',  tz: 'Asia/Kolkata',               unit: 'C', region: 'asia', peakEarliest: '11:00', peakTypical: '13:00', peakLatest: '15:00', bucketMin: 20, bucketMax: 42 },
  'tel-aviv':  { lat: 32.0114, lon: 34.8867,  station: 'LLBG',  tz: 'Asia/Jerusalem',             unit: 'C', region: 'asia', peakEarliest: '11:00', peakTypical: '13:00', peakLatest: '15:00', bucketMin: 15, bucketMax: 38 },
  toronto:     { lat: 43.6772, lon: -79.6306, station: 'CYYZ',  tz: 'America/Toronto',            unit: 'C', region: 'ca',  peakEarliest: '12:00', peakTypical: '14:00', peakLatest: '16:00', bucketMin: -5, bucketMax: 35 },
  'sao-paulo': { lat: -23.4356,lon: -46.4731, station: 'SBGR',  tz: 'America/Sao_Paulo',          unit: 'C', region: 'sa',  peakEarliest: '12:00', peakTypical: '14:00', peakLatest: '16:00', bucketMin: 5,  bucketMax: 35 },
  'buenos-aires':{lat:-34.8222,lon: -58.5358, station: 'SAEZ',  tz: 'America/Argentina/Buenos_Aires',unit: 'C', region: 'sa', peakEarliest: '12:00', peakTypical: '14:00', peakLatest: '16:00', bucketMin: 5,  bucketMax: 35 },
  wellington:  { lat: -41.3272,lon: 174.8052, station: 'NZWN',  tz: 'Pacific/Auckland',           unit: 'C', region: 'oc',  peakEarliest: '12:00', peakTypical: '14:00', peakLatest: '16:00', bucketMin: 0,  bucketMax: 30 },
};

const STATION_NAMES: Record<string, string> = {
  KLGA: 'New York LaGuardia',
  KORD: 'Chicago O\'Hare',
  KMIA: 'Miami International',
  KDAL: 'Dallas Love Field',
  KSEA: 'Seattle-Tacoma',
  KATL: 'Atlanta Hartsfield-Jackson',
  EGLC: 'London City',
  LFPG: 'Paris Charles de Gaulle',
  EDDM: 'Munich International',
  LTAC: 'Ankara Esenboğa',
  RKSI: 'Seoul Incheon',
  RJTT: 'Tokyo Haneda',
  ZSPD: 'Shanghai Pudong International Airport',
  WSSS: 'Singapore Changi',
  VILK: 'Lucknow Amausi',
  LLBG: 'Tel Aviv Ben Gurion',
  CYYZ: 'Toronto Pearson',
  SBGR: 'Sao Paulo Guarulhos',
  SAEZ: 'Buenos Aires Ezeiza',
  NZWN: 'Wellington International',
};

/** 生成 1°C 间隔桶（与上海原格式一致：整数边界，无 ±0.5 偏移） */
function makeBuckets(min: number, max: number) {
  const buckets: Array<{ label: string; minTempC: number | null; maxTempC: number | null }> = [];
  buckets.push({ label: `<=${min}`, minTempC: null, maxTempC: min });
  for (let t = min + 1; t < max; t++) {
    buckets.push({ label: String(t), minTempC: t - 1, maxTempC: t });
  }
  buckets.push({ label: `>=${max}`, minTempC: max - 1, maxTempC: null });
  return buckets;
}

const configDir = path.resolve(import.meta.dirname, '..', 'config');
fs.mkdirSync(path.join(configDir, 'stations'), { recursive: true });

for (const [cityId, data] of Object.entries(CITIES)) {
  if (cityId === 'shanghai') {
    console.log(`⏭️ 跳过 shanghai（保留原配置）`);
    continue;
  }

  const stationName = STATION_NAMES[data.station] ?? data.station;
  const stationId = data.station.toLowerCase();

  const config = {
    city: cityId,
    timezone: data.tz,
    settlementStation: {
      stationId: data.station,
      name: stationName,
      lat: data.lat,
      lon: data.lon,
    },
    nearbyStationsFile: `config/stations/${stationId}_nearby.json`,
    peakTimeLocal: {
      earliest: data.peakEarliest,
      typical: data.peakTypical,
      latest: data.peakLatest,
    },
    buckets: makeBuckets(data.bucketMin, data.bucketMax),
    spatialCorrection: {
      method: 'idw',
      maxRadiusKm: 50,
      minNearbyStations: 3,
      idwPower: 2,
      gaussianBandwidthKm: 18,
    },
    scoringWeights: {
      cheapTail: 1.6,
      modelShock: 1.2,
      orderFlow: 1.0,
      spatialSupport: 1.5,
      relativeValue: 1.1,
      probabilityGap: 1.3,
      dispersionPenalty: 1.4,
    },
    risk: {
      maxPositionUsd: 25,
      maxCityExposureUsd: 100,
    },
  };

  const filePath = path.join(configDir, `${cityId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
  console.log(`✅ 已生成 ${filePath}  (${data.unit}, ${data.bucketMin}-${data.bucketMax}°C)`);
}

console.log(`\n🎉 共生成 ${Object.keys(CITIES).length - 1} 个城市配置文件（跳过 shanghai）`);