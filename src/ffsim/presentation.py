"""Standalone visual evidence: rank distributions and inspectable careers."""
from __future__ import annotations

import base64
import html
import json
import os
from pathlib import Path
import shutil
import numpy as np
import pandas as pd

from .league import season_index


def markdown_table(frame):
    def fmt(x):
        return f'{x:.2f}' if isinstance(x,(float,np.floating)) else str(x)
    return '\n'.join(['| '+' | '.join(frame.columns)+' |','| '+' | '.join(['---']*len(frame.columns))+' |']+
                     ['| '+' | '.join(fmt(x) for x in row)+' |' for row in frame.itertuples(index=False,name=None)])


def present(root):
    root=Path(root);out=root/'artifacts';reports=root/'reports';reports.mkdir(exist_ok=True)
    os.environ.setdefault('MPLCONFIGDIR','/tmp/ff-game-matplotlib')
    os.environ.setdefault('XDG_CACHE_HOME','/tmp/ff-game-cache')
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    plt.rcParams.update({'font.size':10,'axes.spines.top':False,'axes.spines.right':False})
    showcase=json.loads((out/'showcase_players.json').read_text())
    metadata=json.loads((out/'balanced_audit_metadata.json').read_text())
    if metadata['engine_fingerprint']!=showcase['engine_fingerprint']:
        raise ValueError('Game audit and generated population use different engine versions; rerun ff-data audit-game')
    curves=json.loads((out/'rank_curves.json').read_text())
    metrics=pd.read_csv(out/'game_realism_metrics.csv')
    checks=pd.read_csv(out/'realism_checks.csv')
    panel=pd.read_csv(root/'data/processed/player_seasons.csv')
    scales=showcase['scales'];positions=['QB','RB','WR','TE'];colors=['#2676b8','#df8b20','#369273']
    for mode in ['score','ppr']:
        fig,axes=plt.subplots(2,2,figsize=(13,8),layout='constrained')
        for ax,pos in zip(axes.flat,positions):
            real=np.array(curves[pos]['real']);generated=np.array(curves[pos]['generated']);ranks=np.arange(1,101)
            if mode=='score':
                real=season_index(real,pos,scales);generated=season_index(generated,pos,scales)
            ax.fill_between(ranks,real.min(axis=0),real.max(axis=0),color='#dfe4eb',label='Historical annual range, 2021–25')
            ax.plot(ranks,real.mean(axis=0),color='#263345',lw=2.8,label='Historical mean by rank')
            for i in range(3):ax.plot(ranks,generated[i],color=colors[i],lw=1.7,alpha=.9,label=f'Generated season {i+1}')
            ax.set(title=f'{pos}: entire position pool',xlabel='Player rank within position',ylabel='Season production index (0–100)' if mode=='score' else 'Season PPR points')
            ax.set_xlim(1,100);ax.set_ylim(bottom=0 if mode=='score' else min(0,float(real.min()),float(generated.min())))
            if mode=='score':ax.set_ylim(0,103)
            ax.grid(alpha=.16)
        axes.flat[0].legend(fontsize=8,frameon=False)
        fig.suptitle('Three alternative complete seasons from the same fictional histories',fontsize=15)
        fig.savefig(reports/f'position_distributions_{mode}.png',dpi=160);plt.close(fig)

    for mode in ['score','ppr']:
        fig,axes=plt.subplots(4,3,figsize=(15,13),layout='constrained')
        for ax,p in zip(axes.flat,showcase['players']):
            history=p['history'];ages=[h['age'] for h in history];values=[h[mode] for h in history]
            ax.plot(ages,values,'o-',color='#263345',lw=1.5,ms=3,label='Fictional history')
            end=ages[-1]
            for k,a in enumerate(p['alternatives']):
                ax.plot([end,end+1],[values[-1],a[mode]],color=colors[k],ls='--',lw=1,alpha=.7)
                ax.scatter(end+1+(k-1)*.09,a[mode],s=35,color=colors[k],zorder=3,label=f'Alternative {k+1}')
            ax.axvline(end+.5,color='#c7cfd9',ls=':')
            ax.set(title=f"{p['id']} · current age {p['age']}",xlabel='Age',ylabel='Production index' if mode=='score' else 'PPR points')
            ax.set_ylim(bottom=0 if mode=='score' else min([0]+values+[a[mode] for a in p['alternatives']])*1.1)
            if mode=='score':ax.set_ylim(0,105)
            ax.grid(alpha=.15)
        axes[0,0].legend(fontsize=7,frameon=False)
        fig.suptitle('Persistent histories; three different upcoming seasons (not consecutive years)',fontsize=15)
        fig.savefig(reports/f'player_histories_{mode}.png',dpi=150);plt.close(fig)

    # Conditional game distributions: history must matter despite population budgets.
    conditional=pd.read_csv(out/'conditional_history_metrics.csv')
    fig,axes=plt.subplots(1,4,figsize=(14,4),layout='constrained')
    for ax,pos in zip(axes,positions):
        g=conditional[conditional.position.eq(pos)].set_index('past_tier').loc[['low','middle','high']]
        y=g.next_mean.to_numpy()/scales[pos]*100
        low=g.next_p10.to_numpy()/scales[pos]*100;high=g.next_p90.to_numpy()/scales[pos]*100
        ax.errorbar([0,1,2],y,yerr=[y-low,high-y],fmt='o',capsize=5,color='#2676b8',lw=2)
        ax.set(xticks=[0,1,2],xticklabels=['Low','Middle','High'],title=pos,xlabel='Previous production tier',ylabel='Next-season index (unclipped)')
        ax.set_ylim(bottom=0);ax.grid(alpha=.15)
    fig.suptitle('History changes the distribution; bars span the 10th–90th percentile')
    fig.savefig(reports/'history_conditioning.png',dpi=160);plt.close(fig)

    selected=showcase['players']
    summaries=[]
    for p in selected:
        summaries.append({'player':p['id'],'age':p['age'],'recent_scores':', '.join(f"{h['score']:.0f}" for h in p['history'][-3:]),
                          'next_A':p['alternatives'][0]['score'],'next_B':p['alternatives'][1]['score'],
                          'next_C':p['alternatives'][2]['score'],'PPR_p10':p['distribution']['p10'],'PPR_p90':p['distribution']['p90']})
    for filename in ['realism_checks.csv','game_realism_metrics.csv','conditional_history_metrics.csv','model_config.json',
                     'development_calibration.csv','parameter_summary.csv','age_associations.csv','beta_priors.csv',
                     'role_transitions.csv','trait_correlations.csv','persistence.csv','real_player_histories.csv',
                     'balanced_historical_audit.csv','balanced_audit_metadata.json','player_database.json']:
        shutil.copyfile(out/filename,reports/filename)
    for filename in ['validation_metrics.csv','distribution_comparison.csv','stat_distribution_comparison.csv',
                     'joint_distribution_comparison.csv','validation_protocol.json']:
        shutil.copyfile(out/filename,reports/f'conditional_audit_{filename}')
    shutil.copyfile(out/'showcase_players.json',reports/'generated_players.json')
    shutil.copyfile(root/'data/raw/manifest.json',reports/'source_manifest.json')
    shutil.copyfile(root/'data/processed/coverage.json',reports/'coverage.json')
    pd.DataFrame(summaries).to_csv(reports/'player_examples.csv',index=False)
    allseasons=pd.read_csv(out/'league_seasons.csv')
    allseasons[allseasons.simulation<=3].to_csv(reports/'three_generated_seasons.csv',index=False)
    passed=int(checks.passed.sum());total=len(checks)
    sections=[
        '# A distribution-first fictional NFL season generator','',
        '**Purpose:** believable new seasons given fictional player histories. Individual forecasting accuracy is secondary.','',
        f"Data: {panel.player_id.nunique():,} real players and {len(panel):,} player-seasons, 2015–2025, from free [nflverse release assets](https://github.com/nflverse/nflverse-data/releases). [Source URLs/checksums](source_manifest.json) and [coverage audit](coverage.json) are retained.",'',
        f"Executed {showcase['replicates']} complete population simulations. **{passed}/{total} statistical realism gates passed.** These are empirical acceptance checks, separate from the software test suite.",'',
        '## What changed','',
        '1. Removed independent log-stat extrapolation. A positive historical successor can no longer disappear because a numerical adjustment goes negative.',
        '2. Assign one complete modern NFL outcome pool per season, with stochastic one-to-one matching based on age, opportunity style, recent history and participation. NFL-sized role/opportunity supply is limited.',
        '3. Include complete empirical new-entrant cohorts and explicit next-roster status. Career exits are not labeled injuries.',
        '4. Perturb full game vectors within successor seasons at 25% strength to create new lines while retaining workload/efficiency relationships. The game does not hard-cap passing attempts or clip production to historical maxima.',
        'Negative net yardage is preserved; only event counts are constrained to be nonnegative.',
        '5. Keep the same persistent perturbation throughout each fictional history, then allocate upcoming outcomes without inspecting those outcomes in the matching cost.','',
        'The production ecology is drawn from **2021–2025**, the 17-game era; **all 2015–2025 data** still supplies histories and conditional transition comparisons. Population-level realism is a deliberate design constraint, not an independent statistical discovery.','',
        '## Reading the 0–100 score','',
        '`score = min(100, max(0, 100 × PPR / position_reference))`','',
        'The reference is the position’s 99th-percentile fantasy-relevant season PPR from **2015–2022**, fixed before this work. A 50 is half that production, not the 50th percentile. Scores are not re-ranked every season. The same score at different positions does not imply equal raw fantasy value. Values above the display ceiling retain their complete raw PPR in the data and raw-PPR graphs. This is a production index, not a hidden ability rating.','',
        markdown_table(pd.DataFrame([{'position':p,'PPR_at_score_100':scales[p]} for p in positions])),'',
        '## Position distributions','',
        'Ranks 1–100 include the entire position pool and new entrants. The gray band is the observed annual range, not a confidence interval. The three colored curves are simulations 1, 2 and 3, selected in advance; no favorable seasons were picked.','',
        '![Position rank curves](position_distributions_score.png)','',
        '[Raw PPR version](position_distributions_ppr.png)','',
        markdown_table(metrics[['position','rank_curve_error_score','top12_error_score','historical_zero_active','generated_zero_active','historical_opportunities','generated_opportunities']]),'',
        'The population margin checks measure whether the implementation reproduces its empirical design target. They cannot, by themselves, show that assigning those outcomes to individual histories is realistic. The next checks address that distinction.','',
        '## Histories still matter','',
        '![Conditional production distributions](history_conditioning.png)','',
        'Low/middle/high are previous-production thirds among incumbents above 30 PPR. Conditional means must be ordered, and individual players must retain substantial uncertainty and novel positive stat lines. Age, recent workload style and recorded participation enter matching; age effects are empirical associations, not a medical or causal model.','',
        '## Inspect fictional players','',
        markdown_table(pd.DataFrame(summaries)),'',
        '![Player histories](player_histories_score.png)','',
        '[Raw PPR histories](player_histories_ppr.png) · [Full player JSON](generated_players.json) · [Three entire generated seasons](three_generated_seasons.csv)','',
        'Each row shows three alternative upcoming seasons from the same history. They are not three consecutive seasons. All examples are chosen from fixed previous-production strata before drawing their outcomes. Histories can be truncated at 2015; a first visible year is not necessarily a rookie year.','',
        '## Reliability protocol and remaining scope','',
        'The same complete-game engine was also replayed against 2023–2025 incumbent histories, fitting only through 2022. This is separate from the construction-target plots above. It uses '+str(metadata['replicates_per_year'])+' complete season draws per year:', '',
        markdown_table(pd.read_csv(out/'balanced_historical_audit.csv')),'',
        'This reused audit still differs from the exact later NFL cohorts, especially their absence/exit rates. A fictional game is calibrated to plausible historical outcomes, not to recreating the particular next real season. These differences remain visible rather than being erased by annual percentile rescaling.', '',
        '- Simulator settings were selected on 2019–2022 forward-only development folds using pooled and history-conditional distribution distances, not individual prediction error. Zero-jitter copying is reported as an ablation and excluded from procedural settings.',
        '- The conditional 2023–2025 audit remains available in the CSVs. Those years were already inspected during v1, so this is a reused historical audit, not a newly untouched test set. Its remaining era/cohort discrepancies are not concealed by the population-matching plots.',
        '- The complete-game margin gates check raw opportunities and raw PPR as well as the display index, seed batches, dropout ranges and history dependence. None can be made to pass merely by normalizing scores separately each year.',
        '- The gray historical band describes annual variation; this generator resamples a finite historical source, so it cannot establish reliability under an unprecedented football regime.',
        '- Weekly injury reports still do not identify complete injury-caused absence or individual recurrence hazards. The engine reproduces empirical participation/out-of-production patterns without claiming to have fitted a medical durability model.',
        '- This is a complete player-pool/season-stat generator. It does not yet simulate shared team play-by-play, enforce identical QB/receiver totals within each fictional offense, run a fantasy draft, or validate long multi-decade careers.',
        '- The game-facing JSON contains fictional IDs and no source names, teams or GSIS IDs. It is not formal anonymization; a historical shape may remain recognizable.','',
        '[Every realism gate](realism_checks.csv) · [Complete-game historical audit](balanced_historical_audit.csv) · [Parameter summaries](parameter_summary.csv) · [Full fictional database](player_database.json)','',
        'Open [the standalone interactive report](SEASON_EXPLORER.html) to switch score/PPR views and inspect each history and alternative stat line. It embeds all images and data and requires no server or network.',''
    ]
    (reports/'MODEL_REPORT.md').write_text('\n'.join(sections))
    def image_data(name):return 'data:image/png;base64,'+base64.b64encode((reports/name).read_bytes()).decode()
    payload={'players':selected,'metrics':metrics.to_dict('records'),'checks':{'passed':passed,'total':total},
             'images':{name:image_data(name+'.png') for name in ['position_distributions_score','position_distributions_ppr','player_histories_score','player_histories_ppr','history_conditioning']}}
    encoded=json.dumps(payload,allow_nan=False).replace('</','<\\/')
    document='''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fictional NFL · Season Explorer</title><style>
    :root{font-family:system-ui,sans-serif;color:#243145;background:#f3f5f8}body{margin:0}main{max-width:1200px;margin:auto;padding:35px 24px}h1{font-size:2.4rem;margin-bottom:8px}h2{margin-top:40px}.lead{font-size:1.15rem;max-width:900px}.box{background:white;border:1px solid #dce2e9;border-radius:12px;padding:22px;margin:18px 0}.muted{color:#586578}label{margin-right:20px}select{padding:8px;border:1px solid #b9c5d2;border-radius:6px;font:inherit}img{width:100%;height:auto}.scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{text-align:left;padding:9px;border-bottom:1px solid #e3e7ed;white-space:nowrap}th{color:#586578}code{background:#eef1f5;padding:3px}.badge{display:inline-block;background:#e9f3ee;padding:7px 12px;border-radius:20px}summary{cursor:pointer;font-weight:600}.legend{display:flex;gap:20px;flex-wrap:wrap}.dot{width:10px;height:10px;display:inline-block;border-radius:50%;margin-right:6px}footer{margin-top:40px;color:#586578;font-size:.9rem}</style></head><body><main>
    <p class="muted">FF GAME · EMPIRICAL SEASON LAB</p><h1>A believable league. Uncertain careers.</h1><p class="lead">Compare a historical NFL position distribution with three generated seasons, then inspect the histories behind individual players. The goal is realistic game outcomes, not predicting real NFL players.</p><p id="checks" class="badge"></p>
    <div class="box"><label>Display <select id="mode"><option value="score">Production index · 0–100</option><option value="ppr">Raw fantasy points · PPR</option></select></label><p class="muted">100 is a fixed historical positional benchmark, not a percentile recalculated each year. The index is capped for display; raw PPR is retained. Scores across positions are not equal raw fantasy value.</p></div>
    <h2>1. Does the position pool look like an NFL season?</h2><p>Gray: historical mean and annual range, 2021–2025. Colored: the first three alternative seasons from the same fictional population, including new entrants. Pool distributions are a design constraint; the plots verify that implementation, not independent forecasting skill.</p><div class="box"><img id="rankImage" alt="Historical and generated position rank curves"></div>
    <h2>2. Does history change the range of outcomes?</h2><p>Previous low, middle and high producers should have different next-season distributions. Bars span the 10th–90th percentile; they show variation, not a confidence interval on the mean.</p><div class="box"><img id="conditionalImage" alt="Conditional next-season production by previous production tier"></div>
    <h2>3. Follow an individual career</h2><div class="box"><label>Player <select id="player"></select></label><p id="profileSummary"></p><div class="scroll"><table id="history"></table></div><h3>Three alternative upcoming seasons</h3><p class="muted">These are alternatives from the same history, not consecutive years. No outcomes were selected for appeal.</p><div class="scroll"><table id="alternatives"></table></div></div><div class="box"><img id="historyImage" alt="Twelve fictional player histories with three alternative next seasons"></div>
    <h2>What this evidence establishes</h2><div class="box"><p>One-to-one stochastic matching allocates complete historical NFL-sized outcome pools using age, workload style, recent production and participation. Game-level bootstrap variation creates new stat lines. The model avoids unconstrained extrapolation and preserves scarce league opportunities.</p><p>Tests cover production budgets, ranked distributions, active zero-production rates, prior-history relationships, seed stability, numerical accounting, privacy fields and data leakage. The 2023–2025 conditional audit was previously inspected and is a reused audit.</p><details><summary>Limits and definitions</summary><p>Histories use 2015–2025 data; population ecology uses the 17-game 2021–2025 era. Scoring is full PPR, four-point passing TDs and -2 interceptions/offensive lost fumbles; no return or two-point bonuses. Injury reports are incomplete and are not a fitted medical durability model. Retirement/absence labels are not inferred from every zero. Full fictional team play-by-play and multi-decade career validation remain outside this player-pool engine.</p><p>Rank plots can look correct because population margins are constrained by design. Conditional history checks are therefore separate. The fixed index benchmark was estimated using 2015–2022 seasons, before the audit. A first visible historical year may be left-truncated at 2015.</p></details></div>
    <footer>This report is standalone: images and player data are embedded. No server, external fonts, libraries or network access are required.</footer>
    </main><script id="report-data" type="application/json">PAYLOAD</script><script>
    const data=JSON.parse(document.getElementById('report-data').textContent);
    const mode=document.getElementById('mode'),player=document.getElementById('player');
    data.players.forEach((p,i)=>{const o=document.createElement('option');o.value=i;o.textContent=p.id+' · age '+p.age;player.appendChild(o)});
    function renderTable(target,headers,rows){const t=document.getElementById(target);t.replaceChildren();const head=document.createElement('tr');headers.forEach(h=>{const c=document.createElement('th');c.textContent=h;head.appendChild(c)});t.appendChild(head);rows.forEach(row=>{const r=document.createElement('tr');row.forEach(v=>{const c=document.createElement('td');c.textContent=v;r.appendChild(c)});t.appendChild(r)})}
    function render(){const metric=mode.value,p=data.players[Number(player.value)||0];document.getElementById('rankImage').src=data.images['position_distributions_'+metric];document.getElementById('historyImage').src=data.images['player_histories_'+metric];document.getElementById('conditionalImage').src=data.images.history_conditioning;
    document.getElementById('checks').textContent=data.checks.passed+' / '+data.checks.total+' population realism gates passed';document.getElementById('profileSummary').textContent=p.id+' · '+p.position+' · age '+p.age+' · next-season PPR range (10–90%): '+p.distribution.p10.toFixed(1)+'–'+p.distribution.p90.toFixed(1)+' · no-offensive-production chance: '+(100*p.distribution.zero_probability).toFixed(1)+'%';
    renderTable('history',['Age','Games','Score','PPR','Pass yd','Rush yd','Rec yd','Catches','Listed OUT weeks'],p.history.map(h=>[h.age??'Unknown',h.games,h.score.toFixed(1),h.ppr.toFixed(1),h.passing_yards,h.rushing_yards,h.receiving_yards,h.receptions,h.listed_out_weeks??'Unknown']));
    renderTable('alternatives',['Draw','Games','Score','PPR','Pass yd/TD','Rush yd/TD','Rec yd/TD','Catches'],p.alternatives.map((a,i)=>[i+1,a.games,a.score.toFixed(1),a.ppr.toFixed(1),a.passing_yards+' / '+a.passing_tds,a.rushing_yards+' / '+a.rushing_tds,a.receiving_yards+' / '+a.receiving_tds,a.receptions]));}
    mode.addEventListener('change',render);player.addEventListener('change',render);render();
    </script></body></html>'''
    (reports/'SEASON_EXPLORER.html').write_text(document.replace('PAYLOAD',encoded))
    print(f'Wrote visual explorer and report: {passed}/{total} realism checks passed',flush=True)
