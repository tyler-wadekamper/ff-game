// Decision functions receive visible information only, never a season world.
import { ROSTER_SIZE } from './config.mjs';
export const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'FLEX'];
export const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
export const MINIMUM = { QB: 1, RB: 2, WR: 2, TE: 1 };
export const PROFILES = [
  {
    name: 'Gridiron Labs',
    style: 'Value analyst',
    plan: 'value',
    skill: 0.95,
    noise: 0.055,
    note: 'Patient, roster-aware, follows positional value.',
  },
  {
    name: 'The Anchors',
    style: 'Hero RB',
    plan: 'hero',
    skill: 0.84,
    noise: 0.12,
    note: 'One premium running back, then receiver depth.',
  },
  {
    name: 'Air Traffic',
    style: 'Zero RB',
    plan: 'zero',
    skill: 0.82,
    noise: 0.14,
    note: 'Stacks receivers early; hunts running backs later.',
  },
  {
    name: 'Launch Control',
    style: 'Early QB',
    plan: 'quarterback',
    skill: 0.64,
    noise: 0.22,
    note: 'Pays up for a quarterback and builds around them.',
  },
  {
    name: 'Tight End Club',
    style: 'Elite TE',
    plan: 'tightend',
    skill: 0.76,
    noise: 0.17,
    note: 'Will spend an early pick on a difference-making tight end.',
  },
  {
    name: 'Sunday Scholars',
    style: 'Tier drafter',
    plan: 'tiers',
    skill: 0.96,
    noise: 0.055,
    note: 'Watches positional drop-offs and avoids unnecessary reaches.',
  },
  {
    name: 'Tomorrow FC',
    style: 'Upside hunter',
    plan: 'upside',
    skill: 0.7,
    noise: 0.2,
    note: 'Prefers younger players, growth and late-round upside.',
  },
  {
    name: 'Glory Days',
    style: 'Nostalgist',
    plan: 'nostalgia',
    skill: 0.3,
    noise: 0.5,
    note: 'Falls in love with a great season from a few years ago.',
  },
  {
    name: 'Ground & Pound',
    style: 'RB heavy',
    plan: 'running',
    skill: 0.58,
    noise: 0.28,
    note: 'Builds running back depth, even when receivers are better value.',
  },
  {
    name: 'The Wildcards',
    style: 'Big reach energy',
    plan: 'wildcard',
    skill: 0.2,
    noise: 0.85,
    note: 'Unpredictable favorites, expensive reaches and splashy waiver bids.',
  },
  {
    name: 'Paper Tigers',
    style: 'Casual contender',
    plan: 'casual',
    skill: 0.4,
    noise: 0.44,
    note: 'Generally follows ADP, but can miss value and overreact to a big week.',
  },
];

export function counts(ids, players) {
  const result = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const id of ids) result[players.get(id).position]++;
  return result;
}
export function eligible(position, slot) {
  return position === slot || (slot === 'FLEX' && position !== 'QB');
}
export function rosterComplete(ids, players) {
  const n = counts(ids, players);
  return POSITIONS.every((p) => n[p] >= MINIMUM[p]) && n.RB + n.WR + n.TE >= 7;
}
export function canDraft(roster, player, players) {
  if (roster.length >= ROSTER_SIZE || roster.includes(player.id)) return false;
  return rosterFeasible([...roster, player.id], players);
}
export function rosterFeasible(roster, players) {
  if (roster.length > ROSTER_SIZE) return false;
  const n = counts(roster, players);
  if (n.QB > 3 || n.TE > 4) return false;
  const missingSkills = Math.max(
    Math.max(0, 2 - n.RB) + Math.max(0, 2 - n.WR) + Math.max(0, 1 - n.TE),
    7 - n.RB - n.WR - n.TE,
  );
  return Math.max(0, 1 - n.QB) + missingSkills <= ROSTER_SIZE - roster.length;
}
export function canSwap(roster, add, drop, players) {
  if (!players.has(add) || !roster.includes(drop) || roster.includes(add)) return false;
  const after = roster.filter((id) => id !== drop).concat(add);
  return rosterFeasible(after, players);
}
export function canAcquire(roster, add, drop, players) {
  return (
    players.has(add) &&
    (drop === null || drop === undefined
      ? canDraft(roster, players.get(add), players)
      : canSwap(roster, add, drop, players))
  );
}
export function forecast(player, observed = {}) {
  const record = observed[player.id];
  if (!record?.games) return player.basePpg;
  const recent = record.last.slice(-4);
  const recentPpg = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length) / 100;
  const weight = Math.min(0.65, record.games / (record.games + 5));
  return Math.max(0, (1 - weight) * player.basePpg + weight * recentPpg);
}
export function pickPlayer({ roster, available, players, profile, round, random }) {
  const n = counts(roster, players);
  const pool = available.filter((p) => canDraft(roster, p, players));
  if (!pool.length) throw new Error('No legal draft candidates');
  // All managers can see ADP. Restrict deliberation to a broad, plausible window.
  const short = pool.slice(0, 85);
  for (const pos of POSITIONS) {
    const first = pool.find((p) => p.position === pos);
    if (first && !short.includes(first)) short.push(first);
  }
  const replacement = { QB: 16, RB: 7, WR: 8, TE: 6 };
  const scores = short.map((p) => {
    let score = -Math.log(Math.max(1, p.adp));
    const pos = p.position,
      quantity = n[pos];
    score += profile.skill * 0.06 * (p.basePpg - replacement[pos]);
    if (quantity < MINIMUM[pos]) score += 0.12 + 0.035 * round;
    if (pos === 'QB' && quantity >= 1) score -= quantity === 1 ? 1.8 : 3.3;
    if (pos === 'TE' && quantity >= 1) score -= quantity === 1 ? 1 : 2.2;
    if ((pos === 'RB' || pos === 'WR') && quantity >= 6) score -= 0.5 * (quantity - 5);
    if (profile.plan === 'hero') {
      if (round <= 2 && pos === 'RB' && !n.RB) score += 0.7;
      if (round <= 5 && n.RB) score += pos === 'WR' ? 0.55 : pos === 'RB' ? -1 : 0;
    }
    if (profile.plan === 'zero' && round <= 4)
      score += pos === 'RB' ? -1.4 : pos === 'WR' ? 0.45 : 0;
    if (profile.plan === 'quarterback' && round <= 4 && pos === 'QB' && !n.QB) score += 1.05;
    if (profile.plan === 'tightend' && round <= 4 && pos === 'TE' && !n.TE && p.adp < 70)
      score += 0.9;
    if (profile.plan === 'running' && pos === 'RB' && quantity < 5) score += 0.5;
    if (profile.plan === 'upside' && p.age <= 25) score += 0.3;
    if (profile.plan === 'nostalgia') {
      const peak = Math.max(...p.history.slice(-4).map((h) => h.ppr / Math.max(h.games, 1)), 0);
      score += 0.08 * Math.max(0, peak - p.basePpg) + (p.age >= 29 ? 0.18 : 0);
    }
    if (profile.plan === 'tiers' && quantity < MINIMUM[pos]) {
      const next = pool.filter((x) => x.position === pos)[Math.min(4, Math.max(1, 12 - round))];
      if (next) score += 0.06 * Math.max(0, p.basePpg - next.basePpg);
    }
    // A fixed game skill knob, not a claim about the measured frequency of bad managers.
    score += profile.noise * -Math.log(-Math.log(Math.max(0.00001, random())));
    return { player: p, score };
  });
  scores.sort((a, b) => b.score - a.score);
  return scores[0].player;
}

export function optimalLineup(roster, players, value) {
  const chosen = new Set(),
    lineup = [];
  for (const slot of SLOTS) {
    const candidates = roster.filter(
      (id) => !chosen.has(id) && eligible(players.get(id).position, slot),
    );
    candidates.sort((a, b) => value(players.get(b)) - value(players.get(a)));
    const id = candidates[0] ?? null;
    if (id) chosen.add(id);
    lineup.push(id);
  }
  return lineup;
}
