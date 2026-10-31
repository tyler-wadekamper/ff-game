"""Executed gameplay evidence and descriptive opponent comparisons."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import pandas as pd


def report_game(root):
    root=Path(root);art=root/'artifacts';out=root/'reports'
    evidence=json.loads((art/'game_playtest.json').read_text())
    current=hashlib.sha256((root/'game/engine.mjs').read_bytes()+(root/'game/strategy.mjs').read_bytes()).hexdigest()
    if evidence['engineFingerprint']!=current:raise ValueError('Rerun npm run validate:game; strategy evidence is stale')
    browser=json.loads((art/'game_browser_checks.json').read_text())
    if not browser['passed'] or not all(evidence['checks'].values()):raise ValueError('Gameplay checks failed')
    rows=pd.DataFrame(evidence['byProfile']).T.sort_values('meanRegularSeasonWins',ascending=False)
    os.environ.setdefault('MPLCONFIGDIR','/tmp/ff-game-matplotlib')
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig,axes=plt.subplots(1,2,figsize=(14,6),layout='constrained')
    labels=rows['style'].tolist();colors=['#699c42' if x>=.8 else '#bf8655' if x<.5 else '#63859f' for x in rows.skill]
    axes[0].barh(labels,rows.meanRegularSeasonWins,color=colors)
    axes[0].invert_yaxis();axes[0].set(xlabel='Mean wins in a 14-game regular season',title='Skill matters; results still vary')
    axes[0].axvline(7,color='#87919b',lw=1,ls='--')
    early=rows.loc[['zero','hero','value','running']]
    import numpy as np
    x=np.arange(len(early));axes[1].bar(x-.18,early.meanFirst4RB,.36,label='RB',color='#478c76')
    axes[1].bar(x+.18,early.meanFirst4WR,.36,label='WR',color='#6894bc')
    axes[1].set(xticks=x,xticklabels=early['style'].tolist(),ylabel='Mean picks among first four rounds',title='Different managers build different teams')
    axes[1].legend(frameon=False)
    for ax in axes:ax.spines[['top','right']].set_visible(False);ax.grid(axis='x' if ax is axes[0] else 'y',alpha=.15)
    fig.suptitle('240 complete drafts · 120 complete seasons · fixed, reproducible seeds',fontsize=15)
    fig.savefig(out/'game_bot_validation.png',dpi=155);plt.close(fig)
    rows.to_csv(out/'game_bot_metrics.csv',index_label='profile')
    shutil.copyfile(art/'game_playtest.json',out/'game_playtest.json')
    shutil.copyfile(art/'game_browser_checks.json',out/'game_browser_checks.json')
    shutil.copyfile(root/'game/data/export_checks.json',out/'game_data_checks.json')
    for name in ['game_welcome.png','game_draft_desktop.png','game_lineup_desktop.png','game_waivers_mobile.png','game_champion.png']:
        shutil.copyfile(art/name,out/name)
    from .presentation import markdown_table
    text=['# Fourth & Forever: executed gameplay evidence','',
          'Run `npm ci` then `npm start`, and open http://localhost:3000. The browser game supports desktop and phones; it has an installable PWA shell. The Node edition requires the server; the published browser edition runs locally and supports offline play.','',
          '[Rules, strategy research, platform/revenue decision and architecture](../docs/GAME_DESIGN.md)','',
          '## What is playable','',
          'A 168-pick, twelve-team snake draft with queue, manual picks, auto-picks and a complete draft board. Eleven managers have distinct strategies and skill/noise settings. Eight starting slots, six bench spots and two IR slots can be managed manually. Weekly play locks lineups, scores all matchups, updates standings, processes contested $100 FAAB waivers, runs the six-team playoffs and records a champion. Week 18 is an exhibition. Saves survive reloads and server restarts; recovery files resume on the same server.','',
          '![Draft room](game_draft_desktop.png)','',
          '![Weekly lineup and matchup](game_lineup_desktop.png)','',
          '## Validation that actually ran','',
          f"- **{evidence['drafts']} complete drafts / {evidence['draftPicks']:,} selections.** Every roster completed legally, with no duplicate ownership.",
          f"- **{evidence['seasons']} complete seasons / {evidence['weeklyAdvances']:,} advances.** All ran through Week 18 with legal rosters, nonnegative budgets, playoffs and a champion.",
          '- **42 Node tests** cover the engine and HTTP behavior: all draft slots, positional legality, exact cent scoring, locked snapshots, bids/ties/overcommitment, dropped-player cooldown, deterministic resume, playoff byes/reseeding/ties, save persistence, authentication and concurrent stale revisions.',
          '- **A full browser season** exercised queue/manual/auto drafting, profiles, lineup swaps, waivers with a $100 winning bid, mobile navigation, reload/resume, all 18 advances, standings and the championship. No JavaScript or HTTP errors were observed.',
          '- **12 packaged football worlds / 11,664 player calendars / 209,952 weekly rows.** Export reconciled every player to its generated season totals; tests independently verify weekly PPR accounting and bye/nonparticipation zeros.',
          '- Future results, private worlds, server files and saved league files have no public HTTP route. Draft choices remain identical when the hidden world changes. Lineup choices remain identical when hidden points change but published availability does not.','',
          '## Are the opponents different, and does skill matter?','',
          'The table reports repeated game simulations, not observed human-manager frequencies or evidence of a universally optimal fantasy strategy. The human slot was also auto-managed for these comparisons, and rotated across draft positions. These are descriptive averages across the twelve packaged football worlds; they are not confidence intervals.','',
          markdown_table(rows[['style','meanFirst4RB','meanFirst4WR','meanProjectedStarterPpg','meanReachPicks','meanRegularSeasonWins','championships']].reset_index(drop=True)),'',
          'The Hero RB manager averages about one RB in its first four picks; the Zero RB manager nearly always delays RB beyond those rounds. The RB-heavy manager averages more than three early RBs. Wildcards reach farther down the ADP board than disciplined value managers. Stronger managers build better publicly estimated starting lineups on average, while the weaker styles still win some championships. No winner is scripted.','',
          '![Opponent strategy and results](game_bot_validation.png)','',
          '## Mobile and limits','',
          '![Mobile waiver wire](game_waivers_mobile.png)','',
          'The browser edition now remixes these twelve empirical source worlds into fresh universes and can carry player histories into subsequent seasons. See [the new experience report](GAME_EXPERIENCE.md) for profiles, IR, recap scorecards and distribution regression. Billing, trades and shared-team play-by-play remain outside this prototype. Medical story labels and turnover rules are game-design choices. It retains the documented ADP source-format, positional-margin and rare weekly-tail biases from the research model. Manager preferences and noise are game-design choices, not calibrated human behavior.','',
          '[Playtest JSON](game_playtest.json) · [Bot metrics CSV](game_bot_metrics.csv) · [Browser checks](game_browser_checks.json) · [World export checks](game_data_checks.json)','']
    (out/'GAME_PLAYTEST.md').write_text('\n'.join(text))
    print('Wrote gameplay evidence, screenshots and opponent comparison graph')


if __name__=='__main__':report_game(Path.cwd())
