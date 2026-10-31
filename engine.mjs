import {
  SLOTS,
  POSITIONS,
  PROFILES,
  eligible,
  rosterComplete,
  canDraft,
  canSwap,
  forecast,
  pickPlayer,
  optimalLineup,
  rosterFeasible,
  canAcquire,
} from './strategy.mjs';
import {
  ROSTER_SIZE,
  IR_SIZE,
  DRAFT_PICKS,
  DRAFT_ROUNDS,
  NFL_CLUBS,
  clubInfo,
  shuffled,
} from './config.mjs';
import { injuryReport } from './injuries.mjs';
import { BOX_FIELDS, currentRanks } from './player-insights.mjs';
import { captureWeek, weeklyRecap, yearlyRecap } from './season-recaps.mjs';
export { SLOTS, PROFILES, forecast, rosterComplete };
export const HUMAN_PROFILE = { plan: 'value', skill: 0.85, noise: 0.08 };
export class GameError extends Error {}
const ensure = (test, message) => {
  if (!test) throw new GameError(message);
};
export function random(state) {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export function draftTeam(pick) {
  const round = Math.floor(pick / 12);
  return round % 2 ? 11 - (pick % 12) : pick % 12;
}
export function roundRobin() {
  let circle = Array.from({ length: 12 }, (_, i) => i);
  const rounds = [];
  for (let r = 0; r < 11; r++) {
    rounds.push(Array.from({ length: 6 }, (_, i) => [circle[i], circle[11 - i]]));
    circle = [circle[0], circle[11], ...circle.slice(1, 11)];
  }
  return [...rounds, ...rounds.slice(0, 3).map((pairs) => pairs.map(([a, b]) => [b, a]))];
}
export function createLeague({
  name = 'Your Franchise',
  slot = 6,
  seed = 12345,
  version,
  worlds = 12,
  city = 'DET',
  franchises = null,
  seasonYear = 2026,
  universe = null,
} = {}) {
  ensure(Number.isInteger(slot) && slot >= 0 && slot < 12, 'Choose a draft slot from 1 to 12.');
  ensure(
    typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 32,
    'Team names need 1–32 characters.',
  );
  const state = {
    version,
    revision: 0,
    rng: seed >>> 0,
    phase: 'draft',
    week: 1,
    human: slot,
    pick: 0,
    picks: [],
    queue: [],
    teams: [],
    schedule: roundRobin(),
    results: [],
    lineupHistory: [],
    observed: {},
    claims: [],
    transactions: [],
    waiversProcessed: false,
    availableAt: {},
    playoffs: null,
    champion: null,
    seasonYear,
    universe,
    rules: { rosterSize: ROSTER_SIZE, benchSize: 6, irSize: IR_SIZE, draftRounds: DRAFT_ROUNDS },
    statsSchema: 2,
    irMoves: [],
    weekRecords: [],
  };
  const profiles = PROFILES.map((p) => ({ ...p }));
  // Strategy locations change between leagues; quality and personalities remain legible.
  for (let n = profiles.length - 1; n > 0; n--) {
    const k = Math.floor(random(state) * (n + 1));
    [profiles[n], profiles[k]] = [profiles[k], profiles[n]];
  }
  const home = clubInfo(city),
    choices = franchises
      ? franchises
          .filter((t) => t.club !== home.id)
          .map((t) => ({ ...clubInfo(t.club), profile: t.profile }))
      : shuffled(
          NFL_CLUBS.filter((c) => c.id !== home.id),
          () => random(state),
        ).slice(0, 11);
  for (let i = 0; i < 12; i++) {
    const club = i === slot ? home : choices.pop();
    const profile = i === slot ? null : (club.profile ?? profiles.pop());
    state.teams.push({
      id: i,
      name: club.city + ' · ' + club.abbreviation,
      city: club.city,
      abbreviation: club.abbreviation,
      club: club.id,
      profile,
      roster: [],
      lineup: Array(8).fill(null),
      wins: 0,
      losses: 0,
      ties: 0,
      pf: 0,
      pa: 0,
      faab: 100,
      waiverPriority: 12 - i,
      ir: [],
    });
  }
  state.world = Math.floor(random(state) * worlds);
  return state;
}
export function ownerMap(state) {
  return new Map(
    state.teams.flatMap((t) => [...t.roster, ...(t.ir ?? [])].map((id) => [id, t.id])),
  );
}
export function availablePlayers(state, catalog) {
  const owned = ownerMap(state);
  return catalog.players.filter((p) => !owned.has(p.id));
}
export function standings(state) {
  return [...state.teams].sort(
    (a, b) => 2 * b.wins + b.ties - (2 * a.wins + a.ties) || b.pf - a.pf || a.id - b.id,
  );
}
export function selectDraft(state, id, catalog, players) {
  ensure(state.phase === 'draft' && state.pick < DRAFT_PICKS, 'The draft is complete.');
  const team = state.teams[draftTeam(state.pick)],
    p = players.get(id);
  ensure(p && !ownerMap(state).has(id), 'That player has already been drafted.');
  ensure(canDraft(team.roster, p, players), 'That pick would prevent a complete starting roster.');
  const pick = state.pick++;
  team.roster.push(id);
  state.queue = state.queue.filter((x) => x !== id);
  state.picks.push({ pick: pick + 1, round: Math.floor(pick / 12) + 1, team: team.id, player: id });
  if (state.pick === DRAFT_PICKS) {
    state.phase = 'season';
    for (const t of state.teams) {
      ensure(rosterComplete(t.roster, players), 'Draft produced an incomplete roster.');
      t.lineup = optimalLineup(t.roster, players, (p) => p.basePpg);
    }
  }
}
export function autoPick(state, catalog, players) {
  const team = state.teams[draftTeam(state.pick)];
  let id =
    team.id === state.human
      ? state.queue.find(
          (id) =>
            players.has(id) &&
            !ownerMap(state).has(id) &&
            canDraft(team.roster, players.get(id), players),
        )
      : null;
  if (!id)
    id = pickPlayer({
      roster: team.roster,
      available: availablePlayers(state, catalog),
      players,
      profile: team.profile ?? HUMAN_PROFILE,
      round: Math.floor(state.pick / 12) + 1,
      random: () => random(state),
    }).id;
  selectDraft(state, id, catalog, players);
}
export function botsUntilHuman(state, catalog, players) {
  while (state.phase === 'draft' && draftTeam(state.pick) !== state.human)
    autoPick(state, catalog, players);
}
export function weekStatus(state, p, world) {
  if (state.phase === 'complete' || state.week > 18) return 'FINISHED';
  if (p.bye === state.week) return 'BYE';
  // Availability is published for this scoring week only, never future weeks.
  return world[p.id][state.week - 1].at(-1) ? 'ACTIVE' : 'OUT';
}
export function weeklyProjection(state, p, world) {
  return weekStatus(state, p, world) === 'ACTIVE' ? forecast(p, state.observed) : 0;
}
export function validateLineup(team, lineup, players) {
  ensure(Array.isArray(lineup) && lineup.length === 8, 'A lineup has eight starting slots.');
  const ids = lineup.filter(Boolean);
  ensure(new Set(ids).size === ids.length, 'A player can start only once.');
  lineup.forEach((id, i) =>
    ensure(
      id === null || (team.roster.includes(id) && eligible(players.get(id).position, SLOTS[i])),
      `Invalid player for ${SLOTS[i]}.`,
    ),
  );
}
export function optimizeTeam(state, team, players, world) {
  const values = new Map(
    team.roster.map((id) => {
      const p = players.get(id),
        base = weeklyProjection(state, p, world),
        noise = team.profile ? (1 - team.profile.skill) * 0.45 : 0;
      return [id, base * (1 + noise * (random(state) - 0.5))];
    }),
  );
  team.lineup = optimalLineup(team.roster, players, (p) => values.get(p.id));
}
function swap(state, team, add, drop, players, source, bid = 0) {
  ensure(
    canAcquire(team.roster, add, drop, players),
    'Keep at least 1 QB, 2 RB, 2 WR, 1 TE and seven non-QBs.',
  );
  team.roster = team.roster.filter((id) => id !== drop).concat(add);
  team.lineup = team.lineup.map((id, i) =>
    id === drop ? (eligible(players.get(add).position, SLOTS[i]) ? add : null) : id,
  );
  if (drop) state.availableAt[drop] = state.week + 1;
  if (!drop) {
    const slot = team.lineup.findIndex(
      (id, i) => !id && eligible(players.get(add).position, SLOTS[i]),
    );
    if (slot >= 0) team.lineup[slot] = add;
  }
  state.transactions.push({ week: state.week, team: team.id, add, drop, bid, source });
}
function unresolvedIR(state, team, players, world) {
  return (team.ir ?? []).some(
    (id) => !world || !injuryReport(state, players.get(id), world).irEligible,
  );
}
export function moveToIR(state, team, id, players, world) {
  ensure(state.phase === 'season', 'IR opens after the draft.');
  ensure(team.roster.includes(id), 'Only an active-roster player can move to IR.');
  ensure((team.ir ?? []).length < IR_SIZE, 'Both injured-reserve slots are full.');
  ensure(
    injuryReport(state, players.get(id), world).irEligible,
    'Only a medically OUT or IR player qualifies. Byes and nonmedical inactivity do not.',
  );
  team.ir ??= [];
  team.ir.push(id);
  team.roster = team.roster.filter((p) => p !== id);
  team.lineup = team.lineup.map((p) => (p === id ? null : p));
  team.legacyOverflow = Math.max(0, team.roster.length - ROSTER_SIZE);
  state.irMoves.push({ week: state.week, team: team.id, player: id, action: 'reserve' });
}
export function activateIR(state, team, id, drop, players) {
  ensure(
    state.phase === 'season' && team.ir?.includes(id),
    'That player is not on your injured reserve.',
  );
  ensure(
    canAcquire(team.roster, id, drop ?? null, players),
    'Choose a legal active-roster drop, or use an open roster spot.',
  );
  team.ir = team.ir.filter((p) => p !== id);
  swap(state, team, id, drop ?? null, players, 'IR activation');
  state.irMoves.push({ week: state.week, team: team.id, player: id, action: 'activate' });
}
export function releasePlayer(state, team, id, players) {
  ensure(state.phase === 'season', 'Roster moves open after the draft.');
  ensure(team.roster.includes(id) || team.ir?.includes(id), 'That player is not on your team.');
  const after = team.roster.filter((p) => p !== id);
  ensure(
    after.length > ROSTER_SIZE || rosterFeasible(after, players),
    'That drop leaves no way to fill the required positions.',
  );
  team.roster = after;
  team.ir = (team.ir ?? []).filter((p) => p !== id);
  team.lineup = team.lineup.map((p) => (p === id ? null : p));
  team.legacyOverflow = Math.max(0, after.length - ROSTER_SIZE);
  state.availableAt[id] = state.week + 1;
  state.transactions.push({
    week: state.week,
    team: team.id,
    add: null,
    drop: id,
    bid: 0,
    source: 'Released',
  });
}
function manageBotIR(state, catalog, players, world) {
  if (state.botIRWeek === state.week) return;
  state.botIRWeek = state.week;
  for (const team of state.teams) {
    if (team.id === state.human) continue;
    for (const id of [...(team.ir ?? [])]) {
      if (injuryReport(state, players.get(id), world).irEligible) continue;
      const drops = team.roster
        .filter((drop) => canSwap(team.roster, id, drop, players))
        .sort(
          (a, b) =>
            forecast(players.get(a), state.observed) - forecast(players.get(b), state.observed),
        );
      if (team.roster.length < ROSTER_SIZE && canDraft(team.roster, players.get(id), players))
        activateIR(state, team, id, null, players);
      else if (
        drops.length &&
        forecast(players.get(id), state.observed) >= forecast(players.get(drops[0]), state.observed)
      )
        activateIR(state, team, id, drops[0], players);
      else releasePlayer(state, team, id, players);
    }
    while (team.roster.length > ROSTER_SIZE) {
      const choices = [...team.roster].sort(
        (a, b) =>
          forecast(players.get(a), state.observed) - forecast(players.get(b), state.observed),
      );
      const drop = choices.find(
        (id) =>
          team.roster.length - 1 > ROSTER_SIZE ||
          rosterFeasible(
            team.roster.filter((p) => p !== id),
            players,
          ),
      );
      releasePlayer(state, team, drop, players);
    }
    if (random(state) > 0.6 + 0.4 * team.profile.skill) continue;
    const candidates = team.roster
      .filter(
        (id) =>
          injuryReport(state, players.get(id), world).irEligible &&
          forecast(players.get(id), state.observed) > 2,
      )
      .sort(
        (a, b) =>
          forecast(players.get(b), state.observed) - forecast(players.get(a), state.observed),
      );
    for (const id of candidates)
      if (team.ir.length < IR_SIZE) moveToIR(state, team, id, players, world);
  }
}
function fillBotVacancies(state, catalog, players, world) {
  for (const team of state.teams) {
    if (team.id === state.human) continue;
    while (team.roster.length < ROSTER_SIZE) {
      const options = availablePlayers(state, catalog).filter(
        (p) => (state.availableAt[p.id] ?? 1) <= state.week && canDraft(team.roster, p, players),
      );
      options.sort(
        (a, b) =>
          weeklyProjection(state, b, world) - weeklyProjection(state, a, world) ||
          forecast(b, state.observed) - forecast(a, state.observed),
      );
      if (!options.length) break;
      swap(state, team, options[0].id, null, players, 'Free agent');
    }
  }
}
function observeWeek(state, p, row, week) {
  const record = state.observed[p.id] ?? {
    points: 0,
    games: 0,
    last: [],
    totals: Object.fromEntries(BOX_FIELDS.map((k) => [k, 0])),
    recent: [],
  };
  record.points += row[0];
  record.totals ??= Object.fromEntries(BOX_FIELDS.map((k) => [k, 0]));
  record.recent ??= [];
  record.weeklyPoints ??= [];
  record.weeklyPoints[week - 1] =
    row.at(-1) && (row[1] + row[6] + row[9] > 0 || row[0] !== 0) ? row[0] : null;
  BOX_FIELDS.forEach((k, i) => {
    record.totals[k] += row[i + 1];
  });
  if (row.at(-1)) {
    record.games++;
    record.last.push(row[0]);
    record.recent.push({ week, points: row[0], opportunities: row[1] + row[6] + row[9] });
    record.recent = record.recent.slice(-4);
  }
  state.observed[p.id] = record;
}
export function hydrateLeague(state, catalog, players, world) {
  let changed = false;
  state.seasonYear ??= catalog.seasonYear ?? 2026;
  state.irMoves ??= [];
  state.weekRecords ??= [];
  for (const t of state.teams) {
    if (!t.ir) {
      t.ir = [];
      changed = true;
    }
    if (!t.abbreviation) {
      const c = NFL_CLUBS[t.id];
      t.name = c.city + ' · ' + c.abbreviation;
      t.city = c.city;
      t.club = c.id;
      t.abbreviation = c.abbreviation;
      changed = true;
    }
  }
  if (!state.rules) {
    state.rules = {
      rosterSize: ROSTER_SIZE,
      benchSize: 6,
      irSize: IR_SIZE,
      draftRounds: DRAFT_ROUNDS,
    };
    for (const t of state.teams) t.legacyOverflow = Math.max(0, t.roster.length - ROSTER_SIZE);
    if (state.phase === 'draft' && state.pick >= DRAFT_PICKS) {
      state.phase = 'season';
      for (const t of state.teams) t.lineup = optimalLineup(t.roster, players, (p) => p.basePpg);
    }
    changed = true;
  }
  if (state.statsSchema !== 2) {
    state.observed = {};
    for (let w = 1; w < state.week && w <= 18; w++)
      for (const p of catalog.players) observeWeek(state, p, world[p.id][w - 1], w);
    state.statsSchema = 2;
    changed = true;
  }
  return changed;
}
export function submitClaim(state, team, claim, players, world) {
  ensure(state.phase === 'season', 'Waivers open after the draft.');
  ensure(!state.waiversProcessed, 'This week’s waiver run has finished. Use free agents.');
  ensure(
    !unresolvedIR(state, team, players, world),
    'Activate or release recovered IR players before adding players.',
  );
  ensure(
    team.roster.length <= ROSTER_SIZE,
    'Resolve the extra bench players from your old save first.',
  );
  ensure(
    Number.isInteger(claim.bid) && claim.bid >= 0 && claim.bid <= team.faab,
    'Bid a whole dollar amount within your FAAB balance.',
  );
  ensure(
    players.has(claim.add) && !ownerMap(state).has(claim.add),
    'That player is already rostered.',
  );
  ensure((state.availableAt[claim.add] ?? 1) <= state.week, 'A dropped player clears next week.');
  ensure(
    canAcquire(team.roster, claim.add, claim.drop, players),
    'That add/drop would leave an incomplete roster.',
  );
  state.claims = state.claims.filter((c) => !(c.team === team.id && c.add === claim.add));
  state.claims.push({ ...claim, team: team.id });
}
function botClaims(state, catalog, players, world) {
  const available = availablePlayers(state, catalog).filter(
    (p) => (state.availableAt[p.id] ?? 1) <= state.week,
  );
  for (const team of state.teams) {
    if (team.id === state.human || random(state) > 0.55 + 0.43 * team.profile.skill) continue;
    const roster = team.roster.map((id) => players.get(id));
    const base = optimalLineup(team.roster, players, (p) => weeklyProjection(state, p, world));
    const starters = new Set(base.filter(Boolean));
    let options = [];
    for (const add of available) {
      if (weekStatus(state, add, world) !== 'ACTIVE') continue;
      const sorted = roster
        .filter((p) => !starters.has(p.id))
        .sort((a, b) => forecast(a, state.observed) - forecast(b, state.observed));
      if (team.roster.length < ROSTER_SIZE) sorted.unshift(null);
      for (const drop of sorted) {
        if (!canAcquire(team.roster, add.id, drop?.id ?? null, players)) continue;
        const slotNeed =
          roster.filter(
            (p) => p.position === add.position && weekStatus(state, p, world) === 'ACTIVE',
          ).length < MIN_FOR(add.position);
        const gain =
          forecast(add, state.observed) -
          (drop ? forecast(drop, state.observed) : 0) +
          (slotNeed ? 6 : 0);
        const last = state.observed[add.id]?.last.at(-1) ?? 0;
        const hype =
          (1 - team.profile.skill) * Math.max(0, last / 100 - forecast(add, state.observed)) * 0.6;
        if (gain + hype > 1.2)
          options.push({ add: add.id, drop: drop?.id ?? null, gain: gain + hype, need: slotNeed });
        break;
      }
    }
    options.sort((a, b) => b.gain - a.gain);
    options = options.slice(0, 2);
    for (const o of options) {
      const rate = Math.min(
        0.45,
        0.015 +
          o.gain * 0.012 +
          (o.need ? 0.02 : 0) +
          (1 - team.profile.skill) * random(state) * 0.1,
      );
      const bid =
        state.week === 1 ? 0 : Math.min(team.faab, Math.max(1, Math.round(team.faab * rate)));
      state.claims.push({ ...o, team: team.id, bid });
    }
  }
}
const MIN_FOR = (pos) => ({ QB: 1, RB: 2, WR: 2, TE: 1 })[pos];
export function resolveClaims(state, players, world) {
  const ordered = standings(state),
    rank = new Map(ordered.map((t, i) => [t.id, i]));
  const sorted = [...state.claims].sort(
    (a, b) =>
      b.bid - a.bid ||
      rank.get(b.team) - rank.get(a.team) ||
      state.teams[a.team].waiverPriority - state.teams[b.team].waiverPriority,
  );
  const results = [];
  for (const c of sorted) {
    const team = state.teams[c.team];
    const valid =
      !ownerMap(state).has(c.add) &&
      c.bid <= team.faab &&
      !unresolvedIR(state, team, players, world) &&
      team.roster.length <= ROSTER_SIZE &&
      (state.availableAt[c.add] ?? 1) <= state.week &&
      canAcquire(team.roster, c.add, c.drop, players);
    if (valid) {
      swap(state, team, c.add, c.drop, players, 'Waiver', c.bid);
      team.faab -= c.bid;
      results.push({ team: team.id, add: c.add, bid: c.bid, won: true });
    } else results.push({ team: team.id, add: c.add, bid: c.bid, won: false });
  }
  state.lastWaivers = { week: state.week, results };
  state.claims = [];
  state.waiversProcessed = true;
  return results;
}
export function runWaivers(state, catalog, players, world) {
  ensure(state.phase === 'season', 'Waivers open during the season.');
  ensure(!state.waiversProcessed, 'Waivers have already processed this week.');
  manageBotIR(state, catalog, players, world);
  botClaims(state, catalog, players, world);
  return resolveClaims(state, players, world);
}
export function weekMatchups(state) {
  const w = state.week;
  if (w <= 14) return state.schedule[w - 1].map(([a, b]) => ({ a, b, kind: 'Regular season' }));
  const seed = state.playoffs?.seeds ?? standings(state).map((t) => t.id);
  const used = new Set(),
    games = [];
  const add = (a, b, kind) => {
    games.push({ a, b, kind });
    used.add(a);
    used.add(b);
  };
  if (w === 15) {
    add(seed[2], seed[5], 'Quarterfinal');
    add(seed[3], seed[4], 'Quarterfinal');
    used.add(seed[0]);
    used.add(seed[1]);
  }
  if (w === 16) {
    const winners = state.results
      .filter((g) => g.week === 15 && g.kind === 'Quarterfinal')
      .map((g) => g.winner)
      .sort((a, b) => seed.indexOf(a) - seed.indexOf(b));
    add(seed[0], winners[1], 'Semifinal');
    add(seed[1], winners[0], 'Semifinal');
  }
  if (w === 17) {
    const semi = state.results.filter((g) => g.week === 16 && g.kind === 'Semifinal');
    add(semi[0].winner, semi[1].winner, 'Championship');
    add(
      semi[0].winner === semi[0].a ? semi[0].b : semi[0].a,
      semi[1].winner === semi[1].a ? semi[1].b : semi[1].a,
      'Third place',
    );
  }
  const rest = seed.filter((id) => !used.has(id));
  for (let i = 0; i < rest.length; i += 2)
    add(rest[i], rest[i + 1], w === 18 ? 'Victory lap · exhibition' : 'Placement');
  return games;
}
export function advanceWeek(state, catalog, players, world) {
  ensure(state.phase === 'season' && state.week <= 18, 'The season is complete.');
  const human = state.teams[state.human];
  ensure(
    human.roster.length <= ROSTER_SIZE,
    'Your old save has extra bench players. Release players or move eligible players to IR before kickoff.',
  );
  ensure(
    !unresolvedIR(state, human, players, world),
    'Activate or release recovered IR players before kickoff.',
  );
  if (!state.waiversProcessed) runWaivers(state, catalog, players, world);
  else manageBotIR(state, catalog, players, world);
  fillBotVacancies(state, catalog, players, world);
  for (const t of state.teams) {
    if (t.id !== state.human) optimizeTeam(state, t, players, world);
    validateLineup(t, t.lineup, players);
  }
  const w = state.week,
    seed = state.playoffs?.seeds;
  state.weekRecords ??= [];
  state.weekRecords.push(
    captureWeek(state, catalog, players, world, (p) => weeklyProjection(state, p, world)),
  );
  state.lineupHistory.push(state.teams.map((t) => [...t.lineup]));
  for (const game of weekMatchups(state)) {
    const a = state.teams[game.a],
      b = state.teams[game.b];
    const aLineup = [...a.lineup],
      bLineup = [...b.lineup];
    const score = (ids) => ids.reduce((sum, id) => sum + (id ? world[id][w - 1][0] : 0), 0);
    const sa = score(aLineup),
      sb = score(bLineup);
    const postseason = ['Quarterfinal', 'Semifinal', 'Championship', 'Third place'].includes(
      game.kind,
    );
    const winner =
      sa === sb
        ? postseason
          ? seed.indexOf(a.id) < seed.indexOf(b.id)
            ? a.id
            : b.id
          : null
        : sa > sb
          ? a.id
          : b.id;
    state.results.push({
      ...game,
      week: w,
      sa,
      sb,
      winner,
      aLineup,
      bLineup,
      tiebreak: sa === sb && postseason ? 'Higher regular-season seed' : null,
    });
    if (w <= 14) {
      a.pf += sa;
      a.pa += sb;
      b.pf += sb;
      b.pa += sa;
      if (winner === null) {
        a.ties++;
        b.ties++;
      } else {
        state.teams[winner].wins++;
        state.teams[winner === a.id ? b.id : a.id].losses++;
      }
    }
    if (game.kind === 'Championship') state.champion = winner;
  }
  for (const p of catalog.players) observeWeek(state, p, world[p.id][w - 1], w);
  if (w === 14) state.playoffs = { seeds: standings(state).map((t) => t.id) };
  state.week++;
  state.waiversProcessed = false;
  state.claims = [];
  if (state.week === 19) state.phase = 'complete';
  else
    for (const t of state.teams) if (t.id !== state.human) optimizeTeam(state, t, players, world);
}
export function applyAction(state, action, catalog, players, world) {
  hydrateLeague(state, catalog, players, world);
  const team = state.teams[state.human];
  const previousPhase = state.phase;
  switch (action.type) {
    case 'draft':
      ensure(
        state.phase === 'draft' && draftTeam(state.pick) === state.human,
        'Wait for your draft turn.',
      );
      selectDraft(state, action.player, catalog, players);
      botsUntilHuman(state, catalog, players);
      break;
    case 'autopick':
      ensure(
        state.phase === 'draft' && draftTeam(state.pick) === state.human,
        'Wait for your draft turn.',
      );
      autoPick(state, catalog, players);
      botsUntilHuman(state, catalog, players);
      break;
    case 'finishDraft':
      ensure(state.phase === 'draft', 'The draft is already complete.');
      while (state.phase === 'draft') autoPick(state, catalog, players);
      optimizeTeam(state, team, players, world);
      break;
    case 'queue':
      ensure(
        state.phase === 'draft' &&
          players.has(action.player) &&
          !ownerMap(state).has(action.player),
        'Queue an available player.',
      );
      state.queue = state.queue.includes(action.player)
        ? state.queue.filter((id) => id !== action.player)
        : [...state.queue, action.player];
      break;
    case 'lineup':
      ensure(state.phase === 'season', 'Lineups unlock after the draft.');
      validateLineup(team, action.lineup, players);
      team.lineup = [...action.lineup];
      break;
    case 'optimize':
      ensure(state.phase === 'season', 'Lineups unlock after the draft.');
      optimizeTeam(state, team, players, world);
      break;
    case 'claim':
      submitClaim(
        state,
        team,
        { add: action.add, drop: action.drop, bid: action.bid },
        players,
        world,
      );
      break;
    case 'cancelClaim':
      ensure(state.phase === 'season' && !state.waiversProcessed, 'This waiver run is closed.');
      state.claims = state.claims.filter((c) => !(c.team === state.human && c.add === action.add));
      break;
    case 'waivers':
      runWaivers(state, catalog, players, world);
      break;
    case 'add':
      ensure(
        !unresolvedIR(state, team, players, world),
        'Activate or release recovered IR players before adding players.',
      );
      ensure(
        state.phase === 'season' && (state.week === 1 || state.waiversProcessed),
        'Process this week’s waivers before free-agent pickups.',
      );
      ensure(
        players.has(action.add) && !ownerMap(state).has(action.add),
        'That player is no longer available.',
      );
      ensure(
        (state.availableAt[action.add] ?? 1) <= state.week,
        'A dropped player clears next week.',
      );
      swap(state, team, action.add, action.drop, players, 'Free agent');
      break;
    case 'reserve':
      moveToIR(state, team, action.player, players, world);
      break;
    case 'activate':
      activateIR(state, team, action.player, action.drop ?? null, players);
      break;
    case 'release':
      releasePlayer(state, team, action.player, players);
      break;
    case 'advance':
      advanceWeek(state, catalog, players, world);
      break;
    default:
      throw new GameError('Unknown game action.');
  }
  if (previousPhase === 'draft' && state.phase === 'season')
    for (const t of state.teams) optimizeTeam(state, t, players, world);
  state.revision++;
  assertLeague(state, players);
  return state;
}
export function assertLeague(state, players) {
  const rosters = state.teams.flatMap((t) => [...t.roster, ...(t.ir ?? [])]);
  ensure(new Set(rosters).size === rosters.length, 'A player belongs to two teams.');
  ensure(
    state.teams.every(
      (t) =>
        t.roster.length <= ROSTER_SIZE + (t.legacyOverflow ?? 0) &&
        (t.ir ?? []).length <= IR_SIZE &&
        t.faab >= 0,
    ),
    'Invalid roster or budget.',
  );
  if (state.phase !== 'draft')
    for (const t of state.teams) {
      ensure(t.legacyOverflow || rosterFeasible(t.roster, players), 'Incomplete roster.');
      validateLineup(t, t.lineup, players);
    }
}
export function publicState(state, catalog, players, world) {
  hydrateLeague(state, catalog, players, world);
  const { world: privateWorld, rng, claims, weekRecords, ...safe } = structuredClone(state);
  safe.claims = claims.filter((c) => c.team === state.human);
  safe.positionRanks = currentRanks(state, catalog);
  safe.injuryReports = Object.fromEntries(
    catalog.players.map((p) => [p.id, injuryReport(state, p, world)]),
  );
  // Current availability is public news; future points, participation and world selection are private.
  safe.playerStatus = Object.fromEntries(
    catalog.players.map((p) => [p.id, weekStatus(state, p, world)]),
  );
  safe.projections = Object.fromEntries(
    catalog.players.map((p) => [p.id, Math.round(forecast(p, state.observed) * 100) / 100]),
  );
  safe.pastPoints = Object.fromEntries(
    catalog.players.map((p) => [
      p.id,
      world[p.id].slice(0, Math.min(18, state.week - 1)).map((row) => row[0]),
    ]),
  );
  safe.matchups =
    state.phase === 'draft' ? [] : state.phase === 'complete' ? [] : weekMatchups(state);
  safe.standings = standings(state).map((t) => t.id);
  safe.latestRecap = weeklyRecap(state, catalog, Math.min(18, state.week - 1));
  safe.seasonRecap = yearlyRecap(state, catalog);
  safe.recapWeeks = (state.weekRecords ?? []).map((r) => r.week);
  return safe;
}
