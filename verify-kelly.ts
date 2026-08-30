// 临时验证脚本：用 mock 候选桶验证凯利公式动态投注逻辑。
// 运行：npx tsx verify-kelly.ts
// 验证完成后删除本文件。
//
// 被验证公式（TradingDecisionEngine.kellySizeUsd）：
//   f* = (N·p − c) / (N − c)          N=桶数(1/2)，p=模型总概率，c=买入总成本
//   sizeUsd = min(bankroll × f* × KELLY_FRACTION, maxPositionUsd)
//   f* ≤ 0 → 不开仓（返回 null）
//
// 环境：KELLY_FRACTION=0.25（.env）、maxPositionUsd=30（config/shanghai.json）。

import { loadCityConfig } from './src/common/config-loader.js';
import { TradingDecisionEngine } from './src/strategies/TradingDecisionEngine.js';
import type {
  CandidateBucket,
  ProbabilityDistribution,
  ForecastHorizon,
  CityId,
  TradingDecision,
} from './src/common/types.js';

const city = 'shanghai' as CityId;
const cityConfig = loadCityConfig(city);
const engine = new TradingDecisionEngine(cityConfig);

const KELLY_FRACTION = Number(process.env.KELLY_FRACTION ?? '0.25');
const MAX_POSITION_USD = cityConfig.risk.maxPositionUsd;

function makeDistribution(): ProbabilityDistribution {
  return {
    city,
    targetStation: 'ZSPD',
    horizon: 'd2' as ForecastHorizon,
    correctedAnchorTempC: 33,
    dispersionC: 2,
    consensusLevel: 0.8,
    buckets: [],
    sourceContributions: [],
    generatedAt: new Date(),
  };
}

function makeBucket(
  label: string,
  minTempC: number,
  maxTempC: number,
  modelProbability: number,
  yesPrice: number,
): CandidateBucket {
  return {
    bucket: { label, minTempC, maxTempC },
    modelProbability,
    yesPrice,
    noPrice: Math.round((1 - yesPrice) * 1000) / 1000,
    volumeUsd: 1000,
    orderBookImbalance: 0,
    spatialConfidence: 0.5,
  };
}

interface TestCase {
  name: string;
  candidates: CandidateBucket[];
  bankrollUsd: number;
  // 期望：'null' 表示不开仓；否则 { sizeUsd, kellyFraction } 期望值。
  expect: 'null' | { sizeUsd: number; kellyFraction: number };
}

// 手工预计算（KELLY_FRACTION=0.25，MAX_POSITION_USD=30）：
const cases: TestCase[] = [
  {
    name: '双桶正常：pPair=0.62 成本0.60 bankroll=100',
    candidates: [
      makeBucket('32-33C', 32, 33, 0.30, 0.28),
      makeBucket('33-34C', 33, 34, 0.32, 0.32),
    ],
    bankrollUsd: 100,
    // f*=(2×0.62−0.60)/(2−0.60)=0.64/1.40=0.457143 → 100×0.457143×0.25=11.4286
    expect: { sizeUsd: 11.4286, kellyFraction: 0.457143 },
  },
  {
    name: '双桶大edge：pPair=0.80 成本0.30 bankroll=100',
    candidates: [
      makeBucket('31-32C', 31, 32, 0.40, 0.15),
      makeBucket('32-33C', 32, 33, 0.40, 0.15),
    ],
    bankrollUsd: 100,
    // f*=(1.60−0.30)/(2−0.30)=1.30/1.70=0.764706 → 100×0.764706×0.25=19.1176
    expect: { sizeUsd: 19.1176, kellyFraction: 0.764706 },
  },
  {
    name: '双桶bankroll小：pPair=0.80 成本0.30 bankroll=20',
    candidates: [
      makeBucket('31-32C', 31, 32, 0.40, 0.15),
      makeBucket('32-33C', 32, 33, 0.40, 0.15),
    ],
    bankrollUsd: 20,
    // f* 同 0.764706 → 20×0.764706×0.25=3.82353
    expect: { sizeUsd: 3.82353, kellyFraction: 0.764706 },
  },
  {
    name: '双桶封顶：pPair=0.90 成本0.20 bankroll=200 → 压到 30',
    candidates: [
      makeBucket('30-31C', 30, 31, 0.45, 0.10),
      makeBucket('31-32C', 31, 32, 0.45, 0.10),
    ],
    bankrollUsd: 200,
    // f*=(1.80−0.20)/(2−0.20)=1.60/1.80=0.888889 → 200×0.888889×0.25=44.44 → min(…,30)=30
    expect: { sizeUsd: 30, kellyFraction: 0.888889 },
  },
  {
    name: '双桶edge≤0：pPair=0.30 成本0.65 → 不开仓',
    candidates: [
      makeBucket('34-35C', 34, 35, 0.15, 0.30),
      makeBucket('35-36C', 35, 36, 0.15, 0.35),
    ],
    bankrollUsd: 100,
    // f*=(0.60−0.65)/(2−0.65)=−0.037037 → ≤0 → null
    expect: 'null',
  },
  {
    name: '单桶正常：p=0.30 价格0.20 bankroll=100',
    candidates: [makeBucket('33C', 33, 33, 0.30, 0.20)],
    bankrollUsd: 100,
    // 无相邻对 → 回退单桶 f*=(0.30−0.20)/(1−0.20)=0.125 → 100×0.125×0.25=3.125
    expect: { sizeUsd: 3.125, kellyFraction: 0.125 },
  },
  {
    name: '单桶小edge：p=0.25 价格0.20 bankroll=100',
    candidates: [makeBucket('33C', 33, 33, 0.25, 0.20)],
    bankrollUsd: 100,
    // f*=(0.25−0.20)/0.80=0.0625 → 100×0.0625×0.25=1.5625
    expect: { sizeUsd: 1.5625, kellyFraction: 0.0625 },
  },
  {
    name: '单桶edge≤0：p=0.15 价格0.20 → 不开仓',
    candidates: [makeBucket('33C', 33, 33, 0.15, 0.20)],
    bankrollUsd: 100,
    // f*=(0.15−0.20)/0.80=−0.0625 → ≤0 → null
    expect: 'null',
  },
];

function formatDecision(d: TradingDecision | null): string {
  if (!d) return 'null';
  return `{ buckets=[${d.buckets.map((b) => b.label).join('+')}], entryPrice=${d.entryPrice.toFixed(4)}, kellyFraction=${d.kellyFraction.toFixed(6)}, sizeUsd=${d.sizeUsd.toFixed(4)} }`;
}

let pass = 0;
let fail = 0;

console.log('=== 凯利动态投注验证 ===');
console.log(`参数：KELLY_FRACTION=${KELLY_FRACTION}, maxPositionUsd=${MAX_POSITION_USD}\n`);

for (const tc of cases) {
  const decision = engine.decide({
    city,
    horizon: 'd2',
    distribution: makeDistribution(),
    candidates: tc.candidates,
    tradingMode: 'paper',
    bankrollUsd: tc.bankrollUsd,
  });

  let ok = false;
  let detail = '';
  if (tc.expect === 'null') {
    ok = decision === null;
    detail = ok ? '' : `期望不开仓，实际 ${formatDecision(decision)}`;
  } else {
    if (decision === null) {
      detail = `期望 sizeUsd=${tc.expect.sizeUsd.toFixed(4)}，实际不开仓`;
    } else {
      const sizeOk = Math.abs(decision.sizeUsd - tc.expect.sizeUsd) < 0.01;
      const fOk = Math.abs(decision.kellyFraction - tc.expect.kellyFraction) < 0.001;
      ok = sizeOk && fOk;
      detail = ok
        ? ''
        : `sizeUsd ${sizeOk ? 'OK' : `期望 ${tc.expect.sizeUsd.toFixed(4)} 实际 ${decision.sizeUsd.toFixed(4)}`} | ` +
          `kellyFraction ${fOk ? 'OK' : `期望 ${tc.expect.kellyFraction.toFixed(6)} 实际 ${decision.kellyFraction.toFixed(6)}`}`;
    }
  }

  if (ok) pass += 1;
  else fail += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${tc.name}`);
  console.log(`      bankroll=${tc.bankrollUsd}  →  ${formatDecision(decision)}`);
  if (!ok) console.log(`      ${detail}`);
  if (decision?.reason) console.log(`      reason: ${decision.reason}`);
  console.log('');
}

console.log(`结果：${pass} 通过 / ${fail} 失败（共 ${cases.length} 例）`);
process.exit(fail > 0 ? 1 : 0);
