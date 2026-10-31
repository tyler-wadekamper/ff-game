"""Standalone evidence for different futures given one fixed named roster."""
import json
import os
from pathlib import Path
os.environ.setdefault('MPLCONFIGDIR', '/tmp/ff-game-matplotlib')
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

result = json.loads(Path('artifacts/real_player_audit.json').read_text())
assert result['passed']
plt.style.use('dark_background')
fig, axes = plt.subplots(2, 3, figsize=(14, 8), facecolor='#101d29')
for ax, row in zip(axes.flat, result['summary']):
    ax.set_facecolor('#172632')
    points = [sample['ppr'] for sample in result['samples'][row['name']]]
    ax.hist(points, bins=12, color='#b6d976', edgecolor='#101d29')
    ax.axvline(row['median'], color='#eabd72', lw=2, label='Median game result')
    ax.set_title(f"{row['name']} · simulated age {row['age']}", fontsize=12)
    ax.set_xlabel('Generated season PPR')
    ax.set_ylabel('Number of scenarios')
    ax.spines[['top', 'right']].set_visible(False)
    ax.grid(axis='y', alpha=.15)
axes.flat[-1].axis('off')
axes.flat[-1].text(.04, .95, 'Same names, ages, histories and ADP\n\n50 different private football seeds\n\nReal-player history and style guide the match.\nThe actual next NFL season is never replayed.\n\nGame scenarios from 12 empirical source pools;\nnot NFL forecasts or confidence intervals.', va='top', fontsize=12, linespacing=1.8, color='#b6c3cf')
fig.suptitle('A familiar name is a clue, not a predetermined season', fontsize=21, fontweight='bold')
fig.tight_layout(rect=(0, 0, 1, .94))
fig.savefig('reports/real_player_future_variation.png', dpi=150, facecolor=fig.get_facecolor())
plt.close(fig)
Path('reports/real_player_audit.json').write_bytes(Path('artifacts/real_player_audit.json').read_bytes())
print('Wrote real-player scenario evidence.')
