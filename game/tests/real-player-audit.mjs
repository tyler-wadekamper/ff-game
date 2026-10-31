// Conditional uncertainty: one fixed named roster, many unseen football seeds.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadData } from '../server.mjs';
import { createUniverseResolver } from '../universe.mjs';
const data = loadData(),
  resolve = createUniverseResolver(data);
const spec = {
  id: 'real-player-evidence',
  seed: 640,
  baseVersion: data.catalog.version,
  season: 1,
  identityMode: 'real',
  realVersion: data.realPlayers.version,
};
const names = [
  'Lamar Jackson',
  'Patrick Mahomes',
  'Christian McCaffrey',
  'Justin Jefferson',
  'Travis Kelce',
];
const all = [],
  samples = Object.fromEntries(names.map((n) => [n, []]));
let fixedCatalog;
for (let n = 0; n < 50; n++) {
  const context = resolve({ ...spec, outcomeSeed: 7000 + n }),
    serialized = JSON.stringify(context.catalog);
  if (n === 0) fixedCatalog = serialized;
  else assert.equal(serialized, fixedCatalog, 'Histories/ADP changed with hidden outcomes');
  for (const name of names) {
    const p = context.catalog.players.find((p) => p.name === name);
    assert.ok(p, name);
    const totals = context.world[p.id].reduce(
      (a, r) => a.map((v, i) => v + r[i]),
      Array(17).fill(0),
    );
    samples[name].push({
      age: p.age,
      ppr: totals[0] / 100,
      games: totals[16],
      rushingYards: totals[7],
      receivingYards: totals[11],
      passingYards: totals[3],
    });
  }
  if ((n + 1) % 10 === 0) console.log('Named-player scenarios:', n + 1, '/50');
}
const mean = (a) => a.reduce((n, v) => n + v, 0) / a.length,
  quantile = (a, q) => {
    const s = [...a].sort((a, b) => a - b),
      n = (s.length - 1) * q;
    return s[Math.floor(n)] * (1 - (n % 1)) + s[Math.ceil(n)] * (n % 1);
  };
const summary = names.map((name) => {
  const rows = samples[name],
    ppr = rows.map((r) => r.ppr),
    avg = mean(ppr),
    sd = Math.sqrt(mean(ppr.map((n) => (n - avg) ** 2)));
  return {
    name,
    age: rows[0].age,
    min: Math.min(...ppr),
    p10: quantile(ppr, 0.1),
    median: quantile(ppr, 0.5),
    mean: avg,
    p90: quantile(ppr, 0.9),
    max: Math.max(...ppr),
    sd,
    distinctSeasons: new Set(ppr).size,
    meanRushingYards: mean(rows.map((r) => r.rushingYards)),
  };
});
for (const row of summary) {
  assert.ok(row.distinctSeasons >= 30, row.name + ' needs outcome variation');
  assert.ok(row.sd >= 25, row.name + ' outcomes are too narrow');
}
const lamar = summary.find((r) => r.name === 'Lamar Jackson'),
  mahomes = summary.find((r) => r.name === 'Patrick Mahomes');
assert.ok(
  lamar.meanRushingYards > mahomes.meanRushingYards,
  'Mobile QB style should survive sampling on average',
);
const ages = [];
for (let n = 1; n <= 20; n++) {
  const c = resolve({ ...spec, id: 'age-evidence-' + n, seed: n });
  ages.push(c.catalog.players.find((p) => p.name === 'Lamar Jackson').age);
}
assert.ok(new Set(ages).size >= 4);
const fingerprint = createHash('sha256').update(fs.readFileSync('game/universe.mjs')).digest('hex');
const result = {
  passed: true,
  scenarios: 50,
  historyAndAdpIdentical: true,
  identityLibraryVersion: data.realPlayers.version,
  sourcePeople: data.realPlayers.players.length,
  ageRangeExample: {
    name: 'Lamar Jackson',
    min: Math.min(...ages),
    max: Math.max(...ages),
    distinct: new Set(ages).size,
  },
  generatorFingerprint: fingerprint,
  summary,
  samples,
  note: 'Conditional game simulations from a finite empirical source library, not NFL forecasts or confidence intervals.',
};
fs.writeFileSync('artifacts/real_player_audit.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ passed: true, summary }, null, 2));
