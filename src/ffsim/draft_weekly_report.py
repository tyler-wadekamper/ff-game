"""Offline interactive draft board and weekly calendars, with honest evidence."""
from __future__ import annotations
import base64
import json
import os
from pathlib import Path
import shutil
import numpy as np
import pandas as pd
from .weekly import weekly_engine_fingerprint


def render_extensions(root):
    root=Path(root);out=root/'artifacts';reports=root/'reports';reports.mkdir(exist_ok=True)
    os.environ.setdefault('MPLCONFIGDIR','/tmp/ff-game-matplotlib')
    os.environ.setdefault('XDG_CACHE_HOME','/tmp/ff-game-cache')
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    plt.rcParams.update({'axes.spines.top':False,'axes.spines.right':False,'font.size':10})
    adp=pd.read_csv(out/'adp_validation.csv');individual=pd.read_csv(out/'adp_validation_individual.csv')
    wm=pd.read_csv(out/'weekly_validation_metrics.csv');wc=pd.read_csv(out/'weekly_validation_checks.csv')
    tails=pd.read_csv(out/'weekly_validation_tails.csv')
    structural=json.loads((out/'weekly_structural_audit.json').read_text())
    protocol=json.loads((out/'weekly_validation_protocol.json').read_text())
    export=json.loads((out/'weekly_export_checks.json').read_text())
    if any(d.get('engine_fingerprint')!=weekly_engine_fingerprint() for d in [protocol,export,structural]):
        raise ValueError('Stale weekly evidence; rebuild draft-weekly')
    positions=['QB','RB','WR','TE'];colors={'QB':'#467bb0','RB':'#d28626','WR':'#398976','TE':'#89649d'}
    fig,axes=plt.subplots(1,2,figsize=(12,5),layout='constrained')
    for ax,year in zip(axes,[2023,2024]):
        rows=individual[(individual.draft_year==year)&individual.observed&(individual.eligible_rank<=192)]
        for p in positions:
            g=rows[rows.position==p];ax.scatter(g.eligible_rank,g.estimated_rank,s=15,alpha=.65,label=p,color=colors[p])
        ax.plot([1,192],[1,192],'--',color='#69727d',lw=1)
        ax.set(title=f'{year}: later market ordering audit',xlabel='Actual eligible market rank',ylabel='History-comparable estimated rank')
        ax.grid(alpha=.15)
    axes[0].legend(frameon=False);fig.suptitle('ADP ordering is evaluated independently of its calibrated price-spacing curve')
    fig.savefig(reports/'adp_ordering_validation.png',dpi=160);plt.close(fig)

    arrays=np.load(out/'weekly_validation_distributions.npz')
    fig,axes=plt.subplots(2,2,figsize=(12,8),layout='constrained')
    for ax,p in zip(axes.flat,positions):
        for label,key,color in [('Real weekly PPR','real','#27364a'),('Generated weekly PPR','generated','#287fb7')]:
            values=np.sort(arrays[p+'_'+key]);ax.plot(values,np.arange(1,len(values)+1)/len(values),label=label,color=color,lw=2)
        ax.set(title=p,xlabel='PPR in a participated game',ylabel='Cumulative fraction')
        ax.grid(alpha=.15)
    axes.flat[0].legend(frameon=False)
    fig.suptitle('2023–2025 weekly distributions · templates through 2022 · same players excluded')
    fig.savefig(reports/'weekly_distribution_validation.png',dpi=160);plt.close(fig)
    fig,axes=plt.subplots(1,3,figsize=(13,4.4),layout='constrained')
    for ax,metric,title in zip(axes,['weekly_sd','max_share','bust'],['Weekly SD (PPR points)','Largest game / positive season points','Bust-game frequency']):
        g=wm[wm.metric==metric].set_index('position').loc[positions];x=np.arange(4)
        ax.bar(x-.18,g.real,.36,label='Real',color='#aab5c4');ax.bar(x+.18,g.generated,.36,label='Generated',color='#287fb7')
        ax.set(title=title,xticks=x,xticklabels=positions);ax.grid(axis='y',alpha=.15)
    axes[0].legend(frameon=False);fig.suptitle('Variability and tails are checked separately from exact season-total conservation')
    fig.savefig(reports/'weekly_variability_validation.png',dpi=160);plt.close(fig)
    fig,axes=plt.subplots(1,2,figsize=(11,4.4),layout='constrained')
    for ax,metric,title in zip(axes,['pooled_p99','over40_rate'],['99th percentile game (PPR)','Games above 40 PPR (%)']):
        g=tails[tails.metric==metric].set_index('position').loc[positions];x=np.arange(4)
        scale=100 if metric=='over40_rate' else 1
        ax.bar(x-.18,g.real*scale,.36,label='Real',color='#aab5c4');ax.bar(x+.18,g.generated*scale,.36,label='Generated',color='#287fb7')
        ax.set(title=title,xticks=x,xticklabels=positions);ax.grid(axis='y',alpha=.15)
    axes[0].legend(frameon=False);fig.suptitle('Rare high-scoring weeks are audited explicitly')
    fig.savefig(reports/'weekly_tail_validation.png',dpi=160);plt.close(fig)

    prices=pd.read_csv(out/'generated_adp.csv');database=json.loads((out/'player_database_with_adp.json').read_text())
    historical=pd.read_csv(out/'historical_adp.csv')
    market_counts=historical[(historical.draft_year>=2016)&(historical.eligible_rank<=192)].groupby(['draft_year','position']).size().unstack()
    mix=[]
    for p in positions:
        h=market_counts[p];g=prices[prices.position==p]
        mix.append({'position':p,'historical_min':int(h.min()),'historical_median':float(h.median()),
                    'historical_max':int(h.max()),'generated_top192':int((g['rank']<=192).sum()),
                    'generated_expected_drafted':float(g.drafted_probability_192.sum())})
    mix=pd.DataFrame(mix);mix.to_csv(reports/'adp_position_mix.csv',index=False)
    weeks=pd.read_csv(out/'weekly_results.csv.gz');examples=json.loads((out/'draft_weekly_explorer.json').read_text())
    fig,axes=plt.subplots(4,3,figsize=(15,12),layout='constrained')
    for ax,p in zip(axes.flat,examples['players']):
        for n,season in enumerate(p['weekly_seasons']):
            if season['path']!=1:continue
            ax.plot(range(1,19),[w['ppr'] for w in season['weeks']],lw=1,alpha=.8,label=f'Alternative {season["simulation"]}')
        bye=p['weekly_seasons'][0]['bye'];ax.axvspan(bye-.35,bye+.35,color='#dce2e9')
        ax.set(title=f"{p['id']} · ADP {p['draft']['adp']:.1f}",xlabel='Calendar week',ylabel='PPR',xticks=[1,5,9,13,18]);ax.grid(alpha=.15)
    axes[0,0].legend(fontsize=7,frameon=False);fig.suptitle('One fixed preseason ADP; three different 18-week calendars (gray = bye)')
    fig.savefig(reports/'weekly_player_examples.png',dpi=145);plt.close(fig)

    # Compact arrays keep every priced player inspectable without a server.
    ids={p['id'] for p in database['players']};calendars={pid:[] for pid in ids}
    columns=['games','ppr']+list(__import__('ffsim.weekly',fromlist=['STATS']).STATS)
    for (pid,simulation,path),g in weeks[weeks.id.isin(ids)].groupby(['id','simulation','path']):
        g=g.sort_values('week')
        calendars[pid].append({'simulation':int(simulation),'path':int(path),'bye':int(g.bye_week.iloc[0]),
                              'group':int(g.schedule_group.iloc[0]),'rows':g[columns].to_numpy().tolist()})
    comps=json.loads((out/'adp_comparables.json').read_text())
    players=[]
    for p in database['players']:
        players.append({**p,'calendars':calendars[p['id']],'comparables':comps[p['id']]})
    players.sort(key=lambda p:p['draft']['adp'])
    summary={'players':len(players),'calendars':export['calendars'],'weekly_paths_validated':protocol['paths_conserved'],
             'weekly_gates_passed':int(wc.passed.sum()),'weekly_gates_total':len(wc)}
    def data_image(name):return 'data:image/png;base64,'+base64.b64encode((reports/name).read_bytes()).decode()
    payload={'players':players,'columns':columns,'summary':summary,
             'adp_validation':adp.to_dict('records'),'adp_position_mix':mix.to_dict('records'),
             'weekly_validation':wm.to_dict('records'),'weekly_tails':tails.to_dict('records'),
             'images':{k:data_image(k+'.png') for k in ['adp_ordering_validation','weekly_distribution_validation','weekly_variability_validation','weekly_tail_validation']}}
    encoded=json.dumps(payload,separators=(',',':'),allow_nan=False).replace('</','<\\/')
    document='''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Draft & Weekly Lab</title><style>
    :root{font-family:system-ui,sans-serif;background:#f1f4f7;color:#233247}body{margin:0}main{max-width:1250px;margin:auto;padding:30px 22px}h1{font-size:2.4rem;margin:8px 0}h2{margin-top:36px}.lead{max-width:950px;font-size:1.1rem}.card{background:white;border:1px solid #dbe2e9;border-radius:12px;padding:22px;margin:18px 0}.muted{color:#5c6979}.controls{display:flex;gap:15px;flex-wrap:wrap;align-items:center}select,input{padding:8px;font:inherit;border:1px solid #bac7d5;border-radius:6px}table{border-collapse:collapse;width:100%;font-size:.87rem}th,td{padding:8px;text-align:left;border-bottom:1px solid #e2e8ee;white-space:nowrap}.scroll{overflow:auto;max-height:470px}button{border:0;background:none;color:#246b9d;font:inherit;cursor:pointer;text-decoration:underline}img{width:100%;height:auto}.badge{background:#e5f0e9;padding:7px 12px;border-radius:20px;display:inline-block}.warning{background:#fff6df;padding:14px;border-radius:8px}svg{width:100%;height:auto}.price{font-size:1.3rem;font-weight:650}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}@media(max-width:850px){.grid{grid-template-columns:1fr}}summary{cursor:pointer;font-weight:600}nav a{margin-right:20px;color:#246b9d}</style></head><body><main>
    <p class="muted">FF GAME · DRAFT & WEEKLY LAB</p><h1>A draft price before the season. A different story every week.</h1><p class="lead">ADP uses visible histories only. Weekly results are generated from season totals and sum back to every integer statistic and fantasy point. Select any player in the pool and compare three alternative 18-week seasons.</p><nav><a href="#draft">Draft board</a><a href="#calendar">Weekly player explorer</a><a href="#evidence">Validation</a></nav><p id="summary" class="badge"></p>
    <div class="warning">ADP source: archived FantasyPros overall consensus, 2015–2024. The archive does not certify PPR scoring or league size. This is an indicative history-based market model, not a verified pure-PPR price feed. Deep-tail prices are extrapolated queue positions. Draft-room ranges use configured randomness, not measured confidence intervals.</div>
    <h2 id="draft">1. The preseason draft board</h2><div class="card"><div class="controls"><input id="search" placeholder="Find player ID" aria-label="Find player ID"><select id="position" aria-label="Position filter"><option value="ALL">All positions</option><option>QB</option><option>RB</option><option>WR</option><option>TE</option></select><select id="limit" aria-label="Board size"><option value="192">First 192 · 12 teams × 16 rounds</option><option value="9999">Entire pool</option></select></div><p class="muted">Click a player to inspect the history, historical market comparables and weekly outcomes. The price remains fixed when you change the simulated season.</p><div class="scroll"><table id="board"></table></div></div>
    <h2 id="calendar">2. Every week, with an explicit bye</h2><div class="card"><div class="controls"><select id="player" aria-label="Player"></select><select id="season" aria-label="Alternative season"><option value="0">Alternative season 1</option><option value="1">Alternative season 2</option><option value="2">Alternative season 3</option></select><select id="path" aria-label="Weekly path"><option value="0">Weekly path A</option><option value="1">Weekly path B · same totals</option></select></div><p id="price" class="price"></p><p id="totals"></p><div id="chart"></div><p class="muted">Gray = shared schedule-group bye. A week without participation is not automatically an injury. A participated game can score zero or negative points.</p><details><summary>Full weekly box scores</summary><div class="scroll"><table id="weeks"></table></div></details><div class="grid"><div><h3>Visible player history</h3><div class="scroll"><table id="history"></table></div></div><div><h3>Historical market comparables</h3><p class="muted">These are past-history/ADP examples. They do not expose future season outcomes.</p><div class="scroll"><table id="comps"></table></div></div></div></div>
    <h2 id="evidence">3. Evidence, including the errors</h2><div class="card"><h3>ADP ordering in later market years</h3><p>2023–2024 ADP targets are excluded from fitting. Actual eligible rank is compared with a history-based estimated rank. Prices depend on news and rookie scouting absent from NFL histories, so individual errors remain substantial. Price-spacing calibration is not counted as independent validation.</p><div class="scroll"><table id="adpMetrics"></table></div><img id="adpImage" alt="ADP ordering audit scatter plots"><h3>Position mix at the draft margin</h3><p>The generated first 192 somewhat overrepresent QB/TE and underrepresent WR relative to historical boards. No positional quota is imposed. Expected drafted counts average the configured draft queues; historical min/max are observed yearly ranges.</p><div class="scroll"><table id="positionMix"></table></div></div>
    <div class="card"><h3>Weekly variability, tails and game concentration</h3><p>Weekly templates end in 2022; audit seasons are 2023–2025. Same-player templates are excluded. Variability regularization was fitted using 2021–2022 only. Season totals and games are known inputs, so matching average points is automatic; variation and tails are tested separately.</p><img id="varianceImage" alt="Real versus generated weekly variability and concentration"><img id="tailImage" alt="99th percentile games and frequency above 40 PPR"><div class="scroll"><table id="tailMetrics"></table></div><img id="cdfImage" alt="Real and generated weekly PPR cumulative distributions"></div>
    <details class="card"><summary>Scope and definitions</summary><p>There are 18 calendar weeks, one bye, and at most 17 participated games. Anonymous schedule groups coordinate bye weeks; this does not yet simulate shared team play-by-play or opponent defenses. Weekly counts obey event capacities and exact season totals, including negative yardage, lateral yardage without a catch, and strip fumbles without pass attempts.</p><p>ADP is learned from NFL history before each draft year. Unlisted players are censored at the model's supported draft range. Names and historical position labels are independently audited; the archive contains updated metadata and damaged rows. Estimated ADP for undrafted reserves is not an observed historical price. The 12-team/16-round display is a game setting. Rookie scouting and current injury/camp news are unavailable to this history-only model.</p></details>
    <footer class="muted">Standalone report: all player data and charts are embedded. No server, external libraries or network requests are required.</footer></main>
    <script id="report-data" type="application/json">PAYLOAD</script><script>
    const D=JSON.parse(document.getElementById('report-data').textContent),$=id=>document.getElementById(id);const columns=D.columns;
    function table(id,headers,rows){const t=$(id);t.replaceChildren();const h=document.createElement('tr');headers.forEach(v=>{const c=document.createElement('th');c.textContent=v;h.appendChild(c)});t.appendChild(h);rows.forEach(vals=>{const tr=document.createElement('tr');vals.forEach(v=>{const c=document.createElement('td');if(v instanceof Node)c.appendChild(v);else c.textContent=v;tr.appendChild(c)});t.appendChild(tr)})}
    D.players.forEach((p,i)=>{const o=document.createElement('option');o.value=i;o.textContent=p.id+' · '+p.position+' · ADP '+p.draft.adp.toFixed(1);$('player').appendChild(o)});
    function board(){const search=$('search').value.toUpperCase(),pos=$('position').value,limit=Number($('limit').value);const rows=D.players.filter(p=>p.draft.rank<=limit&&(pos==='ALL'||p.position===pos)&&p.id.includes(search));table('board',['Rank','Player','Pos','ADP / queue rank','Queue ranks 10–90%','Drafted in 192','Support'],rows.map(p=>{const b=document.createElement('button');b.textContent=p.id;b.onclick=()=>{$('player').value=D.players.indexOf(p);render();$('calendar').scrollIntoView({behavior:'smooth'})};return[p.draft.rank,b,p.position,p.draft.adp.toFixed(1),p.draft.pick_p10+'–'+p.draft.pick_p90,(100*p.draft.drafted_probability_192).toFixed(0)+'%',p.draft.within_observed_market_range?'Historical price range':'Extrapolated tail']}))}
    function render(){const p=D.players[Number($('player').value)||0],s=p.calendars[2*Number($('season').value)+Number($('path').value)];const rows=s.rows,pts=rows.map(r=>r[1]),sum=pts.reduce((a,b)=>a+b,0),games=rows.reduce((a,r)=>a+r[0],0);$('price').textContent=p.id+' · upcoming age '+(p.age+1)+' · preseason ADP '+p.draft.adp.toFixed(1);$('price').dataset.adp=p.draft.adp;
    $('totals').textContent='Weekly sum '+sum.toFixed(2)+' PPR · '+games+' participated games · bye week '+s.bye+' · schedule group '+s.group+' · 18 calendar weeks';
    const W=1060,H=310,L=42,R=12,T=20,B=42,max=Math.max(5,...pts)*1.12,min=Math.min(0,...pts)-1,sy=v=>T+(max-v)/(max-min)*(H-T-B),zero=sy(0),bw=(W-L-R)/18;let svg='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="18 weekly fantasy point bars">';for(let i=0;i<5;i++){const v=min+(max-min)*i/4,y=sy(v);svg+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y+'" y2="'+y+'" stroke="#e3e8ee"/><text x="3" y="'+(y+4)+'" font-size="11">'+v.toFixed(0)+'</text>'}
    rows.forEach((r,i)=>{const x=L+i*bw+5,isBye=i+1===s.bye,played=r[0]>0,y=sy(r[1]);if(isBye)svg+='<rect x="'+x+'" y="'+T+'" width="'+(bw-10)+'" height="'+(H-T-B)+'" fill="#e1e6ec"/>';svg+='<rect class="weekbar" data-week="'+(i+1)+'" x="'+x+'" y="'+Math.min(y,zero)+'" width="'+(bw-10)+'" height="'+Math.max(2,Math.abs(zero-y))+'" fill="'+(isBye?'#9da9b7':(!played?'#d7dde5':(r[1]<0?'#cd7d39':'#287fb7')))+'"><title>Week '+(i+1)+': '+(isBye?'BYE':(!played?'No participation':r[1].toFixed(2)+' PPR'))+'</title></rect><text x="'+(x+bw/2-5)+'" y="'+(H-15)+'" text-anchor="middle" font-size="11">'+(isBye?'BYE':i+1)+'</text>'});$('chart').innerHTML=svg+'</svg>';
    table('weeks',['Week','Status','PPR','Pass yd/TD','Rush yd/TD','Rec yd/TD','Catches','INT'],rows.map((r,i)=>[i+1,i+1===s.bye?'BYE':(r[0]?'Played':'No participation'),r[1].toFixed(2),r[2+2]+' / '+r[2+3],r[2+6]+' / '+r[2+7],r[2+10]+' / '+r[2+11],r[2+9],r[2+4]]));
    table('history',['Age','Games','PPR','Carry','Targets'],p.history.map(h=>[h.age,h.games,h.ppr.toFixed(1),h.carries,h.targets]));table('comps',['Historical player','Draft year','Source ADP','Previous PPR17','Games'],p.comparables.map(c=>[c.name,c.draft_year,c.source_adp??'Unlisted',c.last_ppr17.toFixed(1),c.last_games]));}
    $('summary').textContent=D.summary.players+' priced players · '+D.summary.calendars+' complete weekly calendars · '+D.summary.weekly_gates_passed+'/'+D.summary.weekly_gates_total+' weekly distribution gates';
    table('adpMetrics',['Year','Cohort','N','Rank correlation','Mean rank error','Top60 overlap'],D.adp_validation.map(r=>[r.draft_year,r.cohort,r.n_observed_top192,r.rank_spearman.toFixed(2),r.rank_mae.toFixed(1),(r.top60_overlap*100).toFixed(0)+'%']));$('adpImage').src=D.images.adp_ordering_validation;$('varianceImage').src=D.images.weekly_variability_validation;$('cdfImage').src=D.images.weekly_distribution_validation;
    $('tailImage').src=D.images.weekly_tail_validation;table('tailMetrics',['Position','Metric','Real','Generated','Pass'],D.weekly_tails.map(r=>[r.position,r.metric,r.real.toFixed(4),r.generated.toFixed(4),r.passed?'Yes':'No']));
    table('positionMix',['Pos','Historical min','Median','Max','Generated top192','Expected drafted'],D.adp_position_mix.map(r=>[r.position,r.historical_min,r.historical_median,r.historical_max,r.generated_top192,r.generated_expected_drafted.toFixed(1)]));
    $('player').onchange=render;$('season').onchange=render;$('path').onchange=render;$('position').onchange=board;$('limit').onchange=board;$('search').oninput=board;board();render();
    </script></body></html>'''
    (reports/'DRAFT_WEEKLY_EXPLORER.html').write_text(document.replace('PAYLOAD',encoded))
    for name in ['generated_adp.csv','player_database_with_adp.json','weekly_results.csv.gz','adp_validation.csv','adp_validation_individual.csv',
                 'adp_protocol.json','adp_coverage.csv','adp_join_issues.csv','adp_join_repairs.csv','adp_development.csv',
                 'weekly_validation_metrics.csv','weekly_validation_checks.csv','weekly_validation_tails.csv','weekly_validation_protocol.json','weekly_export_checks.json','weekly_config.json','weekly_structural_audit.json']:
        shutil.copyfile(out/name,reports/name)
    shutil.copyfile(root/'data/raw/adp/manifest.json',reports/'adp_source_manifest.json')
    from .presentation import markdown_table
    text=['# ADP and weekly-results evidence','',
          'Open [the standalone explorer](DRAFT_WEEKLY_EXPLORER.html) to inspect every priced player, historical comparables and three alternative 18-week calendars.','',
          '## ADP: a history-only market model','',
          'Data: pinned public community archive of FantasyPros overall consensus, 2015–2024. 2015 is downloaded for provenance; fitting starts in 2016 because NFL histories begin in 2015. The archive does not certify scoring or league size. It is **not claimed as a verified pure-PPR, 12-team feed**. Updated team/position labels are ignored; NFL identities and positions are independently joined. All top-216 source players in 2016–2024 are resolved. The two unmatched top-216 rows in 2015 are outside this NFL observation window. Repairs and unresolved tail rows are exported.','',
          'Comparables use only histories available before each draft year: age, calendar-aligned 1/2/3-year production, volume/style, games, documented OUT weeks and elapsed time since offensive production. Rare gadget throws do not dominate non-QB comparisons. Missing market prices are censored, not fabricated observations. All drafted rookies are included as preseason candidates, including unpriced ones.','',
          'The learned ordering is evaluated on 2023–2024 ADP targets excluded from fitting. Neighborhood selection uses 2020–2022 only. These are historical audits; identity/calendar bugs were diagnosed during development, so they are not described as blind external tests. Rookie scouting, camp news and current medical reports are absent, making exact individual prices uncertain.','',
          markdown_table(adp),'',
          'Rank correlation and mean error are cohort-specific; top-24/60/120 overlap is the complete board overlap for that draft year, repeated for reference.','',
          'Position mix among the first 192 eligible players (K/DST excluded) is shown separately. The generated board somewhat overrepresents QB/TE and underrepresents WR near the draft margin. This is a remaining market-composition bias; no positional quota was imposed to hide it.','',markdown_table(mix),'',
          '![ADP ordering audit](adp_ordering_validation.png)','',
          'Price spacing is calibrated to historical consensus curves; that distribution match is a construction constraint, not independent validation. ADP is the mean rank in 1,000 complete preference queues, with the first 192 counted as drafted. It is not conditional ADP among selected reserves: an always-undrafted player still has a queue rank. The room noise (.12/.18/.25 on log priority by tier) is a game setting, not empirically measured within-room variance. Values beyond the supported market range are explicitly extrapolated queue positions. The default display is 12 teams × 16 rounds; K/DST are removed from eligible ranks.','',
          '## Weekly results: known totals, realistic paths','',
          'There are 18 calendar weeks, at most 17 participated games, and one shared schedule-group bye. Whole observed availability sequences preserve missed-time clusters. Two-game blocks preserve local game patterns. Integer capacity allocation and signed-yardage allocation preserve every season total, including negative yardage and real lateral/strip-fumble edge cases. Byes and nonparticipation have zero production. Nonparticipation is not labeled automatically as injury.','',
          'Templates emphasize the main positional workload. Where compatible sources exist, productive roles require source opportunities per game within a factor of two. Gadget rushing is downweighted for receivers and tight ends. This prevents a reserve’s one busy game from being magnified into a much busier role.','',
          'Touchdowns, interceptions and lost fumbles are drawn conditionally on season counts using smoothed per-opportunity historical rates, then allocated within event capacities. This avoids magnifying one observed touchdown into an implausible single-game pileup. Yardage uses positive-part scaling while retaining empirical negative plays; it does not invent large negative games to force a lower positive season total.','',
          'Initial development showed excessive variability. Two moment-matching corrections, learned only on 2021–2022 with templates ending in 2020, regularize multivariate weekly shapes toward season baselines. The final 2023–2025 audit uses templates ending in 2022 and excludes the same player entirely. Only reconciled single-team seasons are audited; traded-team calendars are not silently treated as unambiguous byes.','',
          f"Audited **{protocol['seasons']} real player-seasons**, with **{protocol['paths_conserved']:,} generated paths**. Passed **{int(wc.passed.sum())}/{len(wc)}** practical distribution gates. Every path conserves totals. Bootstrap difference intervals resample whole players to preserve repeated-season dependence.",'',
          f"Separately exercised **all {structural['seasons']:,} reconciled source seasons**, including depth players and lateral/strip-fumble exceptions: **{structural['failed']} accounting failures**.",'',
          markdown_table(wm[wm.metric.isin(['weekly_sd','cv','max_share','bust'])][['position','metric','real','generated','difference_ci_low','difference_ci_high']]),'',
          'CV is regularized as SD / max(abs(mean), 5) to avoid unstable ratios for tiny fantasy roles. Raw SD in PPR points is reported separately. A boom is above 1.5× the player’s active-game mean; a bust is below 0.5× that mean. Game concentration uses positive fantasy points.','',
          '![Weekly distribution validation](weekly_distribution_validation.png)','',
          '![Weekly variability validation](weekly_variability_validation.png)','',
          '![Rare weekly tails](weekly_tail_validation.png)','',markdown_table(tails),'',
          'Tail limits require pooled 99th- and 99.9th-percentile PPR within 20%, the rate above 40 PPR within 0.5 percentage points, and the rate above 60 within 0.025 percentage points. These are declared game-realism tolerances, not confidence bounds; extreme real samples are sparse. The same historical audit informed mechanism repairs, so this is not an untouched external test. No outcomes were clipped to pass these checks.','',
          'Conservation makes mean weekly points automatic given season totals and games. The independent checks concern variability, game concentration, tails, boom/bust frequencies, lag correlation and missed-participation streaks. The acceptance limits are explicit in the CSV and do not establish exact distributional equality.','',
          f"Exported **{export['calendars']:,} complete calendars** ({export['weekly_rows']:,} weekly rows), including every player in the first three generated league seasons. Shared byes coordinate schedule groups; shared-team play-by-play, opponents and weather remain outside scope.",'',
          '![Player weekly examples](weekly_player_examples.png)','',
          '[Full priced database](player_database_with_adp.json) · [Draft board CSV](generated_adp.csv) · [All weekly rows, gzip CSV](weekly_results.csv.gz) · [Exact export checks](weekly_export_checks.json)','']
    (reports/'DRAFT_WEEKLY_REPORT.md').write_text('\n'.join(text))
    print(f'Wrote draft/weekly explorer: {len(players)} players; {int(wc.passed.sum())}/{len(wc)} weekly gates',flush=True)
