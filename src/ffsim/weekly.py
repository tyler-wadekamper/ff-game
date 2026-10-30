"""Conditional weekly disaggregation: 18 calendar weeks, 17 games and a bye.

Season totals are inputs here (deliberately), unlike the preseason ADP model.
All integer stats, games and fantasy points are conserved exactly.
"""
from __future__ import annotations
from pathlib import Path
import hashlib
import numpy as np
import pandas as pd
from sklearn.neighbors import NearestNeighbors
from sklearn.preprocessing import StandardScaler

from .model import CORE,points

STATS=CORE[:-1]
INDEX={c:i for i,c in enumerate(STATS)}
YARDS={'passing_yards','rushing_yards','receiving_yards'}


def weekly_engine_fingerprint():
    paths=[Path(__file__),Path(__file__).with_name('weekly_validation.py')]
    return hashlib.sha256(b''.join(p.read_bytes() for p in paths)).hexdigest()


def team_name(value):
    return {'LA':'LAR','STL':'LAR','SD':'LAC','OAK':'LV','JAC':'JAX'}.get(str(value),str(value))


def allocate(total,weights,capacity=None,rng=None):
    """Integer proportional allocation with hard capacities and exact sum."""
    total=int(total);w=np.maximum(np.asarray(weights,float),0)
    cap=np.full(len(w),total,dtype=int) if capacity is None else np.asarray(capacity,int)
    if total<0 or np.any(cap<0) or cap.sum()<total:raise ValueError('Infeasible event total/capacities')
    result=np.zeros(len(w),int)
    while result.sum()<total:
        free=cap-result;mask=free>0
        p=np.where(mask,w,0)
        if p.sum()==0:p=mask.astype(float)
        proposal=(total-result.sum())*p/p.sum()
        added=np.minimum(np.floor(proposal).astype(int),free)
        if added.sum():result+=added;continue
        # At most n rounding units remain. Randomized tie-breaking only.
        jitter=np.zeros(len(w)) if rng is None else rng.uniform(0,1e-8,len(w))
        order=np.argsort(np.where(mask,proposal+jitter,-np.inf))[::-1]
        n=min(total-result.sum(),int(mask.sum()))
        result[order[:n]]+=1
    return result


def allocate_yards(total,events,source_yards,source_events,rng,allow_lateral=False):
    total=int(total);events=np.asarray(events,int)
    if events.sum()==0:
        out=np.zeros(len(events),int)
        if total:
            if not allow_lateral:raise ValueError('Passing yards with no completion')
            # NFL laterals can earn rush/receiving yards without a credited
            # carry/reception. Keep the yardage, without inventing a catch.
            w=np.abs(source_yards)+.01;out[int(rng.choice(len(out),p=w/w.sum()))]=total
        return out
    efficiency=np.divide(source_yards,source_events,out=np.zeros(len(events),float),where=source_events>0)
    fallback=total/events.sum()
    efficiency=np.where(source_events>0,efficiency,fallback)
    raw=events*efficiency
    if total>=0:
        negative=np.minimum(raw,0);positive=np.maximum(raw,0)
        if positive.sum()==0:positive=events.astype(float)
        baseline=negative+positive*(total-negative.sum())/positive.sum()
    else:
        # A negative net season is typically kneels/losses, not a reason to
        # subtract a huge offset from every otherwise-positive game.
        negative=np.maximum(-raw,0)
        if negative.sum()==0:negative=events.astype(float)
        baseline=negative*total/negative.sum()
    result=np.rint(baseline).astype(int)
    difference=total-int(result.sum())
    if difference:
        # Rounding must not create a negative game from a positive shape, or
        # a positive game from an entirely negative shape.
        capacity=(np.maximum(result,0) if total>=0 and difference<0 else
                  np.maximum(-result,0) if total<0 and difference>0 else None)
        units=allocate(abs(difference),events,capacity,rng)
        result+=np.sign(difference)*units
    return result


def sample_events(total,source_events,source_exposure,new_exposure,concentration,rng,capacity=None):
    """Smoothed per-opportunity rates, conditional on a fixed season event total.

    Do not multiply a single observed TD game into an 8-TD game. Historical
    counts inform a beta prior; new events are sampled across opportunities.
    """
    total=int(total);exposure=np.asarray(new_exposure,float)
    cap=np.asarray(new_exposure if capacity is None else capacity,int)
    if cap.sum()<total:raise ValueError('Infeasible rare-event capacity')
    p0=total/max(exposure.sum(),1)
    rate=(np.maximum(source_events,0)+concentration*p0)/(np.maximum(source_exposure,0)+concentration)
    weight=exposure*rate
    result=np.zeros(len(exposure),int)
    while result.sum()<total:
        free=cap-result;w=np.where(free>0,weight,0)
        if w.sum()==0:w=(free>0).astype(float)
        draw=rng.multinomial(total-int(result.sum()),w/w.sum())
        result+=np.minimum(draw,free)
    return result


def feature_vector(totals):
    x=np.asarray(totals,float);g=max(1,x[-1]);s=x[:-1]
    return np.r_[x[-1]/17,np.log1p(np.maximum(s[[0,5,8]],0)/g),
                  np.arcsinh(s[[2,6,10]]/g/10),
                  s[1]/max(10,s[0]),s[9]/max(10,s[8]),
                  s[3]/max(30,s[0]),s[7]/max(20,s[5]),s[11]/max(20,s[9])]


class WeeklyLibrary:
    def __init__(self,records,byes):self.records,self.byes=records,byes

    @classmethod
    def load(cls,raw,panel):
        raw=Path(raw);records=[];byes={}
        people=pd.read_csv(raw/'players.csv',usecols=['pfr_id','gsis_id']).dropna().drop_duplicates('pfr_id').set_index('pfr_id').gsis_id
        for year in range(2015,2026):
            horizon=18 if year>=2021 else 17
            data=pd.read_csv(raw/f'stats_{year}.csv',usecols=['player_id','season_type','week','team']+STATS)
            data=data[data.season_type.eq('REG')].fillna({c:0 for c in STATS})
            data['team']=data.team.map(team_name)
            team_weeks=data.groupby('team').week.agg(set).to_dict()
            bye={}
            for team,weeks in team_weeks.items():
                missing=set(range(1,horizon+1))-weeks
                plausible=[w for w in missing if 4<=w<=14]
                if len(plausible)==1:bye[team]=plausible[0]
                elif len(missing)==1:bye[team]=next(iter(missing))
            byes[year]=bye
            snaps=pd.read_csv(raw/f'snaps_{year}.csv',usecols=['pfr_player_id','game_type','week','team','offense_snaps','defense_snaps','st_snaps'])
            snaps=snaps[snaps.game_type.eq('REG')].copy()
            snaps['player_id']=snaps.pfr_player_id.map(people)
            snaps=snaps[(snaps.offense_snaps+snaps.defense_snaps+snaps.st_snaps)>0]
            snaps['team']=snaps.team.map(team_name)
            sg={p:g for p,g in snaps.groupby('player_id')}
            dg={p:g for p,g in data.groupby('player_id')}
            seasons=panel[(panel.season==year)&(panel.games>0)&(panel.games<=17)]
            for row in seasons.itertuples(index=False):
                games=dg.get(row.player_id);participation=sg.get(row.player_id)
                teams=set(games.team) if games is not None else set()
                if participation is not None:teams.update(participation.team)
                if len(teams)!=1:continue  # Traded players have ambiguous single-team byes.
                team=next(iter(teams))
                if team not in bye:continue
                values=np.zeros((horizon,len(STATS)))
                if games is not None:
                    for week,g in games.groupby('week'):values[int(week)-1]=g[STATS].sum().to_numpy(float)
                active=np.zeros(horizon,bool)
                if participation is not None:active[participation.week.astype(int).to_numpy()-1]=True
                handled=(values[:,0]+values[:,5]+values[:,8])>0
                active|=handled
                if int(active.sum())!=int(row.games) or active[bye[team]-1]:continue
                if not np.allclose(values.sum(axis=0),[getattr(row,c) for c in STATS]):continue
                keep=np.arange(horizon)!=(bye[team]-1)
                totals=np.r_[values.sum(axis=0),active.sum()]
                records.append({'id':row.player_id,'year':year,'position':row.position,'totals':totals,
                                'values':values[keep],'active':active[keep],
                                'bye':bye[team],'team':team})
            print(f'Weekly library {year}: {sum(r["year"]==year for r in records)} valid single-team seasons',flush=True)
        return cls(records,byes)


class WeeklyModel:
    def __init__(self,library,cutoff=2025,neighbors=16,shape_retention=None):
        self.cutoff,self.library,self.neighbors=cutoff,library,neighbors
        self.shape_retention=shape_retention or {p:1. for p in ['QB','RB','WR','TE']}
        self.groups={}
        self.event_concentration={}
        for pos in ['QB','RB','WR','TE']:
            records=[r for r in library.records if r['position']==pos and r['year']<=cutoff]
            x=np.asarray([feature_vector(r['totals']) for r in records])
            scaler=StandardScaler().fit(x)
            weights=np.ones(x.shape[1]);weights[0]=2.
            if pos!='QB':weights[[1,4,7,9]]=0
            else:weights[[3,6,8,11]]=0
            if pos in ['WR','TE']:weights[[2,5,10]]=.3
            # Match the role that supplies most fantasy production. Sparse
            # gadget carries must not outweigh a receiver's target workload.
            weights[{'QB':1,'RB':2,'WR':3,'TE':3}[pos]]=2.
            search=NearestNeighbors(n_neighbors=min(128,len(records))).fit(scaler.transform(x)*weights)
            self.groups[pos]=(records,scaler,weights,search)
            for child,parent in [('passing_tds','completions'),('receiving_tds','receptions'),('rushing_tds','carries'),
                                 ('passing_interceptions','attempts'),('sack_fumbles_lost','attempts'),
                                 ('rushing_fumbles_lost','carries'),('receiving_fumbles_lost','receptions')]:
                k,j=INDEX[child],INDEX[parent];excess=denominator=events=exposures=0.
                for r in records:
                    y=r['values'][r['active'],k];n=r['values'][r['active'],j]
                    if n.sum()<=0 or len(n)<4:continue
                    p=y.sum()/n.sum()
                    excess+=float(np.sum((y-n*p)**2)-(1-1/len(n))*np.sum(n*p*(1-p)))
                    denominator+=float(np.sum(n*np.maximum(n-1,0)));events+=float(y.sum());exposures+=float(n.sum())
                mean=events/max(exposures,1);variance=max(excess/max(denominator,1),1e-8)
                self.event_concentration[(pos,child)]=float(np.clip(mean*(1-mean)/variance-1,20,500))

    def template(self,totals,pos,rng,exclude_player=None):
        records,scaler,weights,search=self.groups[pos]
        distance,index=search.kneighbors(scaler.transform([feature_vector(totals)])*weights)
        candidates=[(float(d),records[i]) for d,i in zip(distance[0],index[0]) if records[i]['id']!=exclude_player]
        def workload(x):
            if pos=='QB':volume=x[0]
            elif pos in ['RB','TE']:volume=x[5]+x[8]
            else:volume=x[8]
            return volume/max(x[-1],1)
        volume=workload(totals)
        # Avoid transferring a low-volume reserve's single breakout game into
        # a much larger role (e.g. scaling 11 of 20 catches into 28 of 47).
        compatible=[(d,r) for d,r in candidates if volume<2 or .5<=workload(r['totals'])/volume<=2]
        if compatible:candidates=compatible
        candidates=candidates[:self.neighbors]
        if not candidates:raise ValueError('No independent weekly templates')
        d=np.array([x[0] for x in candidates]);band=max(np.median(d),.5)
        p=np.exp(-d*d/(2*band*band));p/=p.sum()
        return candidates[int(rng.choice(len(candidates),p=p))][1]

    def generate(self,totals,pos,bye,rng,exclude_player=None):
        total=np.asarray(totals,float)
        if total.shape!=(len(CORE),) or not np.isfinite(total).all() or not np.allclose(total,np.rint(total)):
            raise ValueError('Expected finite integer season statistics')
        total=np.rint(total).astype(int);g=int(total[-1])
        if not 0<=g<=17 or not 1<=bye<=18:raise ValueError('Invalid games/bye')
        for c,v in zip(STATS,total[:-1]):
            if c not in YARDS and v<0:raise ValueError('Negative event count')
        for child,parent in [('completions','attempts'),('receptions','targets'),('passing_tds','completions')]:
            if total[INDEX[child]]>total[INDEX[parent]]:raise ValueError(f'{child} exceeds {parent}')
        if total[4]>total[0]-total[1]:raise ValueError('Interceptions exceed incompletions')
        weekly=np.zeros((18,len(CORE)),int)
        if not g:
            if np.any(total[:-1]):raise ValueError('Production with zero games')
            return weekly,{'template_year':None,'template_id':None}
        record=self.template(total,pos,rng,exclude_player)
        available=record['active'].copy()
        if len(available)==16:
            k=int(rng.integers(16));available=np.insert(available,k,available[k])
        while int(available.sum())!=g:
            desired=int(available.sum())<g
            candidates=np.flatnonzero(available!=desired)
            # Extend or shrink existing availability blocks before inventing new ones.
            opposite=np.pad(available==desired,(1,1),constant_values=False)
            adjacency=opposite[candidates].astype(float)+opposite[candidates+2].astype(float)+.25
            chosen=int(rng.choice(candidates,p=adjacency/adjacency.sum()))
            available[chosen]=desired
        calendar=np.arange(18)!=bye-1
        active=np.flatnonzero(calendar)[available]
        source=record['values'][record['active']]
        # Preserve observed spikes and local sequences; permute two-game blocks.
        blocks=[np.arange(i,min(i+2,len(source))) for i in range(0,len(source),2)]
        order=np.concatenate([blocks[i] for i in rng.permutation(len(blocks))])
        indices=order[np.floor(np.arange(g)*len(source)/g).astype(int)]
        shape=source[indices]
        # Empirical-Bayes regularization: preserve the observed multivariate game
        # shape while shrinking its deviations toward this season's baseline.
        retention=float(self.shape_retention[pos])
        shape=retention*shape+(1-retention)*shape.mean(axis=0)
        out=np.zeros((g,len(STATS)),int)
        def weights(k):
            s=np.maximum(shape[:,k],0)
            return s+.05*max(float(s.mean()),1)
        for c in ['attempts','carries','targets']:
            k=INDEX[c];out[:,k]=allocate(total[k],weights(k),rng=rng)
        for c,parent in [('completions','attempts'),('receptions','targets')]:
            k,j=INDEX[c],INDEX[parent];out[:,k]=allocate(total[k],weights(k),out[:,j],rng)
        out[:,3]=sample_events(total[3],shape[:,3],shape[:,1],out[:,1],self.event_concentration[(pos,'passing_tds')],rng)
        out[:,4]=sample_events(total[4],shape[:,4],np.maximum(shape[:,0]-shape[:,1],0),out[:,0]-out[:,1],self.event_concentration[(pos,'passing_interceptions')],rng)
        for yards,events in [('passing_yards','completions'),('rushing_yards','carries'),('receiving_yards','receptions')]:
            k,j=INDEX[yards],INDEX[events]
            out[:,k]=allocate_yards(total[k],out[:,j],shape[:,k],shape[:,j],rng,allow_lateral=yards!='passing_yards')
        for c,parent,yards in [('receiving_tds','receptions','receiving_yards'),('rushing_tds','carries','rushing_yards')]:
            k,j=INDEX[c],INDEX[parent];capacity=out[:,j].copy()
            extra=max(0,int(total[k]-capacity.sum()))
            if extra:
                # A lateral recipient can score without a credited reception or
                # carry (e.g. Josh Allen's 2024 receiving TD). Keep it on a
                # yardage-bearing week whenever possible, without inventing a catch.
                possible=np.flatnonzero(out[:,INDEX[yards]]!=0)
                where=int(rng.choice(possible)) if len(possible) else int(rng.integers(g))
                capacity[where]+=extra
            exposure=out[:,j] if not extra else capacity
            out[:,k]=sample_events(total[k],shape[:,k],shape[:,j],exposure,self.event_concentration[(pos,c)],rng,capacity)
        for c,parent in [('sack_fumbles_lost','attempts'),('rushing_fumbles_lost','carries'),('receiving_fumbles_lost','receptions')]:
            k,j=INDEX[c],INDEX[parent]
            # A sack is not a pass attempt: gadget passers can lose a strip
            # fumble with zero recorded attempts. Sacks are not in CORE.
            capacity=out[:,j]+2 if c=='sack_fumbles_lost' else out[:,j]
            out[:,k]=sample_events(total[k],shape[:,k],shape[:,j],capacity,self.event_concentration[(pos,c)],rng,capacity)
        weekly[active,:-1]=out;weekly[active,-1]=1
        if not np.array_equal(weekly.sum(axis=0),total):raise AssertionError('Weekly conservation failed')
        return weekly,{'template_year':record['year'],'template_id':record['id']}
