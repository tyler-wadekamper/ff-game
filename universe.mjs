// Empirical, whole-pool generation for the browser edition. No future outcomes
// enter history matching, market pricing or public depth-chart estimates.
import { NFL_CLUBS, hashText, seededRandom, shuffled } from './config.mjs';
import { BOX_FIELDS, historicalRanks } from './player-insights.mjs';
import { injuryReport } from './injuries.mjs';

const FIRST =
  'Adrian Blake Camden Darius Ellis Finn Grayson Hayes Isaac Jalen Kai Landon Mason Nico Owen Parker Quinn Roman Silas Tate Vincent Wesley Xavier Zane Avery Brooks Cole Devon Emery Felix Grant Holden Ivan Jordan Kieran Logan Miles Nolan Orion Preston Reese Sawyer Theo Vaughn Warren Zion'.split(
    ' ',
  );
const LAST =
  'Archer Banks Barrett Bellamy Bishop Booker Briggs Brooks Calder Carter Chase Clarke Cole Cross Dalton Ellis Everett Finch Fletcher Ford Foster Gaines Gray Hale Harper Hayes Holloway Holt James Knox Lane Lawson Marsh Mercer Monroe Morgan Nash North Palmer Pierce Porter Reed Rhodes Rivers Rowan Shaw Sinclair Slater Stone Sutton Tanner Tate Vaughn Vale Walker Ward Wells West Wilder Winslow Wolfe Woods York Young'.split(
    ' ',
  );
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export function pointsCents(r) {
  return (
    4 * r.passing_yards +
    10 * (r.rushing_yards + r.receiving_yards) +
    400 * r.passing_tds +
    600 * (r.rushing_tds + r.receiving_tds) +
    100 * r.receptions -
    200 *
      (r.passing_interceptions +
        r.sack_fumbles_lost +
        r.rushing_fumbles_lost +
        r.receiving_fumbles_lost)
  );
}
function scaledBox(row, factor) {
  const out = Object.fromEntries(
    BOX_FIELDS.map((k) => [k, Math.round((row[k] ?? 0) * (k === 'games' ? 1 : factor))]),
  );
  out.completions = Math.min(out.completions, out.attempts);
  out.receptions = Math.min(out.receptions, out.targets);
  out.passing_interceptions = Math.min(out.passing_interceptions, out.attempts - out.completions);
  out.passing_tds = Math.min(out.passing_tds, out.completions);
  // Preserve actual lateral TD exceptions without manufacturing an extra catch.
  if ((row.rushing_tds ?? 0) <= (row.carries ?? 0))
    out.rushing_tds = Math.min(out.rushing_tds, out.carries);
  if ((row.receiving_tds ?? 0) <= (row.receptions ?? 0))
    out.receiving_tds = Math.min(out.receiving_tds, out.receptions);
  return out;
}
function traits(seed, id) {
  return 0.92 + 0.16 * seededRandom(hashText(seed + ':trait:' + id))();
}
function updateScouting(p) {
  const rows = p.history.slice(-3).reverse(),
    weights = [0.6, 0.3, 0.1].slice(0, rows.length),
    sum = weights.reduce((a, b) => a + b, 0);
  if (!rows.length) {
    p.basePpg = { QB: 8, RB: 4, WR: 4, TE: 3 }[p.position];
    return;
  }
  const value = rows.reduce(
    (v, h, i) => v + ((weights[i] / sum) * h.ppr) / Math.max(1, h.games),
    0,
  );
  const health = rows.reduce((v, h, i) => v + (weights[i] / sum) * Math.min(1, h.games / 17), 0);
  p.basePpg = Math.round(Math.max(0, value) * (0.8 + 0.2 * health) * 1000) / 1000;
}
function giveNames(players, seed) {
  const choices = shuffled(
    Array.from({ length: FIRST.length * LAST.length }, (_, i) => i),
    seededRandom(seed),
  );
  for (let i = 0; i < players.length; i++) {
    const code = choices[i];
    let a = FIRST[Math.floor(code / LAST.length)],
      b = LAST[code % LAST.length];
    // Each pair is unique; repeated first/last words are still valid fictional identities.
    players[i].name = a + ' ' + b;
  }
}
function scheduleClubs(base, seed) {
  const byes = Object.values(Object.fromEntries(base.players.map((p) => [p.club, p.bye])));
  const random = seededRandom(seed),
    values = shuffled(byes, random);
  return NFL_CLUBS.map((c, i) => ({ ...c, bye: values[i % values.length] }));
}
function assignClubs(players, clubs, seed, retained = false) {
  const random = seededRandom(seed);
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const group = players.filter((p) => p.position === pos).sort((a, b) => b.basePpg - a.basePpg);
    for (let start = 0; start < group.length; start += 32) {
      const order = shuffled(clubs, random);
      group.slice(start, start + 32).forEach((p, i) => {
        if (!retained || !p.club) p.club = order[i].id;
        p.bye = clubs.find((c) => c.id === p.club).bye;
      });
    }
  }
}
export function historyFeatures(p, year) {
  const byYear = new Map(p.history.map((h) => [year - 1 + h.relative_season, h]));
  const tail = Array.from({ length: 3 }, (_, i) => ({
    year: year - 3 + i,
    ...(byYear.get(year - 3 + i) ?? {}),
  }));
  const get = (r, k) => Number(r[k] ?? 0),
    scheduled = (r) => r.scheduled_games ?? (r.year >= 2021 ? 17 : 16),
    ppr17 = (r) => (get(r, 'ppr') * 17) / scheduled(r);
  const last = tail[2],
    games = Math.max(1, get(last, 'games')),
    pp = tail.map(ppr17);
  const productive = [...byYear]
    .filter(([, h]) => (h.attempts ?? 0) + (h.carries ?? 0) + (h.targets ?? 0) > 0)
    .map(([y]) => y);
  return [
    p.age,
    p.history.length,
    pp[2],
    get(last, 'ppr') / games,
    get(last, 'games'),
    (pp[1] + pp[2]) / 2,
    (pp[0] + pp[1] + pp[2]) / 3,
    Math.max(...pp),
    pp[2] - pp[1],
    get(last, 'attempts') / games,
    get(last, 'carries') / games,
    get(last, 'targets') / games,
    get(last, 'passing_yards') / games,
    get(last, 'rushing_yards') / games,
    get(last, 'receiving_yards') / games,
    (get(last, 'passing_tds') + get(last, 'rushing_tds') + get(last, 'receiving_tds')) / games,
    get(last, 'listed_out_weeks'),
    tail.reduce((n, r) => n + get(r, 'games') / scheduled(r), 0) / 3,
    p.history.length ? (productive.length ? year - Math.max(...productive) - 1 : 5) : 0,
    p.history.length ? 0 : 1,
  ];
}
export function marketPriority(p, year, model) {
  const group = model.groups[p.position],
    features = historyFeatures(p, year);
  const x = features.map(
    (v, i) =>
      ((Math.asinh(v / model.scales[i]) - group.mean[i]) / group.scale[i]) * group.weights[i],
  );
  const top = [];
  for (let n = 0; n < group.vectors.length; n++) {
    const source = group.vectors[n];
    let distance = 0;
    for (let i = 0; i < x.length; i++) {
      const d = x[i] - source[i];
      distance += d * d;
    }
    if (top.length === model.neighbors && distance >= top.at(-1).distance) continue;
    top.push({ distance, target: group.targets[n] });
    top.sort((a, b) => a.distance - b.distance);
    if (top.length > model.neighbors) top.pop();
  }
  const distances = top.map((r) => Math.sqrt(r.distance)),
    middle = Math.floor(distances.length / 2);
  const median =
    distances.length % 2 ? distances[middle] : (distances[middle - 1] + distances[middle]) / 2;
  const band = Math.max(0.5, median);
  let value = 0,
    total = 0;
  for (const r of top) {
    const w = Math.exp(-r.distance / (2 * band * band));
    value += w * r.target;
    total += w;
  }
  return value / total;
}
function pricePlayers(players, year, model, seed) {
  const random = seededRandom(seed);
  const priorities = players
    .map((p) => ({ p, score: marketPriority(p, year, model) + 0.015 * (random() - 0.5) }))
    .sort((a, b) => a.score - b.score);
  priorities.forEach(({ p }, i) => {
    p.adpRank = i + 1;
    p.adp = Math.round((i < model.limit ? model.curve[i] : i + 1) * 10) / 10;
  });
  players.sort((a, b) => a.adp - b.adp);
}
function roleVector(p) {
  const last = p.history.at(-1) ?? {},
    g = Math.max(1, last.games ?? 0);
  return [
    p.basePpg / { QB: 10, RB: 7, WR: 7, TE: 5 }[p.position],
    Math.log1p(((last.attempts ?? 0) + (last.carries ?? 0) + (last.targets ?? 0)) / g),
    p.age / 10,
    (last.rushing_yards ?? 0) / g / 30,
    (last.targets ?? 0) / g / 5,
    (last.games ?? 0) / 17,
  ];
}
function allocateWorld(players, base, source, seed, realMode = false) {
  const random = seededRandom(seed),
    world = {},
    sourceMap = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const targets = players
      .filter((p) => p.position === pos)
      .map((p) => ({
        p,
        order:
          p.basePpg +
          random() * 2 +
          (realMode && pos === 'QB'
            ? (0.15 * (p.history.at(-1)?.rushing_yards ?? 0)) /
              Math.max(1, p.history.at(-1)?.games ?? 0)
            : 0),
      }))
      .sort((a, b) => b.order - a.order);
    const supply = base.players
      .filter((p) => p.position === pos)
      .map((p) => ({ p, x: roleVector(p) }));
    for (const { p } of targets) {
      const x = roleVector(p);
      let best = 0,
        cost = Infinity;
      for (let n = 0; n < supply.length; n++) {
        let distance = 0;
        for (let k = 0; k < x.length; k++) {
          const weight =
            k === 3
              ? pos === 'QB'
                ? 2
                : 0.4
              : k === 4
                ? pos === 'RB'
                  ? 1.5
                  : 0.6
                : k === 2
                  ? 0.5
                  : 1;
          distance += (realMode ? realWeights(pos)[k] : weight) * (x[k] - supply[n].x[k]) ** 2;
        }
        distance -= 0.12 * -Math.log(-Math.log(Math.max(0.00001, random())));
        if (distance < cost) {
          cost = distance;
          best = n;
        }
      }
      const template = supply.splice(best, 1)[0].p;
      sourceMap[p.id] = template.id;
      const weeks = source[template.id]
        .filter((_, i) => i + 1 !== template.bye)
        .map((r) => r.slice());
      const active = weeks.map((r, i) => (r.at(-1) ? i : -1)).filter((i) => i >= 0);
      const blocks = Array.from({ length: Math.ceil(active.length / 2) }, (_, i) =>
        active.slice(i * 2, i * 2 + 2),
      );
      const order = shuffled(blocks, random).flat(),
        factor = traits(seed, p.id);
      const fresh = Array.from({ length: 18 }, () => Array(17).fill(0));
      let game = 0;
      for (let w = 1; w <= 18; w++) {
        if (w === p.bye) continue;
        const index = game++;
        if (!weeks[index].at(-1)) continue;
        const sourceIndex = order[active.indexOf(index)],
          r = Object.fromEntries(BOX_FIELDS.map((k, i) => [k, weeks[sourceIndex][i + 1]]));
        const result = scaledBox(r, factor);
        fresh[w - 1] = [pointsCents(result), ...BOX_FIELDS.map((k) => result[k])];
      }
      world[p.id] = fresh;
    }
  }
  return { world, sourceMap };
}
// A real identity selects a past career checkpoint, never that checkpoint's
// actual successor. Histories are 17-game-equivalent alternate-career lines.
const checkpointLibraries = new WeakMap();
const REAL_ROLE_WEIGHTS = Object.fromEntries(
  ['QB', 'RB', 'WR', 'TE'].map((pos) => [
    pos,
    [pos === 'QB' ? 16 : 8, 2, 6.25, pos === 'QB' ? 2 : 0.4, pos === 'RB' ? 1.5 : 0.6, 1],
  ]),
);
const realWeights = (pos) => REAL_ROLE_WEIGHTS[pos];
function realDistance(a, b, pos) {
  const weights = realWeights(pos);
  let cost = 0;
  for (let k = 0; k < a.length; k++) cost += weights[k] * (a[k] - b[k]) ** 2;
  return cost;
}
function careerCheckpoints(library) {
  if (checkpointLibraries.has(library)) return checkpointLibraries.get(library);
  const result = { QB: [], RB: [], WR: [], TE: [] };
  for (const person of library.players)
    person.states.forEach((last, checkpoint) => {
      const recent = person.states.slice(Math.max(0, checkpoint - 2), checkpoint + 1).reverse(),
        weights = [0.6, 0.3, 0.1].slice(0, recent.length),
        sum = weights.reduce((a, b) => a + b, 0);
      const ppg = recent.reduce(
        (n, h, i) => n + ((weights[i] / sum) * pointsCents(h)) / 100 / Math.max(1, h.games),
        0,
      );
      const health = recent.reduce(
          (n, h, i) => n + ((weights[i] / sum) * h.games) / h.scheduled_games,
          0,
        ),
        games = Math.max(1, last.games);
      result[person.position].push({
        person,
        checkpoint,
        x: [
          (ppg * (0.8 + 0.2 * health)) / { QB: 10, RB: 7, WR: 7, TE: 5 }[person.position],
          Math.log1p((last.attempts + last.carries + last.targets) / games),
          (last.age + 1) / 10,
          last.rushing_yards / games / 30,
          last.targets / games / 5,
          last.games / last.scheduled_games,
        ],
      });
    });
  checkpointLibraries.set(library, result);
  return result;
}
function realCohort(library, base, random) {
  const candidates = careerCheckpoints(library),
    selected = [],
    usedIds = new Set(),
    usedNames = new Set(),
    usedSlots = new Set();
  const take = (row, slot) => {
    selected.push(row);
    usedIds.add(row.person.id);
    usedNames.add(row.person.name);
    usedSlots.add(slot.id);
  };
  // Familiar faces occupy compatible roles rather than adding extra star roles.
  for (const name of [
    'Lamar Jackson',
    'Patrick Mahomes',
    'Christian McCaffrey',
    'Justin Jefferson',
    'Travis Kelce',
  ]) {
    const person = library.players.find((p) => p.name === name);
    if (!person) continue;
    const options = candidates[person.position].filter((c) => c.person.id === person.id),
      row = options[Math.floor(random() * options.length)];
    const slots = base.players.filter(
      (p) => p.position === person.position && !usedSlots.has(p.id),
    );
    slots.sort(
      (a, b) =>
        realDistance(row.x, roleVector(a), person.position) -
        realDistance(row.x, roleVector(b), person.position),
    );
    take(row, slots[0]);
  }
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const slots = base.players
      .filter((p) => p.position === pos && !usedSlots.has(p.id))
      .sort((a, b) => b.basePpg - a.basePpg);
    for (const slot of slots) {
      const target = roleVector(slot);
      let winner = null,
        best = Infinity;
      for (const row of candidates[pos]) {
        if (usedIds.has(row.person.id) || usedNames.has(row.person.name)) continue;
        const noise = -Math.log(-Math.log(Math.max(0.00001, random())));
        const cost =
          realDistance(row.x, target, pos) +
          0.04 * (2025 - row.person.states[row.checkpoint].season) -
          0.3 * noise;
        if (cost < best) {
          best = cost;
          winner = row;
        }
      }
      if (!winner) throw Error('The real-player source pool is incomplete.');
      take(winner, slot);
    }
  }
  return selected;
}
function realInitialUniverse(spec, baseData) {
  const { catalog: base, privateData, adpModel, realPlayers } = baseData,
    random = seededRandom(spec.seed);
  const players = realCohort(realPlayers, base, random).map(({ person, checkpoint }) => {
    const anchor = person.states[checkpoint];
    const prefix = person.states.slice(0, checkpoint + 1);
    const elapsed = anchor.season - prefix[0].season;
    const age = clamp(
      anchor.age + 1 + Math.floor(random() * 3) - 1,
      21 + elapsed,
      { QB: 46, RB: 38, WR: 42, TE: 42 }[person.position],
    );
    const id = `${person.position}-${person.id}-${hashText(spec.id).toString(36)}`;
    const history = prefix.map((row) => {
      const box = scaledBox(row, (17 / row.scheduled_games) * traits(spec.seed, id));
      box.games = Math.min(17, Math.round((row.games * 17) / row.scheduled_games));
      return {
        ...box,
        age: age - 1 + row.season - anchor.season,
        relative_season: row.season - anchor.season,
        scheduled_games: 17,
        ppr: pointsCents(box) / 100,
        listed_out_weeks: row.listed_out_weeks,
      };
    });
    const player = {
      id,
      name: person.name,
      realPlayerId: person.id,
      position: person.position,
      age,
      history,
      club: null,
      historyKind: 'alternate-career',
      ageRandomized: true,
    };
    updateScouting(player);
    return player;
  });
  const clubs = scheduleClubs(base, spec.seed);
  assignClubs(players, clubs, spec.seed);
  pricePlayers(players, 2026, adpModel, spec.seed);
  const outcomeSeed = spec.outcomeSeed ?? hashText(spec.seed + ':outcomes');
  const outcomeRandom = seededRandom(outcomeSeed);
  const allocation = allocateWorld(
    players,
    base,
    privateData.worlds[Math.floor(outcomeRandom() * privateData.worlds.length)],
    outcomeSeed,
    true,
  );
  return {
    catalog: retainFinishes({
      ...base,
      version: contextVersion(base, spec),
      seasonYear: 2026,
      rosterSize: 14,
      identityMode: 'real',
      historyKind: 'alternate-career',
      clubs,
      players,
    }),
    world: allocation.world,
    usedRealIds: players.map((p) => p.realPlayerId),
  };
}

function contextVersion(base, spec) {
  return (
    base.version +
    (spec.identityMode === 'real' ? ':r1:' + spec.realVersion + ':' : ':u1:') +
    spec.id +
    ':' +
    spec.season
  );
}
function retainFinishes(catalog) {
  const ranks = historicalRanks(catalog);
  for (const p of catalog.players)
    for (const h of p.history) h.positionFinish = ranks[h.relative_season]?.[p.id] ?? null;
  return catalog;
}
function initialUniverse(spec, baseData) {
  const { catalog: base, privateData, adpModel } = baseData,
    random = seededRandom(spec.seed);
  const players = base.players.map((p, i) => {
    const id = `${p.position}-${String(i + 1).padStart(4, '0')}-${hashText(spec.id).toString(36)}`;
    const factor = traits(spec.seed, id),
      shift = clamp(Math.floor(random() * 3) - 1, 20 - (p.history[0]?.age ?? 21), 2);
    const history = p.history.map((h) => {
      const box = scaledBox(h, factor);
      const { positionFinish, score, ...past } = h;
      return { ...past, ...box, age: h.age + shift, ppr: pointsCents(box) / 100 };
    });
    const fresh = { id, position: p.position, age: p.age + shift, history, club: null };
    updateScouting(fresh);
    return fresh;
  });
  giveNames(players, spec.seed);
  const clubs = scheduleClubs(base, spec.seed);
  assignClubs(players, clubs, spec.seed);
  pricePlayers(players, 2026, adpModel, spec.seed);
  const allocation = allocateWorld(
    players,
    base,
    privateData.worlds[Math.floor(random() * privateData.worlds.length)],
    spec.seed,
  );
  return {
    catalog: retainFinishes({
      ...base,
      version: contextVersion(base, spec),
      seasonYear: 2026,
      rosterSize: 14,
      clubs,
      players,
    }),
    world: allocation.world,
  };
}
function nextUniverse(previous, spec, baseData, season) {
  retainFinishes(previous.catalog);
  const usedNames = new Set(previous.catalog.players.map((p) => p.name));
  const realMode = spec.identityMode === 'real',
    usedRealIds = new Set(previous.usedRealIds ?? []);
  const random = seededRandom(hashText(spec.seed + ':year:' + season)),
    year = 2025 + season;
  const finishes = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const rows = previous.catalog.players
      .filter((p) => p.position === pos)
      .map((p) => ({
        id: p.id,
        points: previous.world[p.id].reduce((n, r) => n + r[0], 0),
        games: previous.world[p.id].reduce((n, r) => n + r.at(-1), 0),
      }))
      .filter((p) => p.games > 0)
      .sort((a, b) => b.points - a.points);
    let rank = 0,
      last = null;
    rows.forEach((p, i) => {
      if (p.points !== last) rank = i + 1;
      finishes[p.id] = rank;
      last = p.points;
    });
  }
  const players = previous.catalog.players.map((p, i) => {
    const totals = Object.fromEntries(
      BOX_FIELDS.map((k, index) => [
        k,
        previous.world[p.id].reduce((sum, r) => sum + r[index + 1], 0),
      ]),
    );
    const history = p.history.map((h) => ({ ...h, relative_season: h.relative_season - 1 }));
    history.push({
      ...totals,
      age: p.age,
      relative_season: 0,
      ...(realMode ? { scheduled_games: 17 } : {}),
      ppr: pointsCents(totals) / 100,
      positionFinish: finishes[p.id] ?? null,
      listed_out_weeks: Array.from({ length: 18 }, (_, i) => i + 1).filter(
        (week) =>
          week !== p.bye &&
          injuryReport({ phase: 'season', week }, p, previous.world).kind === 'injury',
      ).length,
    });
    let next = { ...p, age: p.age + 1, history };
    const old = p.age >= { QB: 40, RB: 31, WR: 34, TE: 36 }[p.position];
    if ((old && random() < 0.32) || (totals.games === 0 && p.age >= 27 && random() < 0.55)) {
      next = {
        id: `R-${season}-${i}-${hashText(spec.id).toString(36)}`,
        position: p.position,
        age: 21 + Math.floor(random() * 4),
        history: [],
        club: p.club,
      };
      if (realMode) {
        const pool = baseData.realPlayers.players.filter(
          (candidate) =>
            candidate.position === p.position &&
            !usedRealIds.has(candidate.id) &&
            !usedNames.has(candidate.name),
        );
        const candidate = pool[Math.floor(random() * pool.length)];
        if (candidate) {
          next.name = candidate.name;
          next.realPlayerId = candidate.id;
          next.ageRandomized = true;
          next.historyKind = 'alternate-career';
          usedRealIds.add(candidate.id);
        } else next.generatedProspect = true;
      }
      if (!next.name) {
        const a = FIRST[Math.floor(random() * FIRST.length)],
          b = LAST[Math.floor(random() * LAST.length)];
        next.name = a + ' ' + b;
        while (usedNames.has(next.name))
          next.name =
            FIRST[Math.floor(random() * FIRST.length)] +
            ' ' +
            LAST[Math.floor(random() * LAST.length)];
      }
      usedNames.add(next.name);
    }
    updateScouting(next);
    return next;
  });
  const clubs = scheduleClubs(baseData.catalog, hashText(spec.seed + ':byes:' + season));
  assignClubs(players, clubs, spec.seed, true);
  pricePlayers(players, year, baseData.adpModel, hashText(spec.seed + ':market:' + season));
  const footballSeed = realMode
    ? hashText((spec.outcomeSeed ?? hashText(spec.seed + ':outcomes')) + ':football:' + season)
    : hashText(spec.seed + ':football:' + season);
  const footballRandom = realMode ? seededRandom(footballSeed) : random;
  const selected =
    baseData.privateData.worlds[Math.floor(footballRandom() * baseData.privateData.worlds.length)];
  const allocation = allocateWorld(players, baseData.catalog, selected, footballSeed);
  return {
    catalog: {
      ...baseData.catalog,
      version: contextVersion(baseData.catalog, { ...spec, season }),
      seasonYear: year,
      rosterSize: 14,
      ...(realMode ? { identityMode: 'real', historyKind: 'alternate-career' } : {}),
      clubs,
      players,
    },
    world: allocation.world,
    ...(realMode ? { usedRealIds: [...usedRealIds] } : {}),
  };
}
export function createUniverseResolver(baseData) {
  const cache = new Map();
  return function resolve(spec) {
    if (spec.baseVersion !== baseData.catalog.version)
      throw Error('This universe uses a different source library. Your save has been retained.');
    if (spec.identityMode && !['real', 'fictional'].includes(spec.identityMode))
      throw Error('Unknown universe identity mode.');
    if (
      spec.identityMode === 'real' &&
      (spec.realVersion !== baseData.realPlayers?.version || spec.legacyWorld !== undefined)
    )
      throw Error(
        'This real-player universe needs its original career library. Your save has been retained.',
      );
    const prefix =
      spec.id +
      ':' +
      spec.seed +
      ':' +
      (spec.legacyWorld ?? 'fresh') +
      ':' +
      (spec.identityMode === 'real'
        ? 'r1:' + spec.realVersion + ':' + (spec.outcomeSeed ?? 'default') + ':'
        : '');
    const key = prefix + spec.season;
    if (cache.has(key)) return cache.get(key);
    let current,
      start = 1;
    for (let n = spec.season - 1; n >= 1; n--)
      if (cache.has(prefix + n)) {
        current = cache.get(prefix + n);
        start = n;
        break;
      }
    if (!current) {
      current =
        spec.legacyWorld === undefined
          ? spec.identityMode === 'real'
            ? realInitialUniverse({ ...spec, season: 1 }, baseData)
            : initialUniverse({ ...spec, season: 1 }, baseData)
          : {
              catalog: {
                ...baseData.catalog,
                seasonYear: 2026,
                clubs: scheduleClubs(baseData.catalog, 0),
              },
              world: baseData.privateData.worlds[spec.legacyWorld],
            };
      cache.set(prefix + '1', current);
    }
    for (let n = start + 1; n <= spec.season; n++) {
      current = nextUniverse(current, spec, baseData, n);
      cache.set(prefix + n, current);
    }
    cache.set(key, current);
    while (cache.size > 6) cache.delete(cache.keys().next().value);
    return current;
  };
}
