import json, os
from datetime import datetime, timezone, timedelta

data_dir = '/home/ec2-user/weatherbot-2/data'

# 从 trade-journal 获取评估记录
jfp = os.path.join(data_dir, 'trade-journal.json')
if os.path.exists(jfp):
    with open(jfp) as f:
        journal = json.load(f)
else:
    journal = []

# 从各城市 trades 文件获取已结算交易
all_trades = []
for fname in os.listdir(data_dir):
    if not fname.startswith('trades-') or not fname.endswith('.json'):
        continue
    city = fname.replace('trades-', '').replace('.json', '')
    fp = os.path.join(data_dir, fname)
    try:
        with open(fp) as f:
            trades = json.load(f)
    except:
        continue
    if not isinstance(trades, list):
        trades = trades.get('trades', [])
    for t in trades:
        t['_city'] = city
        all_trades.append(t)

# 统计已结算/已平仓的交易
settled = [t for t in all_trades if t.get('status') in ('closed', 'settled')]
open_trades = [t for t in all_trades if t.get('status') not in ('closed', 'settled')]

print(f'=== 双桶策略命中率统计 ===')
print(f'数据来源: {len(all_trades)} 条交易记录, {len(settled)} 条已结算')

# 方法1: 从 trade 文件直接算
wins = sum(1 for t in settled if (t.get('pnl') or t.get('realizedPnl') or 0) > 0)
losses = sum(1 for t in settled if (t.get('pnl') or t.get('realizedPnl') or 0) < 0)
total_pnl = sum(t.get('pnl') or t.get('realizedPnl') or 0 for t in settled)

print(f'\n--- 从 trades 文件统计 ---')
print(f'已结算: {len(settled)} 笔')
print(f'赢: {wins} 笔')
print(f'亏: {losses} 笔')
print(f'命中率: {wins/len(settled)*100:.1f}%' if settled else '命中率: N/A')
print(f'总盈亏: ${total_pnl:.2f}')

# 方法2: 从 trade-journal 的 OPEN 评估记录统计
opens = [e for e in journal if isinstance(e, dict) and e.get('action') in ('OPEN',)]
closes = [e for e in journal if isinstance(e, dict) and e.get('action') in ('CLOSE', 'SETTLE', 'close', 'settle')]

hits = 0
misses = 0
j_pnl = 0
for e in closes:
    if not isinstance(e, dict):
        continue
    pnl = e.get('pnl', 0)
    j_pnl += pnl
    if pnl > 0: hits += 1
    elif pnl < 0: misses += 1

total_closed = hits + misses
print(f'\n--- 从 trade-journal 结算记录统计 ---')
print(f'已结算: {total_closed} 笔')
print(f'赢: {hits} 笔')
print(f'亏: {misses} 笔')
if total_closed > 0:
    print(f'命中率: {hits/total_closed*100:.1f}%')
print(f'总盈亏: ${j_pnl:.2f}')

# 按城市统计
print(f'\n--- 按城市统计 ---')
city_stats = {}
for t in settled:
    c = t.get('_city', 'unknown')
    pnl = t.get('pnl') or t.get('realizedPnl') or 0
    if c not in city_stats:
        city_stats[c] = {'wins': 0, 'losses': 0, 'pnl': 0, 'total': 0}
    city_stats[c]['total'] += 1
    city_stats[c]['pnl'] += pnl
    if pnl > 0: city_stats[c]['wins'] += 1
    elif pnl < 0: city_stats[c]['losses'] += 1

for c, s in sorted(city_stats.items(), key=lambda x: -x[1]['total']):
    hr = s['wins'] / s['total'] * 100 if s['total'] > 0 else 0
    print(f'  {c}: {s["total"]}笔 赢{s["wins"]}亏{s["losses"]} 命中率{hr:.0f}% PnL=${s["pnl"]:.2f}')

# 当前持仓
print(f'\n--- 当前持仓 ---')
print(f'持有中: {len(open_trades)} 笔')
for t in open_trades:
    c = t.get('_city', '')
    b = t.get('buckets', [])
    entry = t.get('entryPrice', 0)
    print(f'  {c} {b} entry=${entry:.2f}')