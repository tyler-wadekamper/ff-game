import test from 'node:test';
import assert from 'node:assert/strict';
import { loadData } from '../server.mjs';
import {
  createLeague,
  random,
  draftTeam,
  roundRobin,
  autoPick,
  applyAction,
  advanceWeek,
  publicState,
  selectDraft,
  assertLeague,
  submitClaim,
  resolveClaims,
  weekMatchups,
  validateLineup,
  GameError,
} from '../engine.mjs';
import {
  optimalLineup,
  canSwap,
  rosterComplete,
  forecast,
  eligible,
  PROFILES,
} from '../strategy.mjs';

const { catalog, privateData, players } = loadData();
const world = (s) => privateData.worlds[s.world];
function fresh(seed = 123, human = 6) {
  return createLeague({
    name: 'Test Franchise',
    slot: human,
    seed,
    version: catalog.version,
    worlds: privateData.worlds.length,
  });
}
function drafted(seed = 123, human = 6) {
  const s = fresh(seed, human);
  while (s.phase === 'draft') autoPick(s, catalog, players);
  assertLeague(s, players);
  return s;
}
function freeSwap(s, t = s.teams[s.human], exclude = []) {
  const owned = new Set(s.teams.flatMap((t) => t.roster));
  for (const a of catalog.players) {
    if (owned.has(a.id) || exclude.includes(a.id)) continue;
    for (const drop of [...t.roster].reverse())
      if (canSwap(t.roster, a.id, drop, players)) return { add: a.id, drop };
  }
  throw Error('No swap');
}

test('packaged worlds contain 18 conserving calendar weeks with fixed club byes', () => {
  assert.equal(catalog.players.length, 972);
  assert.equal(new Set(catalog.players.map((p) => p.name)).size, 972);
  assert.equal(catalog.version, privateData.version);
  assert.equal(privateData.worlds.length, 12);
  for (const w of privateData.worlds)
    for (const p of catalog.players) {
      const rows = w[p.id];
      assert.equal(rows.length, 18);
      assert.ok(rows[p.bye - 1].every((n) => n === 0));
      for (const r of rows) {
        assert.equal(r.length, 17);
        assert.ok(r.every(Number.isInteger));
        assert.ok(r[2] <= r[1]);
        assert.ok(r[10] <= r[9]);
        const points =
          4 * r[3] +
          10 * (r[7] + r[11]) +
          400 * r[4] +
          600 * (r[8] + r[12]) +
          100 * r[10] -
          200 * (r[5] + r[13] + r[14] + r[15]);
        assert.equal(r[0], points);
        if (!r.at(-1)) assert.ok(r.every((v) => v === 0));
      }
    }
});
test('snake order reverses exactly at each turn', () => {
  assert.deepEqual(
    Array.from({ length: 24 }, (_, i) => draftTeam(i)),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  );
});
test('round robin covers every opponent once before repeats', () => {
  const schedule = roundRobin(),
    pairs = new Set();
  assert.equal(schedule.length, 14);
  for (const week of schedule.slice(0, 11)) {
    assert.equal(new Set(week.flat()).size, 12);
    for (const pair of week) pairs.add([...pair].sort((a, b) => a - b).join(':'));
  }
  assert.equal(pairs.size, 66);
});
test('every draft slot can finish a complete 192-pick draft', () => {
  for (let slot = 0; slot < 12; slot++) {
    const s = drafted(10 + slot, slot);
    assert.equal(s.picks.length, 192);
    assert.equal(new Set(s.picks.map((x) => x.player)).size, 192);
    for (const t of s.teams) {
      assert.equal(t.roster.length, 16);
      assert.ok(rosterComplete(t.roster, players));
      validateLineup(t, t.lineup, players);
    }
  }
});
test('all eleven opponent personalities are represented in each league', () => {
  const s = fresh();
  assert.deepEqual(
    s.teams
      .filter((t) => t.profile)
      .map((t) => t.profile.plan)
      .sort(),
    PROFILES.map((p) => p.plan).sort(),
  );
});
test('duplicate draft selections are rejected', () => {
  const s = fresh();
  autoPick(s, catalog, players);
  assert.throws(() => selectDraft(s, s.picks[0].player, catalog, players), GameError);
});
test('draft choices are independent of hidden season outcomes', () => {
  const a = fresh(334),
    b = structuredClone(a);
  a.world = 0;
  b.world = 11;
  while (a.phase === 'draft') {
    autoPick(a, catalog, players);
    autoPick(b, catalog, players);
  }
  assert.deepEqual(a.picks, b.picks);
});
test('queued players are taken first on the human turn', () => {
  const s = fresh();
  while (draftTeam(s.pick) !== s.human) autoPick(s, catalog, players);
  const wanted = catalog.players[30].id;
  s.queue = [wanted];
  autoPick(s, catalog, players);
  assert.equal(s.picks.at(-1).player, wanted);
});
test('a lineup cannot contain a duplicate, another owner’s player, or a QB in FLEX', () => {
  const s = drafted(),
    t = s.teams[s.human],
    lineup = [...t.lineup];
  const duplicate = [...lineup];
  duplicate[6] = lineup[1];
  assert.throws(() => validateLineup(t, duplicate, players), GameError);
  const wrong = [...lineup];
  wrong[6] = lineup[0];
  wrong[0] = null;
  assert.throws(() => validateLineup(t, wrong, players), GameError);
  const outsider = [...lineup];
  outsider[0] = s.teams[0].roster[0];
  assert.throws(() => validateLineup(t, outsider, players), GameError);
});
test('lineup optimizer agrees with an exhaustive assignment on overlapping FLEX slots', () => {
  const items = [
    ['q', 'QB', 14],
    ['r1', 'RB', 6],
    ['r2', 'RB', 10],
    ['r3', 'RB', 19],
    ['w1', 'WR', 8],
    ['w2', 'WR', 17],
    ['w3', 'WR', 20],
    ['t1', 'TE', 9],
    ['t2', 'TE', 21],
  ];
  const m = new Map(items.map(([id, position, value]) => [id, { id, position, value }])),
    ids = [...m.keys()],
    slots = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'FLEX'];
  let best = -Infinity;
  function enumerate(i, used, total) {
    if (i === 8) {
      best = Math.max(best, total);
      return;
    }
    for (const id of ids)
      if (!used.has(id) && eligible(m.get(id).position, slots[i])) {
        used.add(id);
        enumerate(i + 1, used, total + m.get(id).value);
        used.delete(id);
      }
  }
  enumerate(0, new Set(), 0);
  const chosen = optimalLineup(ids, m, (p) => p.value);
  assert.equal(
    chosen.reduce((sum, id) => sum + m.get(id).value, 0),
    best,
  );
});
test('optimization responds to current availability but cannot see future points', () => {
  const s = drafted(),
    a = structuredClone(s),
    b = structuredClone(s),
    wa = structuredClone(world(s)),
    wb = structuredClone(world(s));
  for (const rows of Object.values(wb)) for (const row of rows) row[0] = 999999;
  applyAction(a, { type: 'optimize' }, catalog, players, wa);
  applyAction(b, { type: 'optimize' }, catalog, players, wb);
  assert.deepEqual(a.teams[a.human].lineup, b.teams[b.human].lineup);
});
test('weekly points come from frozen starters and exact integer-cent results', () => {
  const s = drafted();
  applyAction(s, { type: 'optimize' }, catalog, players, world(s));
  const t = s.teams[s.human],
    ids = [...t.lineup];
  const expected = ids.reduce((sum, id) => sum + (id ? world(s)[id][0][0] : 0), 0);
  advanceWeek(s, catalog, players, world(s));
  const game = s.results.find((g) => g.a === s.human || g.b === s.human);
  assert.equal(game.a === s.human ? game.sa : game.sb, expected);
  t.lineup = Array(8).fill(null);
  assert.deepEqual(game.a === s.human ? game.aLineup : game.bLineup, ids);
});
test('visible state withholds world, random seed, opponent bids and future weeks', () => {
  const s = drafted(),
    swap = freeSwap(s, s.teams[0]);
  s.claims.push({ ...swap, bid: 20, team: 0 });
  const view = publicState(s, catalog, players, world(s));
  assert.ok(!('world' in view));
  assert.ok(!('rng' in view));
  assert.equal(view.claims.length, 0);
  assert.ok(Object.values(view.pastPoints).every((rows) => rows.length === 0));
  assert.deepEqual(view.observed, {});
  advanceWeek(s, catalog, players, world(s));
  const next = publicState(s, catalog, players, world(s));
  assert.ok(Object.values(next.pastPoints).every((rows) => rows.length === 1));
});
test('FAAB highest bid wins, and only the winning team pays', () => {
  const s = drafted(),
    a = s.teams[0],
    b = s.teams[1],
    owned = new Set(s.teams.flatMap((t) => t.roster));
  let add, da, db;
  for (const p of catalog.players.filter((p) => !owned.has(p.id))) {
    da = a.roster.find((d) => canSwap(a.roster, p.id, d, players));
    db = b.roster.find((d) => canSwap(b.roster, p.id, d, players));
    if (da && db) {
      add = p.id;
      break;
    }
  }
  s.claims = [
    { team: 0, add, drop: da, bid: 19 },
    { team: 1, add, drop: db, bid: 20 },
  ];
  resolveClaims(s, players);
  assert.ok(b.roster.includes(add));
  assert.equal(a.faab, 100);
  assert.equal(b.faab, 80);
  assert.equal(s.transactions.length, 1);
});
test('FAAB equal bids favor worse standings', () => {
  const s = drafted(),
    a = s.teams[0],
    b = s.teams[1];
  a.wins = 3;
  b.losses = 3;
  const swap = freeSwap(s, a);
  const drop = b.roster.find((d) => canSwap(b.roster, swap.add, d, players));
  assert.ok(drop);
  s.claims = [
    { team: 0, ...swap, bid: 7 },
    { team: 1, add: swap.add, drop, bid: 7 },
  ];
  resolveClaims(s, players);
  assert.ok(b.roster.includes(swap.add));
  assert.equal(b.faab, 93);
});
test('overcommitted claims never spend beyond budget or drop the same player twice', () => {
  const s = drafted(),
    t = s.teams[s.human],
    one = freeSwap(s, t),
    two = freeSwap(s, t, [one.add]);
  t.faab = 10;
  s.claims = [
    { team: t.id, ...one, bid: 8 },
    { team: t.id, ...two, bid: 8 },
  ];
  resolveClaims(s, players);
  assert.equal(t.faab, 2);
  assert.equal(s.transactions.length, 1);
  assertLeague(s, players);
});
test('waiver inputs reject overspending, fractions, rostered targets and invalid drops', () => {
  const s = drafted(),
    t = s.teams[s.human],
    swap = freeSwap(s, t);
  for (const bid of [-1, 101, 1.5, NaN])
    assert.throws(() => submitClaim(s, t, { ...swap, bid }, players), GameError);
  assert.throws(
    () => submitClaim(s, t, { add: s.teams[0].roster[0], drop: swap.drop, bid: 1 }, players),
    GameError,
  );
  assert.throws(
    () => submitClaim(s, t, { ...swap, drop: s.teams[0].roster[0], bid: 1 }, players),
    GameError,
  );
});
test('dropped players cannot be recycled in the same week', () => {
  const s = drafted(),
    t = s.teams[s.human],
    swap = freeSwap(s, t);
  applyAction(s, { type: 'add', ...swap }, catalog, players, world(s));
  assert.equal(s.availableAt[swap.drop], 2);
  assert.throws(
    () =>
      applyAction(s, { type: 'add', add: swap.drop, drop: swap.add }, catalog, players, world(s)),
    GameError,
  );
});
test('waivers process at most once each week', () => {
  const s = drafted();
  applyAction(s, { type: 'waivers' }, catalog, players, world(s));
  const balances = s.teams.map((t) => t.faab);
  assert.throws(() => applyAction(s, { type: 'waivers' }, catalog, players, world(s)), GameError);
  assert.deepEqual(
    s.teams.map((t) => t.faab),
    balances,
  );
});
test('a JSON save/resume preserves subsequent decisions and results', () => {
  const a = drafted(448);
  advanceWeek(a, catalog, players, world(a));
  const b = JSON.parse(JSON.stringify(a));
  advanceWeek(a, catalog, players, world(a));
  advanceWeek(b, catalog, players, world(b));
  assert.deepEqual(a, b);
});
test('all 12 packaged worlds can play all 18 weeks without accounting or bracket failures', () => {
  for (let wi = 0; wi < 12; wi++) {
    const s = drafted(934 + wi);
    s.world = wi;
    while (s.phase === 'season') {
      applyAction(s, { type: 'optimize' }, catalog, players, world(s));
      applyAction(s, { type: 'advance' }, catalog, players, world(s));
      assertLeague(s, players);
      assert.ok(s.teams.every((t) => t.faab >= 0));
    }
    assert.equal(s.week, 19);
    assert.ok(Number.isInteger(s.champion));
    assert.equal(s.results.filter((g) => g.kind === 'Championship').length, 1);
    assert.equal(s.results.filter((g) => g.week === 18).length, 6);
    assert.equal(
      s.teams.reduce((n, t) => n + t.wins + t.losses + t.ties, 0),
      168,
    );
    const seeds = s.playoffs.seeds;
    assert.ok(
      s.results
        .filter((g) => g.kind === 'Quarterfinal')
        .every((g) => ![seeds[0], seeds[1]].includes(g.a) && ![seeds[0], seeds[1]].includes(g.b)),
    );
    const championship = s.results.find((g) => g.kind === 'Championship');
    assert.equal(s.champion, championship.winner);
  }
});
test('playoff ties advance the higher seed and week 18 cannot change the champion', () => {
  const s = drafted(622);
  while (s.week < 15) advanceWeek(s, catalog, players, world(s));
  const zeros = structuredClone(world(s));
  for (const rows of Object.values(zeros)) for (const row of rows) row[0] = 0;
  const expected = s.playoffs.seeds[0];
  while (s.week < 18) advanceWeek(s, catalog, players, zeros);
  assert.equal(s.champion, expected);
  const pf = s.teams.map((t) => t.pf);
  advanceWeek(s, catalog, players, zeros);
  assert.equal(s.champion, expected);
  assert.deepEqual(
    s.teams.map((t) => t.pf),
    pf,
  );
});
