"""分析旧回测 CSV 文件（找出参数修改前的最后一次回测）"""
import csv, glob, os
from collections import defaultdict

files = sorted(glob.glob(r'g:\polymarket\weather\weather-2\weather-bot\data\backtest\backtest-detail_*.csv'))
# 取倒数第二个（参数修改前的最后一次）
old_file = files[-2] if len(files) >= 2 else files[-1]

cities = defaultdict(lambda: {'total': 0, 'hit': 0, 'pnl': 0.0, 'settled': 0, 'miss': 0})

with open(old_file, 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for row in reader:
        city = row['城市']
        hit = row['结算结果'].strip() == '命中'
        pnl_str = row['盈亏'].strip()
        pnl = float(pnl_str) if pnl_str else 0.0
        entry = row['入场价'].strip()
        actual = row['实际温度C'].strip()
        
        cities[city]['total'] += 1
        if actual and entry:
            cities[city]['settled'] += 1
            if hit:
                cities[city]['hit'] += 1
            else:
                cities[city]['miss'] += 1
            cities[city]['pnl'] += pnl

print(f'旧文件: {os.path.basename(old_file)}')
print()
print(f'{"城市":<12} {"交易数":>6} {"已结算":>6} {"命中":>6} {"未中":>6} {"命中率":>8} {"盈亏":>8} {"ROI":>8}')
print('-' * 65)
for city, d in sorted(cities.items()):
    settled = d['settled']
    total_entry = d['hit'] + d['miss']
    hit_rate = d['hit'] / total_entry * 100 if total_entry > 0 else 0
    roi = d['pnl'] / total_entry * 100 if total_entry > 0 else 0
    print(f'{city:<12} {d["total"]:>6} {settled:>6} {d["hit"]:>6} {d["miss"]:>6} {hit_rate:>7.1f}% {d["pnl"]:>+7.2f} {roi:>+7.1f}%')

totals = {'total': 0, 'hit': 0, 'pnl': 0.0, 'settled': 0, 'miss': 0}
for d in cities.values():
    for k in totals:
        totals[k] += d[k]
total_entry = totals['hit'] + totals['miss']
hit_rate = totals['hit'] / total_entry * 100 if total_entry > 0 else 0
roi = totals['pnl'] / total_entry * 100 if total_entry > 0 else 0
print('-' * 65)
print(f'{"合计":<12} {totals["total"]:>6} {totals["settled"]:>6} {totals["hit"]:>6} {totals["miss"]:>6} {hit_rate:>7.1f}% {totals["pnl"]:>+7.2f} {roi:>+7.1f}%')