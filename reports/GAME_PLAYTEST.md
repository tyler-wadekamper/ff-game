# Fourth & Forever: executed gameplay evidence

Run `npm ci` then `npm start`, and open http://localhost:3000. The browser game supports desktop and phones; it has an installable PWA shell. The Node edition requires the server; the published browser edition runs locally and supports offline play.

[Rules, strategy research, platform/revenue decision and architecture](../docs/GAME_DESIGN.md)

## What is playable

A 168-pick, twelve-team snake draft with queue, manual picks, auto-picks and a complete draft board. Eleven managers have distinct strategies and skill/noise settings. Eight starting slots, six bench spots and two IR slots can be managed manually. Weekly play locks lineups, scores all matchups, updates standings, processes contested $100 FAAB waivers, runs the six-team playoffs and records a champion. Week 18 is an exhibition. Saves survive reloads and server restarts; recovery files resume on the same server.

![Draft room](game_draft_desktop.png)

![Weekly lineup and matchup](game_lineup_desktop.png)

## Validation that actually ran

- **240 complete drafts / 40,320 selections.** Every roster completed legally, with no duplicate ownership.
- **120 complete seasons / 2,160 advances.** All ran through Week 18 with legal rosters, nonnegative budgets, playoffs and a champion.
- **42 Node tests** cover the engine and HTTP behavior: all draft slots, positional legality, exact cent scoring, locked snapshots, bids/ties/overcommitment, dropped-player cooldown, deterministic resume, playoff byes/reseeding/ties, save persistence, authentication and concurrent stale revisions.
- **A full browser season** exercised queue/manual/auto drafting, profiles, lineup swaps, waivers with a $100 winning bid, mobile navigation, reload/resume, all 18 advances, standings and the championship. No JavaScript or HTTP errors were observed.
- **12 packaged football worlds / 11,664 player calendars / 209,952 weekly rows.** Export reconciled every player to its generated season totals; tests independently verify weekly PPR accounting and bye/nonparticipation zeros.
- Future results, private worlds, server files and saved league files have no public HTTP route. Draft choices remain identical when the hidden world changes. Lineup choices remain identical when hidden points change but published availability does not.

## Are the opponents different, and does skill matter?

The table reports repeated game simulations, not observed human-manager frequencies or evidence of a universally optimal fantasy strategy. The human slot was also auto-managed for these comparisons, and rotated across draft positions. These are descriptive averages across the twelve packaged football worlds; they are not confidence intervals.

| style | meanFirst4RB | meanFirst4WR | meanProjectedStarterPpg | meanReachPicks | meanRegularSeasonWins | championships |
| --- | --- | --- | --- | --- | --- | --- |
| Value analyst | 2.35 | 1.20 | 116.90 | 9.50 | 8.52 | 26 |
| Tier drafter | 2.08 | 1.28 | 118.85 | 9.55 | 7.99 | 14 |
| Hero RB | 1 | 2.86 | 114.13 | 14.65 | 7.72 | 13 |
| Zero RB | 0 | 3.75 | 113.70 | 16.55 | 7.56 | 13 |
| Early QB | 1.74 | 1.04 | 111.31 | 23.04 | 7.52 | 9 |
| Upside hunter | 2.24 | 1.30 | 110.62 | 20.04 | 7.35 | 11 |
| Elite TE | 1.89 | 1.00 | 113.36 | 18.02 | 7.03 | 11 |
| RB heavy | 3.19 | 0.59 | 108.49 | 24.23 | 6.62 | 6 |
| Nostalgist | 1.73 | 1.46 | 106.41 | 36.53 | 6.04 | 4 |
| Casual contender | 1.82 | 1.46 | 106.11 | 32.58 | 5.72 | 3 |
| Big reach energy | 1.57 | 1.55 | 100.47 | 41.37 | 5.43 | 2 |

The Hero RB manager averages about one RB in its first four picks; the Zero RB manager nearly always delays RB beyond those rounds. The RB-heavy manager averages more than three early RBs. Wildcards reach farther down the ADP board than disciplined value managers. Stronger managers build better publicly estimated starting lineups on average, while the weaker styles still win some championships. No winner is scripted.

![Opponent strategy and results](game_bot_validation.png)

## Mobile and limits

![Mobile waiver wire](game_waivers_mobile.png)

The browser edition now remixes these twelve empirical source worlds into fresh universes and can carry player histories into subsequent seasons. See [the new experience report](GAME_EXPERIENCE.md) for profiles, IR, recap scorecards and distribution regression. Billing, trades and shared-team play-by-play remain outside this prototype. Medical story labels and turnover rules are game-design choices. It retains the documented ADP source-format, positional-margin and rare weekly-tail biases from the research model. Manager preferences and noise are game-design choices, not calibrated human behavior.

[Playtest JSON](game_playtest.json) · [Bot metrics CSV](game_bot_metrics.csv) · [Browser checks](game_browser_checks.json) · [World export checks](game_data_checks.json)
