# Fantasy football player-model research

## Play the game

**[Play Fourth & Forever in your browser](https://tyler-wadekamper.github.io/ff-game/)** — press **Start a season** to enter the draft immediately. The repository root includes the runnable browser build so GitHub Pages opens the game directly.

For free public hosting, use the [browser edition and GitHub Pages publisher](docs/FREE_HOSTING.md). It runs the same game entirely on the player's device, supports offline play and full backup export/import. The Node server below remains available for server-owned saves and private outcomes.

**Fourth & Forever** is now a playable browser game built on this player model. Draft against eleven different managers, set your lineup, compete for an eighteen-week season, bid on waivers and chase the championship. The layout supports desktop and phones, with an installable PWA shell.

```sh
npm ci
npm start
# Open http://localhost:3000 (or set PORT for another port).
```

Node 22+ is sufficient to play. The fictional catalog and twelve private, pre-generated football worlds are packaged in `game/data/`; no NFL download, Python process or third-party API is needed at runtime. Saves persist in `game/saves/`. Keep that directory on persistent storage when hosting. Recovery files resume a league on the same server; the game requires a network connection to that server.

[Gameplay evidence and screenshots](reports/GAME_PLAYTEST.md) · [Rules, draft-strategy research and platform/revenue decision](docs/GAME_DESIGN.md)

```sh
npm test                    # 30 engine and HTTP checks
npm run validate:game       # 240 drafts and 120 complete seasons
npm run test:browser        # Complete browser season; Chromium required
npm run data:game           # Repackage after rebuilding the research data
.venv/bin/python -m ffsim.game_report  # Refresh gameplay evidence after playtests
```

Browser tests use the pinned Playwright dev dependency and `/usr/bin/chromium`; set `CHROMIUM_PATH` for another Chromium installation. `npm run dev` watches server code during development. The application is a single-process prototype with automatic disk saves, not a deployed payment product. The browser-first revenue hypothesis is a free demo followed by a permanent unlock; billing is not connected.

## Player-model research

A reproducible Python pipeline for the initial player-database experiment. It downloads free nflverse release CSVs for **2015–2025**, constructs a player-season panel, summarizes position-specific parameters, tests an empirical next-season simulator, and generates anonymous fictional careers.

Start with the [standalone interactive Season Explorer](reports/SEASON_EXPLORER.html), or read [the evidence report](reports/MODEL_REPORT.md). The goal is realistic game seasons given histories, not predicting the next real NFL season.

The [Draft & Weekly Lab](reports/DRAFT_WEEKLY_EXPLORER.html) adds a complete history-based draft board, historical market comparables, and two weekly paths for each of three alternative seasons for every initial player. See [the ADP/weekly evidence report](reports/DRAFT_WEEKLY_REPORT.md) for methods, observed errors and acceptance checks.

## Run

Python 3.11+ is required. On a clean machine:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -e .
.venv/bin/ff-data all
.venv/bin/python -m unittest discover -s tests -v
```

The initial download is approximately 140 MB and uses four concurrent HTTPS requests, TLS verification, atomic file writes and bounded retries. Repeated runs verify cached files against the recorded hashes. Use `ff-data download --refresh` to intentionally replace the cache with current upstream versions. These hashes record retrieved content; they do not authenticate upstream releases independently of HTTPS.

Commands can also run independently:

```sh
.venv/bin/ff-data download
.venv/bin/ff-data build
.venv/bin/ff-data analyze
.venv/bin/ff-data calibrate
.venv/bin/ff-data validate --draws 256
.venv/bin/ff-data generate --seasons 100
.venv/bin/ff-data audit-game --audit-seasons 64
.venv/bin/ff-data report
.venv/bin/ff-data download-adp
.venv/bin/ff-data draft-weekly --weekly-draws 20
```

After the first download, these run offline against the cached files, including `all`. If using the preinstalled scientific Python environment without installing the package, use `PYTHONPATH=src python3 -m ffsim.cli all`.

## Data

The downloader uses the same public release URL patterns as the official [nflreadr loaders](https://github.com/nflverse/nflreadr/tree/main/R):

- `stats_player/stats_player_week_{season}.csv`: weekly box-score statistics, retained in full in the raw cache.
- `rosters/roster_{season}.csv`: annual rosters, including players with no recorded offensive production.
- `snap_counts/snap_counts_{season}.csv`: participation and offensive snaps, sourced upstream from Pro Football Reference.
- `injuries/injuries_{season}.csv`: weekly practice/game injury reports.
- `players/players.csv`: identifiers, birth dates, and career metadata.

Only regular seasons feed the model. QB/RB/WR/TE are included, with FB/HB grouped into RB. Birth dates are evaluated at September 1 of each season. Same-player traded-team rows are combined, not counted as separate players. Older 16-game seasons are normalized to 17 games in transition fitting/evaluation; raw descriptive totals retain their original season lengths.

`data/raw/manifest.json` records source URLs, retrieval timestamps and SHA-256 checksums. `data/processed/coverage.json` records seasons, team/week presence, missing ages and ID-join gaps. Partial or missing injury coverage remains an explicit limitation; unlisted does not mean healthy. Annual rosters are not a complete historical transaction ledger.

Free access does not itself establish commercial redistribution rights. Review the nflverse assets and underlying providers' applicable terms/attribution before distributing source data with the game. No third-party raw data is added to Git.

## Distribution-first game model

The current engine allocates **complete modern-NFL outcome pools**, rather than independently extrapolating every player's statistics. This prevents a league from accidentally acquiring too many elite seasons, empty roles, or extreme workloads.

1. Generate an NFL-sized starting population using connected 2015–2025 career segments and a persistent 10% peer-trait perturbation. Preserve histories, position, age, workload style and recorded participation. For depth templates with missing birth dates, generate an age from position/role peers, constrained by visible career length.
2. Draw one empirical 17-game-era outcome pool from 2021–2025. All earlier seasons still inform histories and comparisons. Include the complete incoming cohort and next-roster status.
3. Use stochastic one-to-one matching between fictional current histories and historical predecessor states. Matching sees **only predecessor information**, never how good its successor will be.
4. Transfer the complete matched successor stat vector. Add 25% within-season game-bootstrap variation to create novel lines without unconstrained extrapolation. Enforce individual event accounting.

The matching cost is:

```text
cost(i,j) = squared standardized feature distance
          + 12 * (current_role_i - predecessor_role_j)^2
          + 4 * ((sustained_PPG_i - sustained_PPG_j) / position_scale)^2
          - Gumbel_randomness
```

`sustained_PPG = 0.6 * current_PPG + 0.4 * trailing_history_PPG`. Role and sustained production prevent a young starter from inheriting a backup's trajectory purely because their ages match. Historical demotions, injuries, exits and breakouts remain possible through the matched successor. An assignment solver preserves scarce league-wide opportunity supply.

The conditional kernel and game-bootstrap settings were selected on 2019–2022 development folds using distribution distances, with zero-jitter copying retained only as an ablation. Role penalties, matching temperature, history perturbation and score display rules are explicit game-design choices. Population distribution fidelity is **a construction constraint**, not an independent discovery or a claim that every underlying causal parameter has been estimated.

Game-facing files contain fictional IDs, no NFL names/teams/GSIS IDs. This is not formal anonymization: historical shapes may remain recognizable. The engine does not yet fit medical injury hazards, simulate shared team play-by-play, run a fantasy draft, or validate multi-decade career progression.

## Reliability and the 0–100 index

- Simulate 100 complete alternative seasons from one fixed fictional population, including entry cohorts.
- Compare real and generated rank curves, raw opportunity budgets, rostered zero-production rates, individual variance, positive-line novelty and independent seed batches.
- Check that history changes conditional distributions, realized rank persistence and bust/breakout frequencies against historical annual variation. Explicit gates and limits are retained in `realism_checks.csv`; the report command fails if they fail.
- Separately replay the complete game against 2023–2025 incumbent histories, fitting only through 2022, with 64 whole-population draws per year. These years were inspected in v1; this is a reused historical audit, not an untouched test set. Discrepancies remain visible.
- Retain the unconstrained conditional-kernel audit as a secondary diagnostic. Forecast MAE is not the optimization goal.
- Software tests cover accounting, one-to-one allocation, reproducibility, future-data leakage, outcome-blind matching, numerical dropouts and identity removal. Engine fingerprints prevent stale ensemble/audit artifacts from being presented together.

The display score is `min(100, max(0, 100 * PPR / fixed_position_reference))`. The reference is the 2015–2022 fantasy-relevant positional P99, fixed before the audit. A score of 50 means half that production, **not** the 50th percentile. Each season uses the same scale; raw PPR is preserved and shown alongside it. It is a production index, not a hidden skill rating. Old history totals retain their original 16/17-game season lengths.

Scoring is full PPR with four-point passing TDs, -2 interceptions/lost offensive fumbles, 1 point per 25 passing yards and 10 rushing/receiving yards; return and two-point bonuses are excluded. This is an explicit research scoring setting.

Injury reports do not establish complete injury-caused absence or individual medical durability. The generator reproduces empirical participation and absence patterns, and distinguishes unrostered exits from rostered zero-production seasons. It does not label all of them as injuries.

## ADP from visible histories

The public [FantasyPros consensus archive](https://github.com/jughkoop/fantasy-football-adps/tree/62009bf51773d37427da4e07c99d90339ff6e152) supplies 2015–2024 ADP. Downloads are pinned to that commit, checksummed, and audited against independent NFL IDs and positions. The archive does **not certify scoring format or league size**. NFL history starts in 2015, so model comparisons start with the 2016 draft. Future-year ADP and generated next-season outcomes are excluded from input features.

For each position, use age, calendar-aligned prior production, volume/style, participation and missed-time history. A gap year is zero production, not a compressed career sequence. Standardized feature distances select weighted historical neighbors:

```text
market_priority(x) = weighted_mean(log(min(eligible_market_rank, 216)))
                    over comparable prior-history states
weight(j) ∝ exp(-distance(x,j)^2 / (2 * local_bandwidth^2))
```

Unlisted players have a censored target at 216; they are not treated as observed late prices. Per-position neighbor counts are selected using 2020–2022, with training through 2019. Ordering is audited on 2023–2024 using training only through 2022; the production model then uses all available market years. Individual rank errors remain visible. Rookie scouting, camp news and current medical news are absent from this history-only model.

The ordering is mapped to historical consensus price spacing. In 1,000 simulated complete preference queues, log priority receives declared game randomness (SD .12/.18/.25 by tier). Each player's ADP is mean full-board rank; selection probability counts the first 192 picks. This gives all players a numeric value, including always-undrafted reserves, whose values are **extrapolated queue ranks**, not measured conditional ADPs. Room ranges are game randomness, not empirical confidence intervals. Twelve teams and sixteen rounds are configurable game assumptions. No fantasy draft or roster-construction strategy is simulated yet.

## Weekly paths conditional on season totals

The calendar has **18 weeks, 17 scheduled games and one bye**. The given games-played total determines additional nonparticipation. Anonymous schedule groups share a bye. NFL box scores and snap participation build independently reconciled single-team templates, including low-usage players. Traded-team calendars are excluded from this template library.

For a known season vector `S`, choose a nearby historical vector by position, participation, opportunity and efficiency. Main workload gets extra weight; when compatible sources exist, productive roles require opportunities/game within a factor of two, preventing a reserve's isolated spike from scaling into an implausible workload. Resample two-game blocks and regularize the joint shape: `shape = λ * template + (1 - λ) * template_mean`. Position-specific λ is fitted on 2021–2022 with templates ending in 2020. Allocate parent opportunities, then child counts within capacities. Rare event rates use `rate_w = (observed_events_w + κ * season_rate) / (observed_opportunities_w + κ)`; bounded multinomial draws condition on exact season event totals. κ is estimated from earlier weekly residual moments. Yardage preserves signed empirical patterns and exact sums. Real lateral and strip-fumble exceptions are supported.

Every generated path satisfies `sum(weekly_stats) = S`, conserves PPR and participation, and has zero production on its bye and nonparticipation weeks. Exact totals make average weekly points automatic. Independent distribution audits therefore examine raw weekly SD, regularized CV, largest/top-three game shares, boom/bust frequency, lag correlation, absence blocks, P95/P99 games and the frequency above 40 PPR. The 2023–2025 audit uses templates through 2022 and excludes every season of the same player. These are reused historical audits, not blind external tests. Full-corpus accounting and the exported calendars are checked separately.

To use the generator directly after a build:

```python
import json, pickle
import numpy as np
from ffsim.model import CORE
from ffsim.weekly import WeeklyModel

# Only load this locally generated, trusted cache; raw CSVs are authoritative.
library = pickle.load(open('artifacts/weekly_library.pkl', 'rb'))
config = json.load(open('artifacts/weekly_config.json'))
model = WeeklyModel(library, cutoff=2025, shape_retention=config['shape_retention'])
# season is a dict containing integer counts/yards and games (0..17).
weekly, _ = model.generate([season[c] for c in CORE], 'WR', bye=9,
                           rng=np.random.default_rng(123))
assert weekly.shape == (18, len(CORE))
```

`generated_adp.csv` and `player_database_with_adp.json` cover the starting pool. `weekly_results.csv.gz` contains two paths for each of three full league outcomes, including entry cohorts. The standalone explorer embeds every initial player's histories and six calendars; research comparables with real names are confined to the report. Shared team play-by-play, opponent defenses, weather and causal medical injuries remain outside this weekly model.

The optional UI smoke test uses Playwright and a system Chromium: `node tests/check_draft_weekly.cjs`. Python tests run with the command above. `ff-data draft-weekly` rebuilds calibration, historical audits, full-corpus accounting, exports and reports, and fails when acceptance checks fail.

## Files

```text
src/ffsim/download.py    Public downloads, provenance and cache verification
src/ffsim/data.py        ID joins, regular-season panel and successor records
src/ffsim/analysis.py    Parameter summaries, priors, transitions and real examples
src/ffsim/model.py       Conditional joint simulator
src/ffsim/calibrate.py   Earlier-year distributional development folds
src/ffsim/league.py      Complete population allocation and fictional histories
src/ffsim/evaluate.py    Secondary conditional-kernel historical audit
src/ffsim/game_audit.py  Complete-game historical audit
src/ffsim/reliability.py Statistical game-realism gates
src/ffsim/presentation.py Standalone explorer, graphs and evidence report
src/ffsim/draft_data.py   Pinned ADP archive, identity repairs and coverage
src/ffsim/adp.py          History-only comparables, draft queues and market audits
src/ffsim/weekly.py       Exact-total conditional weekly paths
src/ffsim/weekly_validation.py Temporal distribution and corpus accounting audits
src/ffsim/draft_weekly.py Game-facing draft and weekly exports
src/ffsim/draft_weekly_report.py Offline draft/weekly explorer and evidence charts
tests/                  Accounting and leakage/coverage checks
reports/                Executed results retained for review
```

Large raw/processed data and full ensembles are ignored. Reports retain compact evidence, a full fictional player database, 12 inspectable examples, and the first three complete seasons. V1 evidence is archived under `reports/archive/v1`. Random seed: `20261030`.
