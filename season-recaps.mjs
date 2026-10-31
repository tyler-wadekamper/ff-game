// Postgame feedback: facts from locked rosters and completed games only.
import { optimalLineup } from './strategy.mjs';
import { injuryReport } from './injuries.mjs';
import { forecast } from './strategy.mjs';
const sum = (a) => a.reduce((n, x) => n + x, 0);
const grade = (ratio) =>
  ratio >= 0.95 ? 'A' : ratio >= 0.85 ? 'B' : ratio >= 0.7 ? 'C' : ratio >= 0.5 ? 'D' : 'F';
function best(roster, players, value) {
  const lineup = optimalLineup(roster, players, value).map((id) =>
    id && value(players.get(id)) > 0 ? id : null,
  );
  return { lineup, points: sum(lineup.map((id) => (id ? value(players.get(id)) : 0))) };
}
export function captureWeek(state, catalog, players, world, projection) {
  const week = state.week,
    nfl = {};
  for (const p of catalog.players) {
    const r = world[p.id][week - 1];
    if (r.at(-1) || r[0]) nfl[p.id] = [r[0], r.at(-1), r[1] + r[6] + r[9]];
  }
  const teams = state.teams.map((t) => {
    const chosen = sum(t.lineup.map((id) => (id ? (nfl[id]?.[0] ?? 0) : 0)));
    const hindsight = best(t.roster, players, (p) => nfl[p.id]?.[0] ?? 0);
    const projectedBest = best(t.roster, players, (p) => projection(p));
    const projectedChosen = sum(t.lineup.map((id) => (id ? projection(players.get(id)) : 0)));
    const medicalValue = (p) =>
      p.bye === week || injuryReport(state, p, world).kind === 'role'
        ? 0
        : forecast(p, state.observed);
    const full = best([...t.roster, ...(t.ir ?? [])], players, medicalValue);
    const available = best([...t.roster, ...(t.ir ?? [])], players, (p) =>
      injuryReport(state, p, world).kind === 'injury' ? 0 : medicalValue(p),
    );
    return {
      id: t.id,
      roster: [...t.roster],
      ir: [...(t.ir ?? [])],
      lineup: [...t.lineup],
      score: chosen,
      hindsightBest: hindsight.points,
      benchPoints: Math.max(0, hindsight.points - chosen),
      lineupGrade: grade(projectedBest.points > 0 ? projectedChosen / projectedBest.points : 1),
      decisionEfficiency: projectedBest.points > 0 ? projectedChosen / projectedBest.points : 1,
      captureEfficiency:
        hindsight.points > 0 ? Math.max(0, chosen) / hindsight.points : chosen < 0 ? 0 : 1,
      medicalImpact: Math.max(0, full.points - available.points),
      medicalPlayers: [...t.roster, ...(t.ir ?? [])].filter(
        (id) => injuryReport(state, players.get(id), world).kind === 'injury',
      ),
      benchRegret:
        hindsight.lineup
          .filter((id) => id && !t.lineup.includes(id))
          .sort((a, b) => (nfl[b]?.[0] ?? 0) - (nfl[a]?.[0] ?? 0))[0] ?? null,
    };
  });
  return { week, nfl, teams };
}
function pointTotals(state, through) {
  const values = {};
  let ledger = false;
  for (const [id, record] of Object.entries(state.observed ?? {}))
    if (record.weeklyPoints) {
      ledger = true;
      for (const n of record.weeklyPoints.slice(0, through))
        if (n !== null) values[id] = (values[id] ?? 0) + n;
    }
  if (ledger) return values;
  for (const w of state.weekRecords ?? [])
    if (w.week <= through)
      for (const [id, r] of Object.entries(w.nfl))
        if (r[1] && (r[2] > 0 || r[0] !== 0)) values[id] = (values[id] ?? 0) + r[0];
  return values;
}
function positionalRanks(catalog, totals) {
  const ranks = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    let rank = 0,
      last = null;
    catalog.players
      .filter((p) => p.position === pos && Object.hasOwn(totals, p.id))
      .sort((a, b) => totals[b.id] - totals[a.id])
      .forEach((p, i) => {
        if (totals[p.id] !== last) rank = i + 1;
        ranks[p.id] = rank;
        last = totals[p.id];
      });
  }
  return ranks;
}
function draftAwards(state, catalog, through) {
  const byId = new Map(catalog.players.map((p) => [p.id, p])),
    totals = pointTotals(state, through),
    ranks = positionalRanks(catalog, totals);
  const count = {},
    picks = state.picks.map((pick) => {
      const p = byId.get(pick.player),
        positionCost = (count[p.position] = (count[p.position] ?? 0) + 1);
      return {
        ...pick,
        name: p.name,
        position: p.position,
        adp: p.adp,
        positionCost,
        finish: ranks[p.id] ?? null,
        points: (totals[p.id] ?? 0) / 100,
        reach: Math.max(0, p.adp - pick.pick),
        discount: pick.pick - p.adp,
      };
    });
  const steals = picks
    .filter((p) => p.finish && p.positionCost > p.finish)
    .sort((a, b) => b.positionCost - b.finish - (a.positionCost - a.finish) || b.points - a.points);
  return {
    steal: steals[0] ?? null,
    reach: [...picks].filter((p) => p.reach > 0).sort((a, b) => b.reach - a.reach)[0] ?? null,
    picks,
    ranks,
  };
}
export function weeklyRecap(state, catalog, week) {
  const record = state.weekRecords?.find((r) => r.week === week);
  if (!record) return null;
  const user = record.teams[state.human],
    match = state.results.find(
      (g) => g.week === week && (g.a === state.human || g.b === state.human),
    );
  const others = record.teams.filter((t) => t.id !== state.human),
    beat = others.filter((t) => user.score > t.score).length;
  const scoreRank = 1 + others.filter((t) => t.score > user.score).length;
  const win = match?.winner === state.human,
    lost = match && match.winner !== null && !win;
  const margin = match ? Math.abs(match.sa - match.sb) / 100 : null;
  const draft = draftAwards(state, catalog, week),
    topPlayers = Object.entries(record.nfl)
      .sort((a, b) => b[1][0] - a[1][0])
      .slice(0, 3)
      .map(([id, r]) => ({ id, points: r[0] / 100 }));
  const worstInjury = [...record.teams].sort((a, b) => b.medicalImpact - a.medicalImpact)[0];
  const bench = user.benchRegret
    ? { id: user.benchRegret, points: (record.nfl[user.benchRegret]?.[0] ?? 0) / 100 }
    : null;
  const starters = user.lineup
    .filter(Boolean)
    .map((id) => ({ id, points: (record.nfl[id]?.[0] ?? 0) / 100 }));
  const mvp = [...starters].sort((a, b) => b.points - a.points)[0] ?? null;
  const cold = [...starters].sort((a, b) => a.points - b.points)[0] ?? null;
  const waiverWins = state.transactions
    .filter((t) => t.add && t.week <= week && ['Waiver', 'Free agent'].includes(t.source))
    .filter(
      (t) =>
        record.teams[t.team].lineup.includes(t.add) && record.teams[t.team].roster.includes(t.add),
    )
    .map((t) => ({
      id: t.add,
      team: t.team,
      bid: t.bid,
      points: (record.nfl[t.add]?.[0] ?? 0) / 100,
    }))
    .sort((a, b) => b.points - a.points);
  const seen = new Set();
  const uniqueWaivers = waiverWins.filter((w) => {
    const k = w.team + ':' + w.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const badBeats = state.results
    .filter((g) => g.week === week && g.winner !== null)
    .map((g) => {
      const loser = g.winner === g.a ? g.b : g.a,
        score = record.teams[loser].score;
      return {
        team: loser,
        score: score / 100,
        rank: 1 + record.teams.filter((t) => t.score > score).length,
        margin: Math.abs(g.sa - g.sb) / 100,
      };
    })
    .filter((g) => g.rank <= 3 || g.margin <= 3)
    .sort((a, b) => a.rank - b.rank || a.margin - b.margin);
  let headline = !match
    ? 'A bye earned, a roster to manage'
    : win
      ? 'A Sunday to build on'
      : match.winner === null
        ? 'Nothing between you'
        : 'A week to regroup';
  let message = `You outscored ${beat} of the other 11 teams. `;
  if (lost && scoreRank <= 3) {
    headline = 'The schedule had other ideas';
    message += `A top-${scoreRank} league score still ran into a loss. That is a bad matchup break, not proof of a bad team.`;
  } else if (lost && margin <= 3) {
    headline = 'A bad beat at the wire';
    message += `Only ${margin.toFixed(2)} points separated the teams. Small weekly swings can decide a sensible lineup.`;
  } else if (win && scoreRank >= 9) {
    headline = 'Take the win and keep the receipt';
    message +=
      'The fixture was kind this week. Bank the result while keeping the underlying production in view.';
  } else
    message += `Your pregame lineup choices earned ${user.lineupGrade} on the public projection scorecard.`;
  return {
    week,
    headline,
    message,
    score: user.score / 100,
    scoreRank,
    allPlayWins: beat,
    allPlayLosses: others.filter((t) => user.score < t.score).length,
    allPlayTies: others.filter((t) => user.score === t.score).length,
    margin,
    lineupGrade: user.lineupGrade,
    decisionEfficiency: user.decisionEfficiency,
    pointsCaptured: user.captureEfficiency,
    pointsOnBench: user.benchPoints / 100,
    bench,
    mvp,
    cold,
    waiverWin: uniqueWaivers[0] ?? null,
    yourWaiverWin: uniqueWaivers.find((w) => w.team === state.human) ?? null,
    leagueBadBeat: badBeats[0] ?? null,
    processNote:
      user.lineupGrade === 'A'
        ? 'Your starters followed a strong pregame case. Hindsight bench fireworks do not automatically make that a poor decision.'
        : 'There was room to improve the lineup on the information available before kickoff.',
    injuryImpact: user.medicalImpact,
    injuredCount: user.medicalPlayers.length,
    worstInjury: {
      team: worstInjury.id,
      impact: worstInjury.medicalImpact,
      count: worstInjury.medicalPlayers.length,
    },
    topPlayers,
    steal: draft.steal,
    biggestReach: draft.reach,
    sampleNote:
      week < 4
        ? 'Early-season awards are provisional; the sample is small.'
        : 'Awards use completed games only; nothing here forecasts the next week.',
  };
}
export function yearlyRecap(state, catalog) {
  if (state.phase !== 'complete') return null;
  const byId = new Map(catalog.players.map((p) => [p.id, p])),
    totals = pointTotals(state, 18),
    draft = draftAwards(state, catalog, 18);
  const teams = state.teams.map((t) => {
    const ids = state.picks.filter((p) => p.team === t.id).map((p) => p.player);
    const process = best(ids, byId, (p) => p.basePpg).points,
      result = best(ids, byId, (p) => (totals[p.id] ?? 0) / 100).points;
    const weeks = (state.weekRecords ?? []).map((w) => w.teams[t.id]);
    return {
      id: t.id,
      process,
      result,
      injuryImpact: sum(weeks.map((w) => w.medicalImpact)),
      benchPoints: sum(weeks.map((w) => w.benchPoints)) / 100,
      decisionEfficiency: weeks.length
        ? sum(weeks.map((w) => w.decisionEfficiency)) / weeks.length
        : 1,
    };
  });
  const user = teams[state.human],
    processRank = 1 + teams.filter((t) => t.process > user.process).length,
    resultRank = 1 + teams.filter((t) => t.result > user.result).length;
  const recordedWeeks = (state.weekRecords ?? []).length,
    hasCoachingData = recordedWeeks > 0;
  const worst = [...teams].sort((a, b) => b.injuryImpact - a.injuryImpact)[0];
  const reports = (state.weekRecords ?? [])
    .map((w) => weeklyRecap(state, catalog, w.week))
    .filter(Boolean);
  const leagueBeat =
    reports
      .map((r) => (r.leagueBadBeat ? { ...r.leagueBadBeat, week: r.week } : null))
      .filter(Boolean)
      .sort((a, b) => a.rank - b.rank || a.margin - b.margin)[0] ?? null;
  const leaders = ['QB', 'RB', 'WR', 'TE']
    .map((pos) => {
      const p = catalog.players.filter((p) => p.position === pos && draft.ranks[p.id] === 1)[0];
      return p ? { id: p.id, position: pos, points: (totals[p.id] ?? 0) / 100 } : null;
    })
    .filter(Boolean);
  const beats = reports
    .filter(
      (r) =>
        r &&
        (r.scoreRank <= 3 || r.margin <= 3) &&
        state.results.some(
          (g) =>
            g.week === r.week &&
            (g.a === state.human || g.b === state.human) &&
            g.winner !== state.human &&
            g.winner !== null,
        ),
    )
    .sort((a, b) => a.scoreRank - b.scoreRank || a.margin - b.margin);
  const ownedDraft = draft.picks.filter((p) => p.team === state.human);
  const hits = ownedDraft
    .filter((p) => p.finish)
    .sort((a, b) => b.positionCost - b.finish - (a.positionCost - a.finish));
  const misses = ownedDraft
    .filter((p) => p.pick <= 48 && (!p.finish || p.finish > p.positionCost))
    .sort((a, b) => (b.finish ?? 200) - b.positionCost - ((a.finish ?? 200) - a.positionCost));
  const pickups = state.transactions
    .filter((t) => t.team === state.human && t.add && ['Waiver', 'Free agent'].includes(t.source))
    .map((t) => ({
      ...t,
      lineupPoints:
        sum(
          (state.weekRecords ?? [])
            .filter(
              (w) =>
                w.week >= t.week &&
                w.teams[state.human].lineup.includes(t.add) &&
                !state.transactions.some(
                  (later) =>
                    later.team === state.human &&
                    later.drop === t.add &&
                    later.week >= t.week &&
                    later.week <= w.week,
                ),
            )
            .map((w) => w.nfl[t.add]?.[0] ?? 0),
        ) / 100,
    }))
    .sort((a, b) => b.lineupPoints - a.lineupPoints);
  return {
    year: state.seasonYear,
    champion: state.champion,
    regularRecord: {
      wins: state.teams[state.human].wins,
      losses: state.teams[state.human].losses,
      ties: state.teams[state.human].ties,
    },
    processDraftRank: processRank,
    outcomeDraftRank: resultRank,
    recordedWeeks,
    coverageNote:
      recordedWeeks < 18
        ? `Detailed coaching, medical and waiver scorecards cover ${recordedWeeks} of 18 weeks. Earlier saved weeks have no roster snapshots; draft production still uses all completed player scores.`
        : null,
    lineupGrade: hasCoachingData ? grade(user.decisionEfficiency) : null,
    lineupDecisionEfficiency: user.decisionEfficiency,
    pointsOnBench: hasCoachingData ? user.benchPoints : null,
    injuryImpact: hasCoachingData ? user.injuryImpact : null,
    worstInjury: hasCoachingData ? worst : null,
    steal: draft.steal,
    biggestReach: draft.reach,
    yourHit: hits.find((p) => p.positionCost > p.finish) ?? null,
    yourMiss: misses[0] ?? null,
    bestPickup: pickups[0] ?? null,
    badBeat: beats[0] ?? null,
    leagueBadBeat: leagueBeat,
    leaders,
    note: 'Draft process uses preseason estimates; draft results and bench points are hindsight. Injuries and the fixture can change outcomes without making the original choice wrong.',
  };
}
