import test from 'node:test';
import assert from 'node:assert/strict';
import { loadData } from '../server.mjs';
import { universeServices } from '../universe-store.mjs';
import {
  createUniverseResolver,
  pointsCents,
  historyFeatures,
  marketPriority,
} from '../universe.mjs';
import {
  BOX_FIELDS,
  historicalRanks,
  currentRanks,
  playerProfile,
  playerOutlook,
  statValue,
} from '../player-insights.mjs';
import { injuryReport } from '../injuries.mjs';
import {
  applyAction,
  assertLeague,
  hydrateLeague,
  ownerMap,
  publicState,
  GameError,
  autoPick,
} from '../engine.mjs';
import { weeklyRecap, yearlyRecap, captureWeek } from '../season-recaps.mjs';
import { NFL_CLUBS, ROSTER_SIZE } from '../config.mjs';
import { canAcquire, forecast } from '../strategy.mjs';
const data = loadData(),
  services = universeServices(data);
const fresh = (seed = 321) => services.create({ city: 'DET', slot: 6 }, null, seed, 'test-' + seed);
function draft(r) {
  const c = r.context;
  applyAction(r.state, { type: 'finishDraft' }, c.catalog, c.players, c.world);
  return r;
}
function move(r, action) {
  const c = r.context;
  return applyAction(r.state, action, c.catalog, c.players, c.world);
}

test('each fresh universe has new identities, histories, market prices and outcomes; reload is deterministic', () => {
  const a = fresh(321),
    b = fresh(322),
    c = createUniverseResolver(data)(a.universe);
  assert.deepEqual(a.context.catalog, c.catalog);
  assert.deepEqual(a.context.world, c.world);
  assert.notDeepEqual(a.context.catalog.players, b.context.catalog.players);
  assert.notDeepEqual(a.context.world, b.context.world);
  assert.equal(new Set(a.context.catalog.players.map((p) => p.name)).size, 972);
  assert.equal(a.context.catalog.players.length, 972);
  assert.equal(new Set(a.context.catalog.players.map((p) => p.id)).size, 972);
  assert.ok(a.context.catalog.players.every((p) => !b.context.players.has(p.id)));
  assert.notDeepEqual(
    [...a.context.catalog.players].sort((a, b) => a.id.localeCompare(b.id)).map((p) => p.adp),
    [...b.context.catalog.players].sort((a, b) => a.id.localeCompare(b.id)).map((p) => p.adp),
  );
  for (const p of a.context.catalog.players) {
    assert.ok(Number.isFinite(p.adp));
    assert.ok(p.history.every((h) => h.age >= 20));
    assert.ok(p.history.every((h) => Math.abs(h.ppr * 100 - pointsCents(h)) < 0.001));
  }
  assert.equal(new Set(a.state.teams.map((t) => t.abbreviation)).size, 12);
  assert.equal(a.state.teams[6].name, 'Detroit · DET');
  assert.ok(
    a.state.teams.every((t) =>
      NFL_CLUBS.some((c) => c.city === t.city && c.abbreviation === t.abbreviation),
    ),
  );
});

test('new worlds keep position populations, byes and physical box-score accounting', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const r = fresh(seed),
      c = r.context;
    for (const pos of ['QB', 'RB', 'WR', 'TE'])
      assert.equal(
        c.catalog.players.filter((p) => p.position === pos).length,
        data.catalog.players.filter((p) => p.position === pos).length,
      );
    for (const p of c.catalog.players) {
      const rows = c.world[p.id];
      assert.equal(rows.length, 18);
      assert.ok(rows[p.bye - 1].every((n) => n === 0));
      for (const row of rows) {
        assert.ok(row.every(Number.isInteger));
        assert.equal(row.length, 17);
        assert.equal(
          row[0],
          pointsCents(Object.fromEntries(BOX_FIELDS.map((k, i) => [k, row[i + 1]]))),
        );
        assert.ok(row[2] <= row[1]);
        assert.ok(row[10] <= row[9]);
        if (!row.at(-1)) assert.ok(row.every((n) => n === 0));
      }
    }
  }
});

test('pricing and public profiles never read hidden season scores', () => {
  const a = fresh(912),
    altered = structuredClone(data);
  altered.privateData.worlds.forEach((w) =>
    Object.values(w).forEach((rows) =>
      rows.forEach((r) => {
        r[0] += 100000;
      }),
    ),
  );
  const b = createUniverseResolver(altered)(a.universe);
  assert.deepEqual(a.context.catalog, b.catalog);
  const p = a.context.catalog.players[0],
    s = a.state;
  const h = injuryReport(s, p, a.context.world),
    out = playerOutlook(s, p, h, null, 1);
  assert.deepEqual(out, playerOutlook(s, p, h, null, 1));
  assert.deepEqual(
    playerProfile(s, a.context.catalog, p.id, h),
    playerProfile(s, b.catalog, p.id, h),
  );
  assert.ok(!JSON.stringify(out).includes('sourceMap'));
  assert.equal(historyFeatures({ age: 22, history: [] }, 2026).at(-1), 1);
  assert.ok(Number.isFinite(marketPriority(p, 2026, data.adpModel)));
});

test('PPR positional ranks qualify production, respect competition ties and preserve actual historical finishes', () => {
  const make = (id, pos, pts, att = 1) => ({
    id,
    position: pos,
    age: 26,
    history: [{ relative_season: 0, games: 1, ppr: pts, attempts: att }],
  });
  const cat = {
    players: [
      make('a', 'QB', 20),
      make('b', 'QB', 20),
      make('c', 'QB', 10),
      make('idle', 'QB', 0, 0),
      make('wr', 'WR', 5),
    ],
  };
  assert.deepEqual(historicalRanks(cat)[0], { a: 1, b: 1, c: 3, wr: 1 });
  const saved = {
    players: [
      { ...cat.players[2], history: [{ ...cat.players[2].history[0], positionFinish: 3 }] },
    ],
  };
  assert.equal(historicalRanks(saved)[0].c, 3);
  const s = {
    observed: {
      a: { games: 2, points: 4000, totals: { attempts: 20 } },
      b: { games: 2, points: 4000, totals: { attempts: 25 } },
      idle: { games: 1, points: 0, totals: {} },
    },
    seasonYear: 2026,
  };
  assert.deepEqual(currentRanks(s, cat), { a: 1, b: 1 });
  assert.ok(
    Math.abs(statValue({ completions: 20, attempts: 30 }, 'completion_pct') - 200 / 3) < 1e-10,
  );
  assert.equal(statValue({ carries: 0 }, 'rushing_ypc'), null);
});

test('IR eligibility, two-slot limit, ownership, empty-slot pickup and recovered-player enforcement', () => {
  const r = draft(fresh(113)),
    { state: s, context: c } = r,
    t = s.teams[s.human];
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const owned = ownerMap(s);
    const target = c.catalog.players.find(
      (p) =>
        !owned.has(p.id) &&
        injuryReport(s, p, c.world).irEligible &&
        [null, ...t.roster].some((drop) => canAcquire(t.roster, p.id, drop, c.players)),
    );
    assert.ok(target);
    const drop = [null, ...t.roster].find((drop) =>
      canAcquire(t.roster, target.id, drop, c.players),
    );
    move(r, { type: 'add', add: target.id, drop });
    ids.push(target.id);
    if (i < 2) move(r, { type: 'reserve', player: target.id });
  }
  assert.equal(t.ir.length, 2);
  assert.ok(!t.roster.includes(ids[0]));
  assert.ok(!t.lineup.includes(ids[0]));
  assert.equal(ownerMap(s).get(ids[0]), s.human);
  assert.throws(() => move(r, { type: 'reserve', player: ids[2] }), /Both injured/);
  const releasable = t.roster.find((id) =>
    canAcquire(
      t.roster.filter((x) => x !== id),
      ids[0],
      null,
      c.players,
    ),
  );
  move(r, { type: 'release', player: releasable });
  const free = c.catalog.players.find(
    (p) =>
      !ownerMap(s).has(p.id) && canAcquire(t.roster, p.id, null, c.players) && !s.availableAt[p.id],
  );
  move(r, { type: 'add', add: free.id, drop: null });
  assert.equal(t.roster.length, 14);
  assert.throws(
    () => move(r, { type: 'add', add: ids[0], drop: t.roster.at(-1) }),
    /no longer available/,
  );
  // Force return news through a separate world copy; recovery must be resolved.
  const returned = structuredClone(c.world);
  returned[ids[0]][0].fill(0);
  returned[ids[0]][0][16] = 1;
  assert.throws(() => applyAction(s, { type: 'advance' }, c.catalog, c.players, returned), /IR/);
  const drop = t.roster.find((id) => canAcquire(t.roster, ids[0], id, c.players));
  move(r, { type: 'activate', player: ids[0], drop });
  assert.ok(t.roster.includes(ids[0]));
  assert.ok(!t.ir.includes(ids[0]));
});

test('injury reports give uncertain ranges, no exact hidden endpoint; byes alone never qualify', () => {
  const r = fresh(39),
    { catalog, world } = r.context;
  let estimates = 0,
    ir = 0;
  for (let week = 1; week <= 18; week++)
    for (const p of catalog.players) {
      const h = injuryReport({ ...r.state, week, phase: 'season' }, p, world);
      assert.ok(!('end' in h));
      assert.ok(!('minReturn' in h));
      if (h.kind === 'injury') {
        estimates++;
        assert.ok(h.returnEstimate.high > h.returnEstimate.low);
        assert.ok(h.returnEstimate.low >= 1);
        if (h.designation === 'IR') ir++;
      } else if (h.designation === 'BYE') assert.equal(h.irEligible, false);
    }
  assert.ok(estimates > 0 && ir > 0);
});

test('weekly report cards grade pregame decisions separately from hindsight and detect bad beats', () => {
  const r = draft(fresh(27));
  move(r, { type: 'optimize' });
  move(r, { type: 'advance' });
  const { state: s, context: c } = r,
    rec = weeklyRecap(s, c.catalog, 1);
  assert.equal(rec.lineupGrade, 'A');
  assert.ok(rec.pointsOnBench >= 0);
  assert.ok(rec.allPlayWins >= 0 && rec.allPlayWins <= 11);
  assert.equal(s.weekRecords.length, 1);
  assert.deepEqual(publicState(s, c.catalog, c.players, c.world).latestRecap, rec);
  const saved = structuredClone(rec),
    prior = structuredClone(s.weekRecords[0]);
  const game = s.results.find((g) => g.week === 1 && (g.a === s.human || g.b === s.human));
  const other = game.a === s.human ? game.b : game.a;
  s.weekRecords[0].teams.forEach((t) => (t.score = 10000));
  s.weekRecords[0].teams[s.human].score = 15000;
  s.weekRecords[0].teams[other].score = 16000;
  game.winner = other;
  game.sa = game.a === s.human ? 15000 : 16000;
  game.sb = game.b === s.human ? 15000 : 16000;
  assert.equal(weeklyRecap(s, c.catalog, 1).headline, 'The schedule had other ideas');
  s.weekRecords[0] = prior;
  // A roster move cannot rewrite the locked week or its coach score.
  s.teams[s.human].lineup = Array(8).fill(null);
  assert.equal(weeklyRecap(s, c.catalog, 1).lineupGrade, saved.lineupGrade);
  assert.equal(weeklyRecap(s, c.catalog, 1).pointsOnBench, saved.pointsOnBench);
  assert.equal(weeklyRecap(s, c.catalog, 18), null);
  s.weekRecords[0].teams.forEach((t) => (t.score = 0));
  const tied = weeklyRecap(s, c.catalog, 1);
  assert.equal(tied.allPlayWins, 0);
  assert.equal(tied.allPlayLosses, 0);
  assert.equal(tied.allPlayTies, 11);
});

test('complete new universes can continue with ages, completed histories and frozen finishes; fresh starts differ', () => {
  const r = draft(fresh(901));
  assert.throws(() => services.create({ mode: 'continue' }, r, 12, 'next'), GameError);
  while (r.state.phase === 'season') {
    move(r, { type: 'optimize' });
    move(r, { type: 'advance' });
    assertLeague(r.state, r.context.players);
  }
  const recap = yearlyRecap(r.state, r.context.catalog);
  assert.ok(recap);
  assert.ok(recap.processDraftRank >= 1 && recap.processDraftRank <= 12);
  assert.equal(r.state.weekRecords.length, 18);
  const next = services.create({ mode: 'continue' }, r, 44, 'next');
  assert.equal(next.universe.id, r.universe.id);
  assert.equal(next.state.seasonYear, 2027);
  assert.equal(next.state.phase, 'draft');
  let retained = 0;
  for (const p of next.context.catalog.players) {
    const old = r.context.players.get(p.id);
    if (!old) continue;
    retained++;
    assert.equal(p.age, old.age + 1);
    assert.equal(p.name, old.name);
    assert.equal(p.history.length, old.history.length + 1);
    const h = p.history.at(-1);
    assert.equal(
      Math.round(h.ppr * 100),
      r.context.world[p.id].reduce((n, w) => n + w[0], 0),
    );
    assert.equal(h.relative_season, 0);
    for (let i = 0; i < old.history.length; i++)
      assert.equal(p.history[i].positionFinish, old.history[i].positionFinish);
  }
  assert.ok(retained > 800);
  const reloaded = createUniverseResolver(data)(next.universe);
  assert.deepEqual(reloaded.catalog, next.context.catalog);
  assert.deepEqual(reloaded.world, next.context.world);
  assert.notEqual(fresh(902).universe.id, next.universe.id);
});

test('legacy saves retain human extra bench players for explicit migration and rebuild only completed statistics', () => {
  const r = draft(fresh(88)),
    { state: s, context: c } = r;
  move(r, { type: 'advance' });
  delete s.statsSchema;
  delete s.rules;
  delete s.weekRecords;
  const t = s.teams[s.human],
    owned = ownerMap(s),
    extras = c.catalog.players
      .filter((p) => !owned.has(p.id) && p.position === 'WR')
      .slice(0, 2)
      .map((p) => p.id);
  t.roster.push(...extras);
  const before = [...t.roster];
  hydrateLeague(s, c.catalog, c.players, c.world);
  assert.deepEqual(t.roster, before);
  assert.equal(t.legacyOverflow, 2);
  assert.equal(s.rules.benchSize, 6);
  assert.equal(s.rules.irSize, 2);
  for (const p of c.catalog.players) {
    assert.equal(s.observed[p.id]?.points ?? 0, c.world[p.id][0][0]);
  }
  assert.throws(() => move(r, { type: 'advance' }), /extra bench/);
  extras.forEach((player) => move(r, { type: 'release', player }));
  assert.equal(t.roster.length, 14);
  assertLeague(s, c.players);
});

test('an old draft already past round fourteen opens the season without losing picks or players', () => {
  const r = draft(fresh(411)),
    s = r.state,
    c = r.context;
  const free = c.catalog.players
    .filter((p) => !ownerMap(s).has(p.id) && p.position === 'WR')
    .slice(0, 6);
  for (let i = 0; i < 6; i++) {
    s.teams[i].roster.push(free[i].id);
    s.picks.push({ pick: 169 + i, round: 15, team: i, player: free[i].id });
  }
  s.phase = 'draft';
  s.pick = 174;
  delete s.rules;
  const before = structuredClone(s.teams.map((t) => t.roster));
  hydrateLeague(s, c.catalog, c.players, c.world);
  assert.equal(s.phase, 'season');
  assert.deepEqual(
    s.teams.map((t) => t.roster),
    before,
  );
  assert.equal(s.picks.length, 174);
});

test('an older save with no roster snapshots gets no invented coaching grade', () => {
  const r = draft(fresh(426));
  while (r.state.phase === 'season') move(r, { type: 'advance' });
  const expected = yearlyRecap(r.state, r.context.catalog).outcomeDraftRank;
  r.state.weekRecords = [];
  const recap = yearlyRecap(r.state, r.context.catalog);
  assert.equal(recap.outcomeDraftRank, expected);
  assert.equal(recap.lineupGrade, null);
  assert.equal(recap.injuryImpact, null);
  assert.equal(recap.recordedWeeks, 0);
});
