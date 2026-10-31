// Every input to these reports is visible history or already completed games.
import { clubInfo, hashText } from './config.mjs';
export const BOX_FIELDS = [
  'attempts',
  'completions',
  'passing_yards',
  'passing_tds',
  'passing_interceptions',
  'carries',
  'rushing_yards',
  'rushing_tds',
  'targets',
  'receptions',
  'receiving_yards',
  'receiving_tds',
  'sack_fumbles_lost',
  'rushing_fumbles_lost',
  'receiving_fumbles_lost',
  'games',
];
const histories = new WeakMap();
const opportunities = (r) => (r.attempts ?? 0) + (r.carries ?? 0) + (r.targets ?? 0);
export function qualified(row) {
  return row.games > 0 && (opportunities(row) > 0 || row.ppr !== 0);
}
function ranked(rows) {
  const result = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const group = rows
      .filter((r) => r.position === pos && qualified(r))
      .sort(
        (a, b) => Math.round(b.ppr * 100) - Math.round(a.ppr * 100) || a.id.localeCompare(b.id),
      );
    let rank = 0,
      previous = null;
    group.forEach((row, i) => {
      const cents = Math.round(row.ppr * 100);
      if (cents !== previous) rank = i + 1;
      result[row.id] = rank;
      previous = cents;
    });
  }
  return result;
}
export function historicalRanks(catalog) {
  if (histories.has(catalog)) return histories.get(catalog);
  const seasons = {};
  for (const p of catalog.players)
    for (const h of p.history) {
      const relative = h.relative_season;
      (seasons[relative] ??= []).push({ ...h, id: p.id, position: p.position });
    }
  const result = Object.fromEntries(
    Object.entries(seasons).map(([year, rows]) => [year, ranked(rows)]),
  );
  // Completed finishes survive later retirements and new rookie classes.
  for (const p of catalog.players)
    for (const h of p.history)
      if (Object.hasOwn(h, 'positionFinish')) {
        if (h.positionFinish) result[h.relative_season][p.id] = h.positionFinish;
        else delete result[h.relative_season][p.id];
      }
  histories.set(catalog, result);
  return result;
}
export function currentRow(state, p) {
  const r = state.observed[p.id];
  return {
    ...Object.fromEntries(BOX_FIELDS.map((k) => [k, r?.totals?.[k] ?? 0])),
    ppr: (r?.points ?? 0) / 100,
    games: r?.games ?? 0,
    age: p.age,
    year: state.seasonYear ?? 2026,
    current: true,
    id: p.id,
    position: p.position,
  };
}
export function currentRanks(state, catalog) {
  return ranked(catalog.players.map((p) => currentRow(state, p)));
}
export function rankLabel(position, rank) {
  return rank ? position + rank : '—';
}
function role(p, observed) {
  const last = p.history.at(-1),
    prior = last ? opportunities(last) / Math.max(1, last.games) : 0;
  const recent = observed[p.id]?.recent ?? [];
  const used = recent.length
    ? recent.reduce((n, r) => n + r.opportunities, 0) / recent.length
    : prior;
  const weight = Math.min(0.7, (observed[p.id]?.games ?? 0) / 6);
  return (1 - weight) * prior + weight * used + 0.08 * p.basePpg;
}
export function depthCharts(catalog, state) {
  const result = {};
  for (const p of catalog.players) {
    const club = (result[p.club] ??= { QB: [], RB: [], WR: [], TE: [] });
    club[p.position].push(p);
  }
  for (const club of Object.values(result))
    for (const rows of Object.values(club))
      rows.sort((a, b) => role(b, state.observed) - role(a, state.observed) || a.adp - b.adp);
  return result;
}
export function playerOutlook(state, p, health, rank, depth) {
  const last = p.history.at(-1),
    record = state.observed[p.id],
    games = record?.games ?? 0;
  const current = games ? record.points / 100 / games : 0,
    baseline = p.basePpg;
  const recent = record?.recent ?? [],
    usage = recent.length ? recent.reduce((n, r) => n + r.opportunities, 0) / recent.length : 0;
  const before = last ? opportunities(last) / Math.max(1, last.games) : 0;
  let category = 'preseason',
    headline = 'A history to work with',
    body;
  if (health?.kind === 'injury') category = 'injury';
  else if (health?.designation === 'INACTIVE') category = 'role';
  else if (games >= 3 && before > 2 && usage < before * 0.65) category = 'shrinking';
  else if (games >= 3 && current > baseline * 1.2 && usage > before * 1.1) category = 'rising';
  else if (games >= 3 && current < baseline * 0.7) category = 'struggling';
  else if (games >= 2 && rank && rank <= { QB: 12, RB: 24, WR: 24, TE: 12 }[p.position])
    category = 'strong';
  else if (games) category = 'settling';
  const options = {
    preseason: [
      [
        'A useful starting point',
        'The recent history offers a reasonable starting point, but a new season can reshape the workload. Watch the early opportunities before treating last year as a promise.',
      ],
      [
        'Room for a new chapter',
        'Past production puts this player on the radar. Age, availability and competition leave a range of possible outcomes rather than one obvious next step.',
      ],
    ],
    injury: [
      [
        'Availability comes first',
        'The current injury report makes the return window a consideration. Recovery estimates can move in either direction, and the first game back may not settle the workload question.',
      ],
      [
        'A hold with some uncertainty',
        'There is production in the background, but health is the immediate concern. Treat the reported return range as an estimate and keep a backup plan.',
      ],
    ],
    role: [
      [
        'Waiting for an opening',
        'The current game-day role is uncertain, rather than a confirmed medical absence. A clearer path to opportunities would help; a roster spot alone does not establish one.',
      ],
      [
        'Opportunity is the question',
        'There is no injury timetable attached to the current inactive designation. Monitor participation and depth-chart competition before assuming a rebound.',
      ],
    ],
    shrinking: [
      [
        'The workload bears watching',
        'Recent opportunities have eased compared with the previous season. That may be temporary, but competition for touches is worth monitoring before leaning on an automatic bounce-back.',
      ],
      [
        'A role under pressure',
        'The recent usage is quieter than the history might suggest. A stronger game could change the conversation, but the opportunity trend deserves attention.',
      ],
    ],
    rising: [
      [
        'An encouraging stretch',
        'Recent production has come with stronger involvement. That is encouraging, though a short run of games is not enough to guarantee the same pace going forward.',
      ],
      [
        'Building a case',
        'The player is earning more work and turning it into points. There is a plausible path to more useful weeks, with normal volatility still part of the picture.',
      ],
    ],
    struggling: [
      [
        'Searching for a response',
        'The scoring pace has lagged behind the recent history. A recovery remains possible, but the next few weeks of usage will say more than reputation alone.',
      ],
      [
        'A difficult stretch',
        'The returns have been quieter than hoped. There may still be useful games ahead; distinguishing a cold spell from a changed role will take more evidence.',
      ],
    ],
    strong: [
      [
        'Producing near the front',
        'The position rank reflects a strong run so far. It is a useful result, rather than a guarantee: touchdowns, health and weekly game plans can still move the picture.',
      ],
      [
        'A productive season so far',
        'The scoring has put this player among the more useful options at the position. The workload is worth following, while another big week is never assured.',
      ],
    ],
    settling: [
      [
        'Still taking shape',
        'There are results to work with, but the sample still leaves room for several outcomes. Keep the weekly involvement in view alongside the scoring.',
      ],
      [
        'Clues, not a verdict',
        'The early returns add context to the career history. A few games can swing the position rank quickly, so avoid treating the current pace as a settled forecast.',
      ],
    ],
  };
  const index = hashText(p.id + ':' + state.week + ':' + category) % options[category].length;
  [headline, body] = options[category][index];
  const signals = [];
  if (games) signals.push(`${games} games · ${current.toFixed(1)} PPR/game`);
  if (games >= 2 && before > 0)
    signals.push(
      `${usage.toFixed(1)} recent opportunities/game vs ${before.toFixed(1)} last season`,
    );
  if (depth) signals.push(`${clubInfo(p.club).abbreviation} projected ${p.position}${depth}`);
  if (p.age >= { QB: 34, RB: 28, WR: 30, TE: 31 }[p.position])
    signals.push('Veteran workload and availability warrant attention');
  return {
    headline,
    body,
    signals,
    category,
    asOf: Math.min(state.week, 18),
    basis: 'Visible history and completed games; an opinion, not a hidden rating',
  };
}
export function playerProfile(state, catalog, id, health) {
  const p = catalog.players.find((p) => p.id === id);
  if (!p) return null;
  const past = historicalRanks(catalog),
    ranks = currentRanks(state, catalog),
    depth = depthCharts(catalog, state)[p.club]?.[p.position].findIndex((x) => x.id === id) + 1;
  const year = state.seasonYear ?? catalog.seasonYear ?? 2026;
  const rows = p.history
    .map((h) => ({
      ...h,
      year: year - 1 + h.relative_season,
      rank: past[h.relative_season]?.[id] ?? null,
      current: false,
    }))
    .reverse();
  if (state.week > 1) rows.unshift({ ...currentRow(state, p), rank: ranks[id] ?? null });
  const lastRank = rows.find((r) => !r.current)?.rank ?? null;
  return {
    rows,
    rank: ranks[id] ?? null,
    lastRank,
    depth,
    club: clubInfo(p.club),
    health,
    outlook: playerOutlook(state, p, health, ranks[id], depth),
    throughWeek: Math.min(18, state.week - 1),
  };
}
export function statValue(row, key) {
  if (key === 'ppg') return row.games ? row.ppr / row.games : null;
  const ratios = {
    completion_pct: ['completions', 'attempts', 100],
    passing_ypa: ['passing_yards', 'attempts', 1],
    rushing_ypc: ['rushing_yards', 'carries', 1],
    receiving_ypt: ['receiving_yards', 'targets', 1],
    receiving_ypr: ['receiving_yards', 'receptions', 1],
  };
  if (ratios[key]) {
    const [a, b, m] = ratios[key];
    return row[b] ? (row[a] / row[b]) * m : null;
  }
  return row[key] ?? null;
}
export function rankTone(position, rank) {
  if (!rank) return 'neutral';
  const n = position === 'RB' || position === 'WR' ? 24 : 12;
  return rank <= n ? 'good' : rank <= 2 * n ? 'mid' : 'low';
}
export function statTone(row, key, position, catalog, state) {
  if (['ppr', 'age'].includes(key)) return 'neutral';
  if (key === 'rank') return rankTone(position, row.rank);
  if (key === 'games') {
    const possible = row.current
      ? Math.max(
          1,
          Math.min(state.week - 1, 18) -
            (state.week - 1 >= catalog.players.find((p) => p.id === row.id)?.bye ? 1 : 0),
        )
      : (row.scheduled_games ?? 17);
    return row.games / possible >= 0.8 ? 'good' : row.games / possible >= 0.45 ? 'mid' : 'low';
  }
  const thresholds = {
    completion_pct: ['attempts', 50],
    passing_ypa: ['attempts', 50],
    rushing_ypc: ['carries', 20],
    receiving_ypt: ['targets', 15],
    receiving_ypr: ['receptions', 10],
  };
  const condition = thresholds[key];
  if (condition && (row[condition[0]] ?? 0) < condition[1]) return 'neutral';
  const value = statValue(row, key);
  if (value === null) return 'neutral';
  const peers = catalog.players
    .filter((p) => p.position === position)
    .map((p) =>
      row.current
        ? currentRow(state, p)
        : p.history.find((h) => h.relative_season === row.relative_season),
    )
    .filter((r) => r && qualified(r))
    .sort((a, b) => b.ppr - a.ppr)
    .slice(0, { QB: 32, RB: 64, WR: 96, TE: 48 }[position])
    .filter((r) => !condition || r[condition[0]] >= condition[1]);
  const values = peers.map((r) => statValue(r, key)).filter((v) => v !== null);
  if (values.length < 3) return 'neutral';
  const fraction = values.filter((v) => v <= value).length / values.length;
  const quality = key === 'passing_interceptions' ? 1 - fraction : fraction;
  return quality >= 2 / 3 ? 'good' : quality >= 1 / 3 ? 'mid' : 'low';
}
