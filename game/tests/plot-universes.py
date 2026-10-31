"""Render the executed universe distribution regression as a standalone figure."""
import json
import os
from pathlib import Path
os.environ.setdefault('MPLCONFIGDIR', '/tmp/ff-game-matplotlib')
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

result = json.loads(Path('artifacts/universe_audit.json').read_text())
assert result['passed']
rows = result['rows']
plt.style.use('dark_background')
fig, axes = plt.subplots(2, 4, figsize=(15, 8), facecolor='#101d29')
colors = ['#92a8bc', '#badf7b', '#e6bc71']
for col, position in enumerate(['QB', 'RB', 'WR', 'TE']):
    ax = axes[0, col]
    ax.set_facecolor('#152632')
    for n, (label, color) in enumerate(zip(['Packaged pools', 'Fresh universes', 'Continued seasons'], colors)):
        values = []
        for metric in ['q90', 'q99']:
            row = next(r for r in rows if r['position'] == position and r['season'] == (2 if n == 2 else 1) and r['metric'] == metric)
            values.append(row['baseline'] if n == 0 else row['generated'])
        ax.bar(np.arange(2) + (n - 1) * .24, values, width=.22, color=color, label=label)
    ax.set_xticks([0, 1], ['90th percentile', '99th percentile'])
    ax.set_title(position + ' season PPR', fontweight='bold')
    ax.set_ylim(bottom=0)
    ax = axes[1, col]
    ax.set_facecolor('#152632')
    values = []
    for n in range(3):
        row = next(r for r in rows if r['position'] == position and r['season'] == (2 if n == 2 else 1) and r['metric'] == 'usefulWeeklySd')
        values.append(row['baseline'] if n == 0 else row['generated'])
    ax.bar([0, 1, 2], values, color=colors)
    ax.set_xticks([0, 1, 2], ['Pools', 'New', 'Continued'])
    ax.set_title(position + ' played-game PPR variability', fontsize=11)
    ax.set_ylim(bottom=0)
    for ax in axes[:, col]:
        ax.spines[['top', 'right']].set_visible(False)
        ax.grid(axis='y', alpha=.15)
        ax.tick_params(labelsize=9)
axes[0, 0].set_ylabel('Total season PPR')
axes[1, 0].set_ylabel('Mean within-player weekly SD')
axes[0, 0].legend(fontsize=8, loc='upper left')
fig.suptitle('Fresh universes preserve the game’s empirical scoring shape', fontsize=20, fontweight='bold', y=.99)
fig.text(.04, .035, '100 fresh universes + 20 continued seasons · 972 players each · 12 source pools\nRegression against packaged pools, not an independent NFL holdout. Weekly SD uses position-specific productive roles with ≥8 games.', fontsize=10, color='#afbecb')
fig.tight_layout(rect=(0, .10, 1, .95))
fig.savefig('reports/universe_distribution_regression.png', dpi=150, facecolor=fig.get_facecolor())
plt.close(fig)
for name in ['universe_audit.json', 'universe_metrics.csv', 'browser_market_parity.json']:
    Path('reports', name).write_bytes(Path('artifacts', name).read_bytes())
print('Saved universe distribution evidence.')
