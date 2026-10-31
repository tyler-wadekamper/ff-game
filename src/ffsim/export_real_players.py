"""Package real NFL career checkpoints for alternate-career game universes.

Only the already downloaded 2015–2025 panel is used. No actual successor
season is packaged as a player's predetermined game future.
"""
from pathlib import Path
import gzip
import hashlib
import json
import numpy as np
import pandas as pd
from .model import CORE


def export_real_players(root):
    root = Path(root)
    panel = pd.read_csv(root / 'data/processed/player_seasons.csv')
    people = []
    for player_id, group in panel.groupby('player_id', sort=True):
        group = group.sort_values('season')
        position = group.position.mode().iloc[0]
        group = group[group.position == position]
        if not len(group) or group.age.isna().all():
            continue  # An age must be supported by public metadata, never invented as fact.
        latest = group.iloc[-1]
        known = group[group.age.notna()].iloc[-1]
        states = []
        for _, row in group.iterrows():
            age = float(row.age) if pd.notna(row.age) else float(known.age + row.season - known.season)
            states.append({
                'season': int(row.season), 'age': int(np.floor(age)),
                'scheduled_games': int(row.scheduled_games),
                'listed_out_weeks': int(row.report_out_weeks) if pd.notna(row.report_out_weeks) else None,
                **{key: int(row[key]) for key in CORE},
            })
        people.append({
            'id': str(player_id), 'name': str(latest['name']), 'position': position,
            'states': states,
        })
    content = json.dumps(people, sort_keys=True, separators=(',', ':'), allow_nan=False)
    payload = {'version': hashlib.sha256(content.encode()).hexdigest()[:16],
               'seasons': [2015, 2025], 'source': 'nflverse cached player-season panel',
               'players': people}
    target = root / 'game/data/real-players.json.gz'
    with target.open('wb') as output:
        with gzip.GzipFile(fileobj=output, mode='wb', mtime=0) as stream:
            stream.write(json.dumps(payload, separators=(',', ':'), allow_nan=False).encode())
    print(json.dumps({'players': len(people), 'career_checkpoints': sum(len(p['states']) for p in people),
                      'version': payload['version'], 'bytes': target.stat().st_size}))


if __name__ == '__main__':
    export_real_players(Path.cwd())
