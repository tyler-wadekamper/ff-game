"""History-only draft prices from historical market comparables.

No generated future season is an input. Unlisted players are right-censored,
not treated as if an observed late-round ADP existed for them.
"""
from __future__ import annotations
import json
from pathlib import Path
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.neighbors import NearestNeighbors
from sklearn.preprocessing import StandardScaler

from .data import add_derived

LIMIT=216
FEATURES=['age','visible_years','last_ppr17','last_ppg','last_games','mean2','mean3','max3','trend',
          'attempts_pg','carries_pg','targets_pg','passing_ypg','rushing_ypg','receiving_ypg',
          'td_pg','out_weeks','mean_participation','years_since_last','no_history']


def history_vector(history,age,draft_year):
    history=history[history.season<draft_year].sort_values('season')
    if not len(history):return np.r_[age,0,np.zeros(16),0,1].astype(float)
    # Calendar windows matter: a 2021 breakout followed by a 2025 zero row is
    # not a two-season history. Fill intervening years with zero production.
    years=range(max(2015,draft_year-3),draft_year)
    tail=history.set_index('season').reindex(years)
    for c in ['ppr17','ppr','games','attempts','carries','targets','passing_yards','rushing_yards',
              'receiving_yards','passing_tds','rushing_tds','receiving_tds','report_out_weeks']:
        tail[c]=tail[c].fillna(0)
    tail['scheduled_games']=np.where(tail.index>=2021,17,16)
    row=tail.iloc[-1];g=max(float(row.games),1)
    previous=float(tail.iloc[-2].ppr17) if len(tail)>1 else float(row.ppr17)
    produced=history[(history.attempts+history.carries+history.targets)>0]
    gap=draft_year-int(produced.season.max())-1 if len(produced) else 5
    return np.array([age,len(history),row.ppr17,row.ppr/g,row.games,tail.tail(2).ppr17.mean(),
                     tail.ppr17.mean(),tail.ppr17.max(),row.ppr17-previous,
                     row.attempts/g,row.carries/g,row.targets/g,row.passing_yards/g,row.rushing_yards/g,row.receiving_yards/g,
                     (row.passing_tds+row.rushing_tds+row.receiving_tds)/g,row.report_out_weeks,
                     (tail.games/tail.scheduled_games).mean(),gap,0],float)


def market_panel(panel,adp,players):
    metadata=players.set_index('gsis_id');rows=[]
    histories={pid:g for pid,g in panel.groupby('player_id')}
    for year in range(2016,2025):
        market=adp[adp.draft_year==year].drop_duplicates('player_id').set_index('player_id')
        # Drafted rookies are publicly known before the season. Include unpriced
        # rookies too, rather than learning only from the successful draft names.
        rookies=players[(players.draft_year==year)&players.position.isin(['QB','RB','FB','WR','TE'])]
        ids=set(panel.loc[panel.season==year-1,'player_id'])|set(market.index)|set(rookies.gsis_id)
        for pid in sorted(ids):
            history=histories.get(pid,panel.iloc[:0]);past=history[history.season<year]
            if pid in market.index:pos=market.loc[pid,'position'];name=market.loc[pid,'name']
            elif len(past):pos=past.position.iloc[-1];name=past['name'].iloc[-1]
            else:pos=metadata.loc[pid,'position'];name=metadata.loc[pid,'display_name']
            if pos=='FB':pos='RB'
            birth=pd.to_datetime(metadata.loc[pid,'birth_date'],errors='coerce') if pid in metadata.index else pd.NaT
            age=(pd.Timestamp(year,9,1)-birth).days/365.2425 if pd.notna(birth) else (past.age.iloc[-1]+1 if len(past) else 24)
            rank=float(market.loc[pid,'eligible_rank']) if pid in market.index else np.nan
            source=float(market.loc[pid,'source_adp']) if pid in market.index else np.nan
            vector=np.nan_to_num(history_vector(past,float(age),year),nan=0)
            rows.append({'player_id':pid,'position':pos,'name':name,'draft_year':year,'observed':pd.notna(rank),
                         'eligible_rank':rank,'source_adp':source,'target':np.log(min(rank,LIMIT)) if pd.notna(rank) else np.log(LIMIT),
                         **dict(zip(FEATURES,vector))})
    return pd.DataFrame(rows)


class ADPModel:
    def __init__(self,cutoff=2024,neighbors=12):self.cutoff,self.neighbors,self.groups=cutoff,neighbors,{}

    def fit(self,data):
        self.training=data[data.draft_year<=self.cutoff].copy()
        for pos,g in self.training.groupby('position'):
            g=g.reset_index(drop=True)
            x=g[FEATURES].to_numpy(float)
            # Heavy-tailed totals are compressed; positive/negative trends retained.
            x=np.arcsinh(x/np.array([5,3,60,5,8,60,60,80,60,10,5,5,100,30,40,1,2,.5,1,1]))
            scaler=StandardScaler().fit(x)
            w=np.ones(len(FEATURES));w[[0,1,16,18,19]]=.6
            # Rare gadget throws must not dominate RB/WR/TE similarity merely
            # because their within-position variance is tiny.
            if pos!='QB':w[[9,12]]=0
            else:w[[11,14]]=0
            if pos in ['WR','TE']:w[[10,13]]=.3
            search=NearestNeighbors(n_neighbors=min(128,len(g))).fit(scaler.transform(x)*w)
            self.groups[pos]=(g,scaler,w,search)
        return self

    def estimate(self,data,exclude_player=False):
        predictions=np.zeros(len(data));comps=[None]*len(data)
        for pos,indices in data.groupby('position').indices.items():
            g,scaler,w,search=self.groups[pos]
            x=np.arcsinh(data.iloc[indices][FEATURES].to_numpy(float)/np.array([5,3,60,5,8,60,60,80,60,10,5,5,100,30,40,1,2,.5,1,1]))
            distances,ids=search.kneighbors(scaler.transform(x)*w)
            for index,d,candidates in zip(indices,distances,ids):
                if exclude_player:
                    keep=g.iloc[candidates].player_id.ne(data.iloc[index].player_id).to_numpy();d,candidates=d[keep],candidates[keep]
                candidates,d=candidates[:self.neighbors],d[:self.neighbors]
                band=max(float(np.median(d)),.5);weights=np.exp(-d*d/(2*band*band));weights/=weights.sum()
                predictions[index]=np.dot(weights,g.iloc[candidates].target)
                comps[index]=g.iloc[candidates[:3]][['name','draft_year','source_adp','eligible_rank','last_ppr17','last_games','age','observed']].replace({np.nan:None}).to_dict('records')
        return predictions,comps


def evaluate_adp(data,neighbors=12,output=None):
    model=ADPModel(2022,neighbors).fit(data);test=data[data.draft_year>=2023].copy().reset_index(drop=True)
    priority,_=model.estimate(test);test['priority']=priority
    records=[];individual=[]
    for year,g in test.groupby('draft_year'):
        g=g.copy();g['estimated_rank']=g.priority.rank(method='first')
        individual.append(g)
        for cohort in ['all','has_prior_nfl_history']:
            observed=g[g.observed & (g.eligible_rank<=192)]
            if cohort!='all':observed=observed[observed.no_history==0]
            records.append({'draft_year':year,'cohort':cohort,'n_observed_top192':len(observed),
                        'rank_spearman':spearmanr(observed.eligible_rank,observed.estimated_rank).statistic,
                        'rank_mae':abs(observed.eligible_rank-observed.estimated_rank).mean(),
                        **{f'top{k}_overlap':len(set(g.nsmallest(k,'priority').player_id)&set(g[g.eligible_rank<=k].player_id))/k for k in [24,60,120]}})
    if output is not None:pd.concat(individual).to_csv(Path(output)/'adp_validation_individual.csv',index=False)
    return pd.DataFrame(records)


def fit_and_assign(panel,adp,players,database,output,seed=20261030):
    output=Path(output);data=market_panel(panel,adp,players)
    data.to_csv(output/'adp_training_features.csv',index=False)
    # Choose neighborhood using earlier market years only; preserve new ADP audit.
    development=[]
    for k in [6,12,24]:
        model=ADPModel(2019,k).fit(data);test=data[data.draft_year.between(2020,2022)].reset_index(drop=True)
        scores,_=model.estimate(test);test['priority']=scores
        rho=[]
        for year,g in test.groupby('draft_year'):
            g=g.copy();g['predicted']=g.priority.rank(method='first');g=g[g.observed & (g.eligible_rank<=192)]
            rho.append(spearmanr(g.eligible_rank,g.predicted).statistic)
        development.append({'neighbors':k,'development_spearman':float(np.mean(rho))})
    k=int(max(development,key=lambda r:r['development_spearman'])['neighbors'])
    pd.DataFrame(development).to_csv(output/'adp_development.csv',index=False)
    evaluation=evaluate_adp(data,k,output);evaluation.to_csv(output/'adp_validation.csv',index=False)
    model=ADPModel(2024,k).fit(data)
    queries=[]
    for p in database['players']:
        records=[]
        for h in p['history']:
            records.append({'season':2025+h['relative_season'],'position':p['position'],**h,'report_out_weeks':h['listed_out_weeks'] or 0})
        history=add_derived(pd.DataFrame(records)) if records else pd.DataFrame(columns=['season'])
        x=history_vector(history,p['age']+1,2026)
        queries.append({'player_id':p['id'],'position':p['position'],'age':p['age']+1,**dict(zip(FEATURES,np.nan_to_num(x)))})
    queries=pd.DataFrame(queries);priority,comps=model.estimate(queries)
    order=np.argsort(priority,kind='stable');ordinal=np.empty(len(queries),int);ordinal[order]=np.arange(1,len(queries)+1)
    # Price spacing is an empirical market-curve constraint; ordering is learned.
    curves=[]
    for year,g in adp[adp.draft_year>=2016].groupby('draft_year'):
        eligible=g.sort_values('eligible_rank');adjusted=eligible.source_adp-(eligible.source_rank-eligible.eligible_rank)
        curves.append(np.interp(np.arange(1,LIMIT+1),eligible.eligible_rank,adjusted))
    curve=np.maximum.accumulate(np.mean(curves,axis=0));curve=np.maximum(curve,np.arange(1,LIMIT+1)*.8)
    price=np.where(ordinal<=LIMIT,curve[np.minimum(ordinal,LIMIT)-1],ordinal.astype(float))
    # Room-level uncertainty is a declared game knob, not an observed mock-draft SD.
    rng=np.random.default_rng(seed);sigma=np.where(ordinal<=24,.12,np.where(ordinal<=120,.18,.25))
    scores=-np.log(price)[None,:]+rng.normal(size=(1000,len(price)))*sigma
    ranks=np.empty_like(scores,dtype=int)
    for n,row in enumerate(scores):ranks[n,np.argsort(-row)]=np.arange(1,len(price)+1)
    result=queries[['player_id','position']].copy();result['age']=queries.age.astype(int)
    result['adp']=ranks.mean(axis=0);result['rank']=pd.Series(result.adp).rank(method='first').astype(int)
    result['pick_p10']=np.quantile(ranks,.1,axis=0);result['pick_p90']=np.quantile(ranks,.9,axis=0)
    result['drafted_probability_192']=(ranks<=192).mean(axis=0)
    result['within_observed_market_range']=ordinal<=LIMIT
    result['round_12_team']=np.ceil(result.adp/12).astype(int)
    result.sort_values('adp').to_csv(output/'generated_adp.csv',index=False)
    (output/'adp_comparables.json').write_text(json.dumps(dict(zip(queries.player_id,comps)),indent=2,allow_nan=False)+'\n')
    enrich=result.set_index('player_id').to_dict('index')
    extended={'players':[{**p,'draft':enrich[p['id']]} for p in database['players']]}
    (output/'player_database_with_adp.json').write_text(json.dumps(extended,indent=2,allow_nan=False)+'\n')
    (output/'adp_protocol.json').write_text(json.dumps({'source_years':[2015,2024],'training_years':[2016,2022],
        'audit_years':[2023,2024],'selected_neighbors':k,'features':FEATURES,'censoring_at_eligible_pick':LIMIT,
        'format':'Overall FantasyPros consensus archive; scoring/league-size not certified',
        'tail':'Ranks beyond observed support are extrapolated queue positions, not measured historical ADPs',
        'draft_noise':'Declared game-room log-score SD: .12 top24, .18 top120, .25 beyond; not empirically claimed',
        'spacing':'Observed consensus ADP curve calibrates spacing; independently held-out audit evaluates ordering'},indent=2)+'\n')
    return result,evaluation
