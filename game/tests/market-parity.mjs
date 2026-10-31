// Compare the compact browser kernel with Python's independent sklearn model.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadData } from '../server.mjs';
import { createUniverseResolver, historyFeatures, marketPriority } from '../universe.mjs';
const data = loadData(),
  resolve = createUniverseResolver(data),
  spec = { id: 'kernel-audit', seed: 551, season: 1, baseVersion: data.catalog.version },
  queries = [];
for (const identityMode of ['fictional', 'real'])
  for (const season of [1, 2]) {
    const c = resolve({
      ...spec,
      season,
      identityMode,
      ...(identityMode === 'real' ? { realVersion: data.realPlayers.version } : {}),
    });
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      const group = c.catalog.players.filter((p) => p.position === pos);
      for (const player of [
        ...group.slice(0, 5),
        ...group.slice(-3),
        ...group.filter((p) => !p.history.length).slice(0, 2),
      ])
        queries.push({
          player,
          year: c.catalog.seasonYear,
          features: historyFeatures(player, c.catalog.seasonYear),
          priority: marketPriority(player, c.catalog.seasonYear, data.adpModel),
        });
    }
  }
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/browser_market_queries.json', JSON.stringify(queries));
execFileSync('.venv/bin/python', ['game/tests/market-parity.py'], { stdio: 'inherit' });
