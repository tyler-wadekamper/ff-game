// Fictional medical stories explain a subset of empirical absence blocks.
// Timetables are noisy assessments, never an exposed true return date.
import { hashText, seededRandom } from './config.mjs';
const libraries = new WeakMap();
function episodesFor(p, world) {
  let cache = libraries.get(world);
  if (!cache) {
    cache = new Map();
    libraries.set(world, cache);
  }
  if (cache.has(p.id)) return cache.get(p.id);
  const games = world[p.id]
    .map((row, i) => ({ week: i + 1, played: !!row.at(-1) }))
    .filter((r) => r.week !== p.bye);
  const mask = games.map((g) => Number(g.played)).join('');
  const random = seededRandom(hashText(p.id + ':medical:' + mask));
  const result = [];
  let start = 0;
  while (start < games.length) {
    if (games[start].played) {
      start++;
      continue;
    }
    let end = start;
    while (end + 1 < games.length && !games[end + 1].played) end++;
    const length = end - start + 1,
      productive = p.basePpg >= { QB: 6, RB: 3, WR: 3, TE: 2 }[p.position];
    const medical = random() < (productive ? 0.78 : 0.23);
    const ir = medical && length >= 4 && random() < 0.72;
    const normal =
      Math.sqrt(-2 * Math.log(Math.max(0.00001, random()))) * Math.cos(2 * Math.PI * random());
    const perceived = Math.max(1, Math.round(length * Math.exp(0.55 * normal)));
    const low = Math.max(ir ? 4 : 1, Math.floor(perceived * 0.65));
    const high = Math.max(low + 1, Math.ceil(perceived * 1.45) + 1);
    const label = [
      'Lower-body issue',
      'Soft-tissue concern',
      'Upper-body issue',
      'Knee/ankle recovery',
    ][Math.floor(random() * 4)];
    let last = games[end].week;
    if (p.bye === last + 1) last++;
    const minReturn = ir
      ? (games[start + 4]?.week ?? games[start].week + 5)
      : games[start].week + 1;
    result.push({
      start: games[start].week,
      end: last,
      medical,
      ir,
      label,
      estimateLow: Math.max(games[start].week + low, minReturn),
      estimateHigh: Math.max(games[start].week + high, minReturn + 1),
      minReturn,
    });
    start = end + 1;
  }
  cache.set(p.id, result);
  return result;
}
export function injuryReport(state, p, world) {
  const week = Math.min(state.week, 18);
  if (state.phase === 'complete')
    return {
      designation: 'FINISHED',
      kind: 'none',
      irEligible: false,
      label: 'Season complete',
      returnEstimate: null,
    };
  const episode = episodesFor(p, world).find((e) => e.start <= week && e.end >= week);
  if (episode?.medical) {
    let low = episode.estimateLow,
      high = episode.estimateHigh;
    // Overdue reports get a new, still uncertain assessment based on elapsed time.
    if (high <= week) {
      const random = seededRandom(hashText(p.id + ':recheck:' + week));
      low = week + 1;
      high = week + 2 + Math.floor(random() * 3);
    }
    low = Math.max(week + 1, low);
    high = Math.max(low + 1, high);
    const remaining = { low: low - week, high: high - week };
    return {
      designation: episode.ir ? 'IR' : 'OUT',
      kind: 'injury',
      label: episode.label,
      irEligible: true,
      reportedWeek: episode.start,
      onBye: p.bye === week,
      returnEstimate: remaining,
      returnWindow: `${remaining.low}–${remaining.high} weeks (estimate)`,
      note: episode.ir
        ? 'Injured reserve: at least four scheduled team games. Return assessment may change.'
        : 'Return range is an assessment, not a scheduled return date.',
    };
  }
  if (p.bye === week)
    return {
      designation: 'BYE',
      kind: 'bye',
      irEligible: false,
      label: 'Scheduled bye',
      returnEstimate: null,
    };
  if (!world[p.id][week - 1].at(-1))
    return {
      designation: 'INACTIVE',
      kind: 'role',
      irEligible: false,
      label: 'Outside the current game-day plans',
      returnEstimate: null,
      note: 'No medical return timetable; watch the role and participation.',
    };
  const recent = episodesFor(p, world).some((e) => e.medical && e.end < week && e.end >= week - 2);
  return {
    designation: 'HEALTHY',
    kind: 'none',
    irEligible: false,
    label: recent ? 'Available after a recent absence' : 'Available',
    returnEstimate: null,
    note: recent ? 'Return to participation does not guarantee a full workload.' : null,
  };
}
