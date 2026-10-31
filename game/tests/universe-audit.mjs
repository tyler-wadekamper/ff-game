// Distribution regression for the lightweight browser universe generator.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadData } from '../server.mjs';
import { createUniverseResolver } from '../universe.mjs';
const data = loadData(),
  resolve = createUniverseResolver(data),
  positions = ['QB', 'RB', 'WR', 'TE'];
const sums = (a) => a.reduce((n, x) => n + x, 0),
  mean = (a) => sums(a) / Math.max(1, a.length);
const quantile = (a, q) => {
  const s = [...a].sort((a, b) => a - b),
    i = (s.length - 1) * q;
  return s[Math.floor(i)] * (1 - (i % 1)) + s[Math.ceil(i)] * (i % 1);
};
function metrics(catalog, world) {
  const out = {};
  for (const pos of positions) {
    const group = catalog.players.filter((p) => p.position === pos);
    const rows = group.map((p) => {
      const weeks = world[p.id],
        played = weeks.filter((r) => r.at(-1)).map((r) => r[0] / 100),
        score = sums(played),
        avg = mean(played);
      return {
        score,
        games: played.length,
        sd: Math.sqrt(mean(played.map((n) => (n - avg) ** 2))),
        weeks: played,
      };
    });
    const useful = rows.filter(
      (r) => r.games >= 8 && r.score >= { QB: 100, RB: 70, WR: 70, TE: 50 }[pos],
    );
    out[pos] = {
      population: group.length,
      totalPpr: sums(rows.map((r) => r.score)),
      q50: quantile(
        rows.map((r) => r.score),
        0.5,
      ),
      q90: quantile(
        rows.map((r) => r.score),
        0.9,
      ),
      q99: quantile(
        rows.map((r) => r.score),
        0.99,
      ),
      meanGames: mean(rows.map((r) => r.games)),
      usefulWeeklySd: mean(useful.map((r) => r.sd)),
      fortyPointRate: mean(rows.flatMap((r) => r.weeks).map((x) => Number(x >= 40))),
    };
  }
  return out;
}
const source = data.privateData.worlds.map((w) => metrics(data.catalog, w)),
  samples = [];
for (let seed = 1; seed <= 100; seed++) {
  const spec = {
    id: 'audit-' + seed,
    seed: 10000 + seed,
    season: 1,
    baseVersion: data.catalog.version,
  };
  const first = resolve(spec);
  samples.push({ season: 1, seed, metrics: metrics(first.catalog, first.world) });
  if (seed <= 20) {
    const next = resolve({ ...spec, season: 2 });
    samples.push({ season: 2, seed, metrics: metrics(next.catalog, next.world) });
  }
  if (seed % 25 === 0) console.log('Universe audit:', seed, 'fresh universes');
}
const rows = [],
  checks = [];
for (const pos of positions)
  for (const season of [1, 2]) {
    const group = samples.filter((s) => s.season === season);
    for (const key of Object.keys(source[0][pos])) {
      const baseline = mean(source.map((s) => s[pos][key])),
        actual = mean(group.map((s) => s.metrics[pos][key])),
        relative = baseline ? actual / baseline - 1 : actual;
      const tolerance = key === 'fortyPointRate' ? 0.6 : key === 'q99' ? 0.16 : 0.12;
      const pass =
        key === 'population'
          ? actual === baseline
          : Math.abs(actual - baseline) <=
            (key === 'q50'
              ? Math.max(1.2, Math.abs(baseline) * tolerance)
              : Math.abs(baseline) * tolerance);
      rows.push({
        position: pos,
        season,
        metric: key,
        baseline,
        generated: actual,
        relativeDifference: relative,
        tolerance,
        pass,
      });
      checks.push(pass);
    }
  }
const fingerprint = createHash('sha256')
  .update(fs.readFileSync('game/universe.mjs'))
  .update(fs.readFileSync('game/player-insights.mjs'))
  .digest('hex');
const summary = {
  passed: checks.every(Boolean),
  freshUniverses: 100,
  continuedUniverses: 20,
  sourceWorlds: 12,
  playersPerUniverse: 972,
  generatedPlayerSeasons: 120 * 972,
  universeFingerprint: fingerprint,
  nearZeroMedianTolerance:
    'q50 allows max(1.2 PPR, 12%); relative changes around zero are unstable',
  comparison:
    'Regression against packaged empirically validated pools; not a new independent NFL holdout.',
  rows,
};
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/universe_audit.json', JSON.stringify(summary, null, 2));
fs.writeFileSync(
  'artifacts/universe_metrics.csv',
  'position,season,metric,baseline,generated,relativeDifference,tolerance,pass\n' +
    rows.map((r) => Object.values(r).join(',')).join('\n') +
    '\n',
);
console.log(
  JSON.stringify(
    {
      passed: summary.passed,
      checks: checks.length,
      maxRelativeDelta: Math.max(
        ...rows
          .filter((r) => r.metric !== 'fortyPointRate')
          .map((r) => Math.abs(r.relativeDifference)),
      ),
      failures: rows.filter((r) => !r.pass),
    },
    null,
    2,
  ),
);
assert.ok(summary.passed, 'Browser universe distribution regression failed');
