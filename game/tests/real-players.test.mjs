import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadData } from '../server.mjs';
import { universeServices } from '../universe-store.mjs';
import { createUniverseResolver, pointsCents, historyFeatures } from '../universe.mjs';
import { applyAction } from '../engine.mjs';
import { playerProfile } from '../player-insights.mjs';
const data = loadData(),
  services = universeServices(data),
  resolve = createUniverseResolver(data);
const spec = (seed = 640) => ({
  id: 'real-test-' + seed,
  seed,
  baseVersion: data.catalog.version,
  season: 1,
  identityMode: 'real',
  realVersion: data.realPlayers.version,
  outcomeSeed: 111,
});
const byName = (c, name) => c.catalog.players.find((p) => p.name === name);
const total = (c, p, col = 0) => c.world[p.id].reduce((n, r) => n + r[col], 0);

test('new games contain authenticated real identities and coherent randomized career ages', () => {
  const r = services.create({}, null, 640, 'real-service'),
    c = r.context;
  assert.equal(r.universe.identityMode, 'real');
  assert.equal(c.catalog.identityMode, 'real');
  const source = new Map(data.realPlayers.players.map((p) => [p.id, p]));
  assert.ok(data.realPlayers.players.length > 2500);
  assert.equal(new Set(c.catalog.players.map((p) => p.realPlayerId)).size, 972);
  for (const p of c.catalog.players) {
    assert.equal(p.name, source.get(p.realPlayerId).name);
    assert.equal(p.position, source.get(p.realPlayerId).position);
    assert.equal(p.historyKind, 'alternate-career');
    assert.ok(p.ageRandomized);
    for (const h of p.history) {
      assert.equal(h.age, p.age - 1 + h.relative_season);
      assert.ok(h.age >= 20);
      assert.equal(h.scheduled_games, 17);
      assert.ok(h.games >= 0 && h.games <= 17);
      assert.equal(Math.round(h.ppr * 100), pointsCents(h));
    }
    const originals = source.get(p.realPlayerId).states.slice(0, p.history.length);
    p.history.forEach((h, i) => {
      const original = originals[i];
      assert.equal(h.relative_season, original.season - originals.at(-1).season);
      for (const key of [
        'attempts',
        'carries',
        'targets',
        'passing_yards',
        'rushing_yards',
        'receiving_yards',
      ]) {
        const equivalent = (original[key] * 17) / original.scheduled_games;
        assert.ok(
          Math.abs(h[key] - equivalent) <= Math.abs(equivalent) * 0.08 + 0.51,
          `${p.name} history must come from the same player`,
        );
      }
    });
    assert.equal(p.history.at(-1).age, p.age - 1);
    assert.ok(Math.abs(historyFeatures(p, 2026)[2] - p.history.at(-1).ppr) < 1e-9);
  }
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const cutoff = { QB: 15, RB: 9, WR: 9, TE: 6 }[pos],
      before = data.catalog.players.filter((p) => p.position === pos && p.basePpg > cutoff).length,
      after = c.catalog.players.filter((p) => p.position === pos && p.basePpg > cutoff).length;
    assert.ok(
      Math.abs(after - before) <= Math.max(3, before * 0.25),
      'Do not overcrowd historical star roles',
    );
  }
  for (const name of [
    'Lamar Jackson',
    'Patrick Mahomes',
    'Justin Jefferson',
    'Christian McCaffrey',
  ])
    assert.ok(byName(c, name), name);
});

test('a familiar player can have different plausible ages across new universes', () => {
  const ages = [];
  for (let seed = 1; seed <= 16; seed++)
    ages.push(byName(resolve(spec(seed)), 'Lamar Jackson').age);
  assert.ok(new Set(ages).size >= 4);
  assert.ok(ages.every((age) => age >= 21 && age <= 30));
});

test('identical names, ages, histories and ADP support many different future seasons', () => {
  const fixed = spec(641),
    first = resolve(fixed),
    catalog = JSON.stringify(first.catalog),
    samples = [];
  for (let n = 0; n < 18; n++) {
    const c = resolve({ ...fixed, outcomeSeed: 200 + n });
    assert.equal(JSON.stringify(c.catalog), catalog);
    const p = byName(c, 'Lamar Jackson');
    samples.push(total(c, p));
    assert.deepEqual(
      playerProfile({ observed: {}, week: 1, seasonYear: 2026 }, c.catalog, p.id, {
        designation: 'HEALTHY',
      }).outlook,
      playerProfile({ observed: {}, week: 1, seasonYear: 2026 }, first.catalog, p.id, {
        designation: 'HEALTHY',
      }).outlook,
    );
  }
  assert.ok(new Set(samples).size >= 12);
  assert.ok(Math.max(...samples) - Math.min(...samples) > 8000);
});

test('real identities and used identity registry survive a completed season and reconstruction', () => {
  const r = services.create({}, null, 644, 'real-career'),
    c = r.context;
  applyAction(r.state, { type: 'finishDraft' }, c.catalog, c.players, c.world);
  while (r.state.phase === 'season')
    applyAction(r.state, { type: 'advance' }, c.catalog, c.players, c.world);
  const next = services.create({ mode: 'continue' }, r, 1, 'ignored-new-id');
  assert.equal(next.universe.identityMode, 'real');
  assert.equal(next.universe.outcomeSeed, r.universe.outcomeSeed);
  for (const p of next.context.catalog.players) {
    const old = c.players.get(p.id);
    if (old) {
      assert.equal(p.name, old.name);
      assert.equal(p.realPlayerId, old.realPlayerId);
      assert.equal(p.age, old.age + 1);
      assert.equal(Math.round(p.history.at(-1).ppr * 100), total(c, old));
    }
  }
  const newPlayers = next.context.catalog.players.filter((p) => !c.players.has(p.id));
  assert.ok(newPlayers.length > 0);
  for (const p of newPlayers) {
    assert.ok(p.realPlayerId);
    assert.ok(!c.usedRealIds.includes(p.realPlayerId));
    assert.equal(p.history.length, 0);
  }
  const rebuilt = createUniverseResolver(data)(next.universe);
  assert.deepEqual(rebuilt.catalog, next.context.catalog);
  assert.deepEqual(rebuilt.world, next.context.world);
  assert.deepEqual(rebuilt.usedRealIds, next.context.usedRealIds);
});

test('changing the real career library cannot silently reconstruct an older named universe', () => {
  assert.throws(() => resolve({ ...spec(), realVersion: 'wrong' }), /original career library/);
  assert.throws(() => services.context({ universe: { ...spec(), outcomeSeed: -1 } }), /recipe/);
});

test('previously published fictional universes reconstruct byte-for-byte across seasons', async () => {
  const { readFile } = await import('node:fs/promises');
  const fixtures = JSON.parse(
    await readFile(new URL('./fixtures/legacy-universes.json', import.meta.url), 'utf8'),
  );
  const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
  for (const fixture of fixtures) {
    const c = resolve(fixture.spec);
    assert.equal(hash(c.catalog), fixture.catalog);
    assert.equal(hash(c.world), fixture.world);
  }
});
