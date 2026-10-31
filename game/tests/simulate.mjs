// Repeatable playtest: strategy diversity, visible roster quality, full seasons.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { loadData } from '../server.mjs';
import { createLeague, autoPick, applyAction, assertLeague } from '../engine.mjs';
import { optimalLineup } from '../strategy.mjs';
const { catalog, players, privateData } = loadData();
const engineFingerprint = createHash('sha256')
  .update(fs.readFileSync('game/engine.mjs'))
  .update(fs.readFileSync('game/strategy.mjs'))
  .digest('hex');
const profiles = {},
  summary = {
    engineFingerprint,
    catalogVersion: catalog.version,
    drafts: 240,
    seasons: 120,
    draftPicks: 0,
    weeklyAdvances: 0,
    invalidLeagues: 0,
    byProfile: {},
  };
for (let i = 0; i < summary.drafts; i++) {
  const s = createLeague({
    name: 'Playtest',
    slot: i % 12,
    seed: 20261101 + i,
    version: catalog.version,
    worlds: privateData.worlds.length,
  });
  while (s.phase === 'draft') autoPick(s, catalog, players);
  assertLeague(s, players);
  summary.draftPicks += s.picks.length;
  for (const t of s.teams.filter((t) => t.profile)) {
    const row = profiles[t.profile.plan] ?? {
      style: t.profile.style,
      skill: t.profile.skill,
      n: 0,
      projectedStarterPpg: 0,
      first4RB: 0,
      first4WR: 0,
      reach: 0,
      wins: 0,
      champions: 0,
      seasons: 0,
    };
    row.n++;
    row.projectedStarterPpg += optimalLineup(t.roster, players, (p) => p.basePpg).reduce(
      (sum, id) => sum + (id ? players.get(id).basePpg : 0),
      0,
    );
    const picks = s.picks.filter((x) => x.team === t.id);
    row.first4RB += picks.slice(0, 4).filter((x) => players.get(x.player).position === 'RB').length;
    row.first4WR += picks.slice(0, 4).filter((x) => players.get(x.player).position === 'WR').length;
    row.reach +=
      picks.reduce((sum, x) => sum + Math.max(0, players.get(x.player).adp - x.pick), 0) / 14;
    profiles[t.profile.plan] = row;
  }
  if (i < summary.seasons) {
    while (s.phase === 'season') {
      applyAction(s, { type: 'optimize' }, catalog, players, privateData.worlds[s.world]);
      applyAction(s, { type: 'advance' }, catalog, players, privateData.worlds[s.world]);
      summary.weeklyAdvances++;
    }
    assertLeague(s, players);
    for (const t of s.teams.filter((t) => t.profile)) {
      const row = profiles[t.profile.plan];
      row.wins += t.wins;
      row.champions += Number(t.id === s.champion);
      row.seasons++;
    }
  }
  if ((i + 1) % 40 === 0) console.log(`Playtest: ${i + 1}/${summary.drafts} drafts`);
}
for (const [key, row] of Object.entries(profiles))
  summary.byProfile[key] = {
    style: row.style,
    skill: row.skill,
    meanProjectedStarterPpg: row.projectedStarterPpg / row.n,
    meanFirst4RB: row.first4RB / row.n,
    meanFirst4WR: row.first4WR / row.n,
    meanReachPicks: row.reach / row.n,
    meanRegularSeasonWins: row.wins / row.seasons,
    championships: row.champions,
  };
const all = Object.values(summary.byProfile),
  mean = (rows) => rows.reduce((sum, r) => sum + r.meanProjectedStarterPpg, 0) / rows.length;
summary.disciplinedMeanProjectedStarterPpg = mean(all.filter((r) => r.skill >= 0.8));
summary.unpredictableMeanProjectedStarterPpg = mean(all.filter((r) => r.skill < 0.5));
summary.checks = {
  disciplinedPublicRosterQualityHigher:
    summary.disciplinedMeanProjectedStarterPpg > summary.unpredictableMeanProjectedStarterPpg,
  zeroRBFewerEarlyRB: summary.byProfile.zero.meanFirst4RB < summary.byProfile.running.meanFirst4RB,
  zeroRBMoreEarlyWR: summary.byProfile.zero.meanFirst4WR > summary.byProfile.running.meanFirst4WR,
  wildcardsReachMore:
    summary.byProfile.wildcard.meanReachPicks > summary.byProfile.value.meanReachPicks,
};
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/game_playtest.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
if (!Object.values(summary.checks).every(Boolean)) process.exitCode = 1;
