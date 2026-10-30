"""Package the researched player pool and private, conserving game worlds.

The HTTP server exposes catalog.json only. worlds.json.gz is server-private.
No NFL downloads are needed to play the packaged game.
"""
from pathlib import Path
import argparse
import gzip
import hashlib
import json
import numpy as np
import pandas as pd
from .model import CORE,points
from .weekly import WeeklyLibrary,WeeklyModel,weekly_engine_fingerprint

FIRST='Adrian Blake Camden Darius Ellis Finn Grayson Hayes Isaac Jalen Kai Landon Mason Nico Owen Parker Quinn Roman Silas Tate Vincent Wesley Xavier Zane Avery Brooks Cole Devon Emery Felix Grant Holden Ivan Jordan Kieran Logan Miles Nolan Orion Preston Reese Sawyer Theo Vaughn Warren Zion'.split()
LAST='Archer Banks Barrett Bellamy Bishop Booker Briggs Brooks Calder Carter Chase Clarke Cole Cross Dalton Ellis Everett Finch Fletcher Ford Foster Gaines Gray Hale Harper Hayes Holloway Holt James Knox Lane Lawson Marsh Mercer Monroe Morgan Nash North Palmer Pierce Porter Reed Rhodes Rivers Rowan Shaw Sinclair Slater Stone Sutton Tanner Tate Vaughn Vale Walker Ward Wells West Wilder Winslow Wolfe Woods York Young'.split()


def export_game(root,worlds=12,seed=20261101):
    root=Path(root);out=root/'game/data';out.mkdir(parents=True,exist_ok=True)
    db=json.loads((root/'artifacts/player_database_with_adp.json').read_text())
    schedule=pd.read_csv(root/'artifacts/weekly_results.csv.gz',usecols=['id','schedule_group','bye_week']).drop_duplicates('id').set_index('id')
    players=[]
    for n,p in enumerate(sorted(db['players'],key=lambda p:p['id'])):
        code=n*197%(len(FIRST)*len(LAST));h=p['history'];recent=h[-3:][::-1]
        weights=np.array([.6,.3,.1][:len(recent)]);weights/=weights.sum()
        # An intentionally fallible public scouting estimate, not next-season truth.
        ppg=float(sum(w*row['ppr']/max(1,row['games']) for w,row in zip(weights,recent)))
        participation=float(sum(w*min(row['games']/17,1) for w,row in zip(weights,recent)))
        players.append({'id':p['id'],'name':FIRST[code//len(LAST)]+' '+LAST[code%len(LAST)],
                        'position':p['position'],'age':p['age']+1,'history':h,
                        'adp':p['draft']['adp'],'adpRank':p['draft']['rank'],
                        'basePpg':round(max(0,ppg)*(.8+.2*participation),3),
                        'bye':int(schedule.loc[p['id'],'bye_week']),
                        'club':int(schedule.loc[p['id'],'schedule_group'])})
    players.sort(key=lambda p:p['adp'])
    version=hashlib.sha256(json.dumps(players,sort_keys=True).encode()).hexdigest()[:16]
    catalog={'version':version,'players':players,'scoring':'Full PPR · 4 pt passing TD · no return/2-point bonuses',
             'slots':['QB','RB','RB','WR','WR','TE','FLEX','FLEX'],'rosterSize':16,'calendarWeeks':18}
    (out/'catalog.json').write_text(json.dumps(catalog,separators=(',',':'),allow_nan=False)+'\n')
    panel=pd.read_csv(root/'data/processed/player_seasons.csv')
    # Rebuild from source CSVs; do not deserialize untrusted pickle data.
    library=WeeklyLibrary.load(root/'data/raw',panel)
    config=json.loads((root/'artifacts/weekly_config.json').read_text())
    if config['engine_fingerprint']!=weekly_engine_fingerprint():raise ValueError('Rebuild weekly calibration first')
    model=WeeklyModel(library,2025,shape_retention=config['shape_retention'])
    ensemble=pd.read_csv(root/'artifacts/league_seasons.csv');available=sorted(ensemble.simulation.unique())
    selected=np.random.default_rng(seed).choice(available,size=min(worlds,len(available)),replace=False)
    ids={p['id'] for p in players};private=[]
    for number,simulation in enumerate(selected):
        rows=ensemble[(ensemble.simulation==simulation)&ensemble.id.isin(ids)].set_index('id')
        if set(rows.index)!=ids:raise ValueError('Incomplete starting-pool season')
        world={}
        for n,p in enumerate(players):
            target=rows.loc[p['id'],CORE].to_numpy(float)
            weekly,_=model.generate(target,p['position'],p['bye'],np.random.default_rng(seed+number*10000+n))
            if not np.array_equal(weekly.sum(axis=0),target):raise AssertionError('World conservation')
            world[p['id']]=np.column_stack([np.rint(points(weekly)*100).astype(int),weekly]).astype(int).tolist()
        private.append(world)
        print(f'Game world {number+1}/{len(selected)}: {len(world)} players; all totals conserved',flush=True)
    payload={'version':version,'columns':['ppr_cents']+CORE,'worlds':private}
    with gzip.open(out/'worlds.json.gz','wt') as f:json.dump(payload,f,separators=(',',':'))
    checks={'worlds':len(private),'players_per_world':len(players),'calendars':len(players)*len(private),
            'all_18_weeks':True,'all_season_totals_conserved':True,'seed':seed,
            'source_simulations':[int(s) for s in selected],'engine_fingerprint':weekly_engine_fingerprint(),
            'version':version,'private_worlds_served_over_http':False}
    (out/'export_checks.json').write_text(json.dumps(checks,indent=2)+'\n')
    print(json.dumps(checks,indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=Path.cwd())
    parser.add_argument('--worlds',type=int,default=12)
    args=parser.parse_args();export_game(args.root,args.worlds)
