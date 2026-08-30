"""Compare Munich trades between old and new backtest runs"""
import csv, glob

files = sorted(glob.glob(r'g:\polymarket\weather\weather-2\weather-bot\data\backtest\backtest-detail_*.csv'))
print(f'Total files: {len(files)}')
for f in files[-2:]:
    short = f[-35:]
    print(f'\n{short}')
    with open(f, 'r') as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            if row['城市'] == 'munich':
                entry = row['入场价']
                hit = row['结算结果']
                pnl = row['盈亏']
                print(f'  {row["日期"]} {row["桶组合"]} entry={entry} hit={hit} pnl={pnl}')