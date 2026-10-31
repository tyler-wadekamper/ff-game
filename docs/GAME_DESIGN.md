# Fourth & Forever: initial playable game

The game is a browser-first, phone-friendly single-player fantasy football simulator. A user drafts against eleven managers, sets lineups, makes waiver decisions and plays through the season at their own pace. Player identities are fictional; football clubs and fantasy franchises use NFL city markets and abbreviations, without mascots. The existing empirical player histories, ADP and weekly generator supply the actual player universe.

## Platform and revenue decision

Ship the responsive browser game first, with an installable PWA shell. This gives a small niche game one link to share, immediate play without an app-store install, one desktop/mobile codebase and a direct web-payment path. A draft board benefits from desktop width; lineup and waiver decisions work naturally on a phone. The same product can be packaged for app stores later if retention and demand warrant it.

The initial revenue hypothesis is **one free demo season followed by a $9.99 permanent full-game unlock**, with optional future challenge/expansion packs. Test a $6.99–$14.99 range after measuring season completion, repeat play and acquisition cost. A subscription needs sustained additional value; neither subscription revenue nor native-app discovery is assumed for this prototype. No paid advantages or real-money contests are proposed. There is no checkout, paywall or billing SDK in this implementation: the complete prototype is playable without payment.

This is a product judgment about a low-friction, economical first release, **not evidence that web will necessarily earn more than native**. No representative acquisition, conversion or revenue data exists for this game yet. Mobile packaging is a later distribution option, not a separate engine rewrite. MDN documents cross-platform installation and its browser limitations; RevenueCat's first-party web SDK demonstrates an available Stripe-backed web subscription/entitlement path, rather than proving conversion or profitability.

## League rules

- Twelve fantasy teams; user chooses one of twelve draft positions. Every team drafts sixteen players in a snake draft.
- Eight starters: QB, RB, RB, WR, WR, TE, FLEX, FLEX. FLEX accepts RB/WR/TE. Eight bench spots; no K/DST.
- Full PPR, four-point passing TDs, -2 interceptions/lost offensive fumbles, .04 passing yards, .1 rushing/receiving yards. Return and two-point bonuses are excluded, matching the research generator.
- Eighteen NFL calendar weeks, with one bye shared by every member of an anonymous schedule club. Published availability applies to the current week only. OUT means unavailable, without inventing a medical diagnosis. Participating players can still score zero or negative points.
- Fantasy regular season runs Weeks 1–14. The top six qualify. Seeds 1–2 have a quarterfinal bye in Week 15, semifinals reseed in Week 16, and the title is decided in Week 17. Noncontenders play placement games. Week 18 is an explicitly labeled exhibition victory lap; it cannot change the champion or regular-season standings.
- Regular-season ties count as ties. Standings use record, then points for, then draft slot. Playoff ties advance the higher regular-season seed.

## Research and the opponent model

The sources below motivate familiar strategy types; they are **not a fitted population study of human managers**. Exact preferences, skill settings and noise levels are game-design parameters. Source code was written for this game; no third-party strategy implementation is imported.

1. [Value Based Drafting explanation and package](https://github.com/famendola1/VBD-Package): position-relative value, replacement baselines, and the limitations of ignoring ADP and roster balance.
2. [Expected-value draft assistant](https://github.com/rcostanzo/fantasy-football-drafter): compare positional drop-offs before the next snake pick.
3. [Zero RB analysis](https://github.com/nattydeacs/ZeroRB_strategy): compares WR-first/Zero RB and standard draft constructions. Its historical files are not imported into this game and are not treated as evidence that one approach always wins.
4. [Fantasy Football Analytics](https://github.com/FantasyFootballAnalytics/ffanalytics): separates projections, scoring, rankings, ADP and uncertainty.
5. [FAAB research implementation](https://github.com/jordanbui23/fantasy-faab): roster holes, remaining budgets, recency, current availability and the difference between a projected opportunity and last week's touchdown luck.
6. [Sleeper-based FAAB tool](https://github.com/bemky/opfor): distinguishes sealed-bid waivers from free agents and validates targets, ownership and budget. Its guillotine-league objective is not used here.
7. [MDN PWA overview](https://github.com/mdn/content/blob/main/files/en-us/web/progressive_web_apps/index.md) and [installability guide](https://github.com/mdn/content/blob/main/files/en-us/web/progressive_web_apps/guides/making_pwas_installable/index.md): responsive distribution, manifest, icons, HTTPS and platform-specific installation limits.
8. [RevenueCat web SDK](https://github.com/RevenueCat/purchases-js): first-party documentation of web billing and cross-platform entitlements. No SDK or account is configured for this prototype.

The eleven managers use value analysis, tier drop-offs, Hero RB, Zero RB, early QB, premium TE, youth/upside, RB depth, nostalgia, casual ADP following and unpredictable reaches. Profiles are shuffled across draft slots in each league. Even weak managers must finish legal rosters. They are fallible rather than deliberately nonfunctional.

The core draft utility is:

```text
utility = -log(ADP)
        + skill * .06 * (visible estimated PPG - positional replacement PPG)
        + roster need and strategy preferences
        - redundant QB/TE and excessive depth penalties
        + noise_scale * Gumbel randomness
```

The tier drafter adds a bonus when a position's alternatives drop off. Hero RB emphasizes one early RB, then receivers through Round 5. Zero RB strongly discounts RB through Round 4. Needs become more urgent as the draft progresses. Feasibility checks prevent the last picks from leaving a mandatory position unfilled. Queue auto-picks also obey these constraints.

The public preseason estimate combines the last three visible per-game histories with .6/.3/.1 weights, adjusted mildly for past participation. In-season estimates blend this baseline with the last four played games; the observed weight rises to at most .65. These estimates are intentionally imperfect scouting aids, not the hidden season result. Managers can only use this public history, completed weeks and current availability. No manager receives future points, future availability or the private world in the draft decision function.

Managers optimize their weekly lineup with skill-dependent judgment noise. This optimizer is exact for the current slot structure: fill the disjoint position minimums with their best players, then take the two best remaining eligible FLEX players. Tests compare an overlapping-slot case with exhaustive enumeration. A user can manually select starters, promote bench players, or request the same public-information optimizer.

## Waivers

Every team starts with $100 FAAB. During an open waiver window, a user submits a target, drop and whole-dollar bid. The engine generates independent bot claims from visible roster improvement, current holes, recent production, budget and personality. Weaker managers overreact more to a recent big game and are less consistently attentive.

The batch sorts highest bid first, then worse standings, then inverse draft order. A winning claim atomically transfers ownership, validates the drop and deducts the bid. Losers pay nothing. Multiple claims can share a drop as alternatives, and can overcommit the nominal balance; each is revalidated when reached, so actual spending cannot exceed the remaining budget. The UI explicitly states that higher bids process first. This is a simplified once-weekly batch, not a claim of exact Sleeper scheduling or configurable claim-priority semantics.

Waivers run manually or automatically before kickoff, once per week. Week 1 pickups are free; after the weekly run, unclaimed players are $0 free agents. Dropped players are unavailable until the next scoring week to prevent immediate recycling. Bots act in the shared waiver batch. There is no human-versus-bot reaction-time race.

## Data and fairness boundary

`ffsim.game_export` packages all 972 initial players and twelve complete weekly worlds, chosen reproducibly from the existing 100-season ensemble. These worlds contain **11,664 player calendars / 209,952 weekly rows**. Every integer season statistic and PPR total is reconciled during export. NFL downloads and scientific Python are needed to rebuild the package, not to run the packaged Node game.

The public catalog contains fictional names, histories, age, anonymous club, known bye, ADP and a public scouting estimate. The server privately loads `worlds.json.gz`, chooses one world per league, and exposes only completed-week results and current-week availability. None of the raw private world files, server files or save files has an HTTP route. A player-detail endpoint returns completed weeks only. Outcomes are never used by the draft valuation function, and changing hidden points without changing current availability cannot change lineup optimization.

Each new universe remixes one whole empirical source pool, with history-only role matching, bounded 8% whole-vector variation and shuffled played-game blocks. A compiled historical-neighbor market model reprices the new histories. The 972-player position counts and NFL-sized outcome budgets are preserved. Continue-universe mode carries completed seasons into history, ages retained players and introduces rookies through a declared turnover rule; fantasy rosters redraft each year. Resume opens the current saved season without advancing or regenerating it. The browser and server use the same generator. See [the experience evidence](../reports/GAME_EXPERIENCE.md) for distribution regression and limitations.

## Persistence and deployment

A Node 22+ server hosts the entire game; there are no runtime npm dependencies. Anonymous leagues have opaque bearer recovery keys, automatic atomic disk saves, and revision checks that prevent duplicate concurrent actions. The browser keeps a resume key; recovery files allow another browser on the same server to resume the franchise. Saves survive server restarts. Bot claims remain private until processing.

The PWA includes a manifest, 192/512 icons and a network-first application shell. **Gameplay requires a connection to this server**; offline status explains that moves cannot be submitted. Serve over HTTPS in production for PWA installation. Use a persistent volume for `game/saves/`. This is a single-process prototype; shared database storage and account recovery are needed before running multiple replicas or collecting payments.

## Reproduce

```sh
npm ci
npm start                  # http://localhost:3000, or PORT=... npm start
npm test                   # engine + HTTP tests
npm run validate:game      # 240 drafts, 120 complete seasons
npm run test:browser       # Playwright; system Chromium or CHROMIUM_PATH required
```

To repackage the empirical player pool after rerunning the research pipeline:

```sh
npm run data:game
```

The packaged data is committed for immediate play. Live save files are ignored by Git. The browser test creates temporary leagues and removes them afterward. See [the executed playtest report](../reports/GAME_PLAYTEST.md) for measured behavior and screenshots.
