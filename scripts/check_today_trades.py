import json, os
from datetime import datetime, timezone, timedelta

data_dir = '/home/ec2-user/weatherbot-2/data'
now_bj = datetime.now(timezone(timedelta(hours=8)))
today = now_bj.strftime('%Y-%m-%d')
yesterday = (now_bj - timedelta(days=1)).strftime('%Y-%m-%d')

for label, day in [('今日', today), ('昨日', yesterday)]:
    total_pnl = 0.0
    loss_count = 0
    win_count = 0
    all_closed = []

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
            status = t.get('status', '')
            if status not in ('closed', 'settled'):
                continue
            et = t.get('exitTime') or t.get('closeTime') or t.get('settledAt') or ''
            if day not in str(et):
                continue
            pnl = t.get('pnl') or t.get('realizedPnl') or 0
            entry = t.get('entryPrice', 0)
            exit_p = t.get('exitPrice', 0)
            side = t.get('side', '')
            buckets = t.get('buckets', [])
            rid = t.get('reason', '')
            total_pnl += pnl
            if pnl < 0: loss_count += 1
            else: win_count += 1
            all_closed.append((city, buckets, side, entry, exit_p, pnl, rid[:80]))

    print(f'=== {label}({day})平仓记录 ===')
    for c, b, s, en, ex, pnl, r in sorted(all_closed, key=lambda x: x[5]):
        print(f'  {c} {b} entry={en:.3f} exit={ex:.3f} pnl=${pnl:+.2f}  {r}')
    print(f'合计: {win_count}赢 {loss_count}亏 总盈亏=${total_pnl:.2f}\n')