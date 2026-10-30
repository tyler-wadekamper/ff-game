"""Pinned public FantasyPros consensus archive, with explicit identity auditing.

The archive does not certify scoring or league size. Treat it as overall
consensus, not a guaranteed pure-PPR/12-team sample. Ignore its updated teams
and position labels; join independently to NFL identities/position history.
"""
from __future__ import annotations
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import unicodedata
import urllib.request
import numpy as np
import pandas as pd

REPO='jughkoop/fantasy-football-adps'
COMMIT='62009bf51773d37427da4e07c99d90339ff6e152'


def normalize(name):
    name=unicodedata.normalize('NFKD',str(name)).encode('ascii','ignore').decode().lower()
    name=re.sub(r'\b(jr|sr|ii|iii|iv|v)\b\.?','',name)
    return re.sub('[^a-z]','',name)


def download_adp(raw):
    raw=Path(raw)/'adp';raw.mkdir(parents=True,exist_ok=True)
    mpath=raw/'manifest.json';old=json.loads(mpath.read_text()) if mpath.exists() else {'files':{}}
    files={}
    for year in range(2015,2025):
        name=f'FantasyPros_{year}_Overall_ADP_Rankings.csv';path=raw/name
        url=f'https://raw.githubusercontent.com/{REPO}/{COMMIT}/{name}'
        if path.exists():
            digest=hashlib.sha256(path.read_bytes()).hexdigest()
            if old['files'].get(name,{}).get('sha256')!=digest:raise ValueError(f'ADP checksum mismatch: {name}')
            files[name]=old['files'][name];continue
        with urllib.request.urlopen(url,timeout=60) as response:content=response.read()
        if not content.startswith(b'"Rank"'):raise ValueError(f'Unexpected ADP schema: {name}')
        path.write_bytes(content)
        files[name]={'url':url,'sha256':hashlib.sha256(content).hexdigest(),'bytes':len(content),
                     'retrieved_at':datetime.now(timezone.utc).isoformat()}
        print(f'Downloaded ADP {year}: {len(content)} bytes',flush=True)
    m={'source':REPO,'commit':COMMIT,'upstream':'FantasyPros overall consensus',
       'format':'Archive does not certify scoring format or league size; not claimed to be pure PPR',
       'coverage':[2015,2024],'files':files}
    mpath.write_text(json.dumps(m,indent=2)+'\n');return m


def build_adp(raw,panel,output):
    raw,output=Path(raw),Path(output);output.mkdir(parents=True,exist_ok=True)
    all_players=pd.read_csv(raw/'players.csv',low_memory=False).dropna(subset=['gsis_id']).drop_duplicates('gsis_id')
    players=all_players.copy()
    eligible=set(panel.player_id)
    players=players[players.gsis_id.isin(eligible)].drop_duplicates('gsis_id')
    metadata=players.set_index('gsis_id');histories={p:g for p,g in panel.groupby('player_id')}
    explicit={'dellbeckham':'odellbeckham','greglsen':'gregolsen','aaronjonesr':'aaronjones'}
    aliases={}
    def add(name,pid):
        key=normalize(name)
        if key:aliases.setdefault(key,set()).add(pid)
    for r in players.itertuples():
        for field in ['display_name','football_name','short_name']:
            value=getattr(r,field,None)
            if pd.notna(value):add(value,r.gsis_id)
        for field in ['first_name','common_first_name','football_name']:
            first=getattr(r,field,None)
            if pd.notna(first):add(f'{first} {r.last_name}',r.gsis_id)
    for r in panel[['player_id','name']].drop_duplicates().itertuples():add(r.name,r.player_id)
    # Documented first-name variants, never fuzzy name matching.
    variants={'gabe':'gabriel','josh':'joshua','ken':'kenneth','jeff':'jeffery','rob':'robert','mitch':'mitchell','mike':'michael','steve':'steven'}
    for key,ids in list(aliases.items()):
        for short,long in variants.items():
            if key.startswith(long):aliases.setdefault(short+key[len(long):],set()).update(ids)
            if key.startswith(short):aliases.setdefault(long+key[len(short):],set()).update(ids)
    rows,issues,repairs=[],[],[]
    for year in range(2015,2025):
        path=raw/'adp'/f'FantasyPros_{year}_Overall_ADP_Rankings.csv'
        with path.open(newline='') as f:
            data=list(csv.reader(f))
        for fields in data[1:]:
            if not fields or not fields[0].strip().isdigit():continue
            rank=int(fields[0]);adp=float(fields[-1].replace(',',''))
            if adp>=1000:continue  # Archive's unranked sentinel, not an observed ADP.
            tokens=[(n,s) for n,s in enumerate(fields) if re.fullmatch(r'(QB|RB|WR|TE|K|DST)\d+',s.strip())]
            if not tokens:issues.append({'year':year,'rank':rank,'name':fields[1],'reason':'missing_position_token'});continue
            source_pos=re.match('[A-Z]+',tokens[0][1]).group()
            if source_pos in ['K','DST']:continue
            # A damaged 2015 row splits Le'Veon Bell across several columns.
            # Progressively join prefix fragments; stop at the first unique ID.
            candidates=set();name=fields[1].strip();fragments=[]
            for value in fields[1:tokens[0][0]]:
                if not value.strip() or re.fullmatch(r'[A-Z]{2,3}|\d+\s*',value.strip()):continue
                fragments.append(value.strip())
                key=normalize(' '.join(fragments));key=explicit.get(key,key)
                found=aliases.get(key,set())
                if found:
                    possible=panel[panel.player_id.isin(found)]
                    # Historical NFL activity/entry disambiguates duplicate names.
                    possible=possible[(possible.season<=year)&(possible.season>=year-2)]
                    viable=set(possible.player_id)
                    candidates=viable or found
                    if len(candidates)==1:break
            resolution='exact_or_documented_alias'
            if len(candidates)>1:
                same_position=set()
                for pid in candidates:
                    h=histories[pid];past=h[h.season<year]
                    pos=past.sort_values('season').position.iloc[-1] if len(past) else h.sort_values('season').position.iloc[0]
                    if pos==source_pos:same_position.add(pid)
                if same_position:candidates=same_position
                resolution='position_disambiguation'
            if len(candidates)>1:
                peaks={pid:float(histories[pid].loc[histories[pid].season<year,'ppr'].max()) for pid in candidates}
                ranked=sorted(peaks,key=lambda p:np.nan_to_num(peaks[p],nan=-1),reverse=True)
                if np.isfinite(peaks[ranked[0]]) and peaks[ranked[0]]>3*max(0,np.nan_to_num(peaks[ranked[1]]))+20:
                    candidates={ranked[0]};resolution='clearly_dominant_past_career_activity'
                else:
                    rookies=[pid for pid in candidates if pid in metadata.index and metadata.loc[pid,'rookie_season']==year]
                    if len(rookies)==len(candidates):
                        picks={pid:metadata.loc[pid,'draft_pick'] for pid in rookies}
                        order=sorted(picks,key=lambda p:float(picks[p]) if pd.notna(picks[p]) else 9999)
                        if pd.notna(picks[order[0]]) and pd.notna(picks[order[1]]) and float(picks[order[1]])-float(picks[order[0]])>=50:
                            candidates={order[0]};resolution='preseason_rookie_draft_capital'
            if len(candidates)!=1:
                issues.append({'year':year,'rank':rank,'name':name,'reason':'unmatched' if not candidates else 'ambiguous'});continue
            pid=next(iter(candidates));history=panel[(panel.player_id==pid)&(panel.season<=year)]
            if len(history):pos=history.sort_values('season').position.iloc[-1]
            else:pos=panel[panel.player_id==pid].sort_values('season').position.iloc[0]
            canonical=panel[panel.player_id==pid]['name'].iloc[0]
            if resolution!='exact_or_documented_alias' or normalize(name)!=normalize(canonical):
                repairs.append({'draft_year':year,'source_rank':rank,'source_name':name,'canonical_name':canonical,'method':resolution})
            rows.append({'draft_year':year,'player_id':pid,'name':canonical,'position':pos,'source_adp':adp,
                         'source_rank':rank,'archive_position':source_pos})
    frame=pd.DataFrame(rows).sort_values(['draft_year','source_rank'])
    frame['eligible_rank']=frame.groupby('draft_year').cumcount()+1
    frame.to_csv(output/'historical_adp.csv',index=False)
    pd.DataFrame(issues,columns=['year','rank','name','reason']).to_csv(output/'adp_join_issues.csv',index=False)
    pd.DataFrame(repairs).to_csv(output/'adp_join_repairs.csv',index=False)
    coverage=frame.groupby('draft_year').agg(matched=('player_id','size'),max_source_adp=('source_adp','max'))
    coverage.to_csv(output/'adp_coverage.csv')
    return frame,all_players
