"""Build usable draft boards and conserving weekly calendars for season outputs."""
from __future__ import annotations
import json
from pathlib import Path
import numpy as np
import pandas as pd
from .model import CORE,points
from .weekly import WeeklyLibrary,WeeklyModel,weekly_engine_fingerprint


def make_weekly_outputs(root,library,seed=20261030):
    root=Path(root);out=root/'artifacts'
    seasons=pd.read_csv(out/'league_seasons.csv');seasons=seasons[seasons.simulation<=3]
    config=json.loads((out/'weekly_config.json').read_text())
    if config.get('engine_fingerprint')!=weekly_engine_fingerprint():raise ValueError('Stale weekly calibration; rebuild draft-weekly')
    model=WeeklyModel(library,2025,shape_retention=config['shape_retention'])
    rng=np.random.default_rng(seed)
    bye_list=np.array(list(library.byes[2025].values()))
    if len(bye_list)!=32:raise ValueError('Expected 32 independently observed team bye weeks')
    group_byes=dict(enumerate(rng.permutation(bye_list),start=1))
    schedule={}
    for pos,g in seasons.groupby('position'):
        ids=sorted(g.id.unique());shuffle=rng.permutation(len(ids))
        for n,index in enumerate(shuffle):schedule[ids[index]]=n%32+1
    rows,audit=[],[]
    for n,r in enumerate(seasons.itertuples(index=False)):
        group=schedule[r.id];bye=int(group_byes[group]);totals=np.array([getattr(r,c) for c in CORE])
        for path in [1,2]:
            weeks,meta=model.generate(totals,r.position,bye,np.random.default_rng(seed+10000+2*n+path))
            ppr=points(weeks)
            for w,values in enumerate(weeks,start=1):
                rows.append({'simulation':int(r.simulation),'path':path,'id':r.id,'position':r.position,'week':w,
                         'schedule_group':group,'bye_week':bye,
                         'status':'BYE' if w==bye else ('PLAYED' if values[-1] else 'NO_PARTICIPATION'),
                         **{c:int(v) for c,v in zip(CORE,values)},'ppr':round(float(ppr[w-1]),2)})
            audit.append({'simulation':int(r.simulation),'path':path,'id':r.id,**meta})
        if (n+1)%500==0:print(f'Weekly calendars: {n+1}/{len(seasons)} players',flush=True)
    frame=pd.DataFrame(rows);frame.to_csv(out/'weekly_results.csv.gz',index=False,compression='gzip')
    pd.DataFrame(audit).to_csv(out/'weekly_template_audit.csv',index=False)
    prices=pd.read_csv(out/'generated_adp.csv')
    showcase=json.loads((out/'showcase_players.json').read_text())
    selected=[]
    for p in showcase['players']:
        price=prices[prices.player_id.eq(p['id'])].iloc[0].to_dict()
        calendars=[]
        for (simulation,path),g in frame[frame.id.eq(p['id'])].groupby(['simulation','path']):
            expected=seasons[seasons.id.eq(p['id']) & seasons.simulation.eq(simulation)].iloc[0]
            if not np.array_equal(g[CORE].sum().to_numpy(),expected[CORE].to_numpy()):raise AssertionError('Export totals differ')
            calendars.append({'simulation':int(simulation),'path':int(path),'season_ppr':float(expected.ppr),
                              'games':int(expected.games),'bye':int(g.bye_week.iloc[0]),'weeks':g.to_dict('records')})
        selected.append({**p,'draft':price,'weekly_seasons':calendars})
    data={'players':selected,'draft_board':prices.sort_values('adp').to_dict('records'),
          'calendar':'18 calendar weeks, 17 scheduled games, one shared schedule-group bye',
          'seed':seed,'room_assumption':'12 teams × 16 rounds; tail ADPs beyond data support are extrapolated'}
    (out/'draft_weekly_explorer.json').write_text(json.dumps(data,indent=2,allow_nan=False)+'\n')
    # Hard checks for every exported player and scenario, not just examples.
    grouped=frame.groupby(['simulation','id','path'])
    summed=grouped[CORE].sum().sort_index()
    expected=seasons.set_index(['simulation','id'])[CORE].reindex(summed.index.droplevel('path'))
    if not np.array_equal(summed.to_numpy(),expected.to_numpy()):raise AssertionError('Export conservation failure')
    checks={'players_per_season':seasons.groupby('simulation').size().to_dict(),
            'engine_fingerprint':weekly_engine_fingerprint(),
            'weekly_rows':len(frame),'calendars':len(seasons)*2,'weekly_paths_per_season':2,'all_stat_totals_conserved':True,
            'all_calendars_18_weeks':bool(grouped.size().eq(18).all()),
            'one_bye_each':bool(grouped.status.agg(lambda s:s.eq('BYE').sum()).eq(1).all()),
            'no_bye_production':bool(frame[frame.status.eq('BYE')][CORE].eq(0).all().all()),
            'same_group_same_bye':bool(frame.groupby('schedule_group').bye_week.nunique().eq(1).all())}
    (out/'weekly_export_checks.json').write_text(json.dumps(checks,indent=2)+'\n')
    return data,frame
