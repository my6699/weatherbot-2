// 一键同步脚本：把 VPS 上的交易数据拉到本地 data/ 目录，方便本地复盘分析。
//
// 同步内容：
//   - trades-*.json       每城交易明细（开仓/平仓/结算/盈亏）
//   - predictions.json    天气修正预测落盘
//   - trade-journal.json  开仓评估快照 + 持仓逐轮轨迹
//   - processed/*.md      每日胜率报告等
//
// 用法：npm run sync
// 配置（环境变量，有默认值）：
//   PM_SSH_KEY          SSH 私钥路径，默认 G:\polymarket\weather.pem
//   PM_VPS_HOST         VPS 地址，默认 ec2-3-255-158-132.eu-west-1.compute.amazonaws.com
//   PM_VPS_DATA_DIR     VPS 数据目录，默认 ~/weatherbot-2/data
//   PM_LOCAL_DATA_DIR   本地数据目录，默认 data（相对项目根）

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SSH_KEY = process.env.PM_SSH_KEY ?? 'G:\\polymarket\\weather.pem';
const SSH_USER = process.env.PM_SSH_USER ?? 'ec2-user';
const VPS_HOST =
  process.env.PM_VPS_HOST ??
  'ec2-3-255-158-132.eu-west-1.compute.amazonaws.com';
const REMOTE_BASE = process.env.PM_VPS_DATA_DIR ?? '~/weatherbot-2/data';
const LOCAL_BASE = process.env.PM_LOCAL_DATA_DIR ?? 'data';
const REMOTE_PREFIX = `${SSH_USER}@${VPS_HOST}`;

// 按顺序下载：通配符由远端 shell 展开，scp 逐个拉取。
const DATA_FILES = ['trades-*.json', 'predictions.json', 'trade-journal.json'];

function scp(remotePath: string, localDir: string): boolean {
  fs.mkdirSync(localDir, { recursive: true });
  const r = spawnSync('scp', ['-i', SSH_KEY, `${REMOTE_PREFIX}:${remotePath}`, localDir], {
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error(`[sync] 下载失败: ${remotePath}`);
    return false;
  }
  return true;
}

console.log(`[sync] ${VPS_HOST} -> ${path.resolve(LOCAL_BASE)}`);
let ok = true;
for (const f of DATA_FILES) {
  ok = scp(`${REMOTE_BASE}/${f}`, LOCAL_BASE) && ok;
}
ok = scp(`${REMOTE_BASE}/processed/*.md`, path.join(LOCAL_BASE, 'processed')) && ok;

// 同步后打印摘要，确认数据可用。
if (ok) {
  try {
    const journal = JSON.parse(
      fs.readFileSync(path.join(LOCAL_BASE, 'trade-journal.json'), 'utf-8'),
    ) as { evaluations: unknown[]; traces: Record<string, unknown> };
    console.log(
      `[sync] journal: evaluations=${journal.evaluations.length} traces=${Object.keys(journal.traces).length}`,
    );
    const trades = fs
      .readdirSync(LOCAL_BASE)
      .filter((f) => /^trades-.*\.json$/.test(f))
      .flatMap((f) =>
        JSON.parse(fs.readFileSync(path.join(LOCAL_BASE, f), 'utf-8')) as Array<{
          status: string;
          pnl: number | null;
        }>,
      );
    console.log(`[sync] trades: 总数=${trades.length}`);
    console.log(
      `[sync]   open=${trades.filter((t) => t.status === 'open').length} ` +
        `closed=${trades.filter((t) => t.status === 'closed').length} ` +
        `settled=${trades.filter((t) => t.status === 'settled').length}`,
    );
  } catch (e) {
    console.warn(`[sync] 摘要统计失败（文件可能还没生成）: ${String(e)}`);
  }
  console.log('[sync] 完成');
} else {
  process.exitCode = 1;
}
