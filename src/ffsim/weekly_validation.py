"""Conditional distribution audits; season totals are known, weekly paths are not."""
import json
from pathlib import Path
import numpy as np
import pandas as pd
from scipy.stats import wasserstein_distance

from .model import CORE,points
from .weekly import WeeklyModel,weekly_engine_fingerprint


def longest_gap(played):
    best=run=0
    for p in played:
        run=0 if p else run+1;best=max(best,run)
    return best


def diagnostics(weekly,bye=None):
    active=weekly[:,-1]>0;values=points(weekly);x=values[active]
    mean=float(x.mean()) if len(x) else 0
    positive=np.maximum(x,0);den=max(float(positive.sum()),1)
    lag=float(np.corrcoef(x[:-1],x[1:])[0,1]) if len(x)>4 and np.std(x[:-1])>0 and np.std(x[1:])>0 else 0.
    game_mask=active if bye is None else np.delete(active,bye-1)
    return {'cv':float(x.std()/max(abs(mean),5)),'weekly_sd':float(x.std()),'max_share':float(positive.max()/den) if len(x) else 0,
            'top3_share':float(np.sort(positive)[-3:].sum()/den),'boom':float(np.mean(x>1.5*mean)) if len(x) else 0,
            'bust':float(np.mean(x<.5*mean)) if len(x) else 0,'lag1':lag,
            'longest_gap':longest_gap(game_mask),'weekly_p95':float(np.quantile(x,.95)) if len(x) else 0}


def relevant_record(r):
    x=r['totals'];p=r['position']
    return x[-1]>=4 and ((p=='QB' and x[0]>=100) or (p=='RB' and x[5]+x[8]>=75)
                          or (p=='WR' and x[8]>=40) or (p=='TE' and x[8]>=25))


def evaluate_weekly(library,output,cutoff=2022,years=(2023,2024,2025),draws=20,prefix='weekly_validation',retention=None):
    model=WeeklyModel(library,cutoff,shape_retention=retention)
    targets=[r for r in library.records if r['year'] in years and relevant_record(r)]
    rng=np.random.default_rng(20261030);rows=[];distributions={p:{'real':[],'generated':[]} for p in ['QB','RB','WR','TE']}
    conserved=0
    for n,r in enumerate(targets):
        actual=np.column_stack([r['values'],r['active']])
        observed=diagnostics(actual)
        samples=[]
        for _ in range(draws):
            y,metadata=model.generate(r['totals'],r['position'],r['bye'],rng,exclude_player=r['id'])
            if metadata['template_year']>cutoff or metadata['template_id']==r['id']:raise AssertionError('Template leakage')
            if not np.array_equal(y.sum(axis=0),r['totals']):raise AssertionError('Conservation failure')
            conserved+=1;samples.append(diagnostics(y,r['bye']))
            distributions[r['position']]['generated'].extend(points(y)[y[:,-1]>0].tolist())
        distributions[r['position']]['real'].extend(points(actual)[actual[:,-1]>0].tolist())
        record={'player_id':r['id'],'position':r['position'],'season':r['year'],'games':int(r['totals'][-1])}
        record.update({f'real_{k}':v for k,v in observed.items()})
        record.update({f'generated_{k}':np.mean([s[k] for s in samples]) for k in observed})
        rows.append(record)
        if (n+1)%100==0:print(f'{prefix}: {n+1}/{len(targets)} seasons, {conserved} paths conserved',flush=True)
    frame=pd.DataFrame(rows);frame.to_csv(Path(output)/f'{prefix}_individual.csv',index=False)
    summary,checks=[],[]
    for pos,g in frame.groupby('position'):
        for metric in ['cv','weekly_sd','max_share','top3_share','boom','bust','lag1','longest_gap','weekly_p95']:
            real=float(g[f'real_{metric}'].mean());gen=float(g[f'generated_{metric}'].mean());delta=gen-real
            # Whole-player resampling retains dependence across seasons.
            by_player=g.assign(delta=g[f'generated_{metric}']-g[f'real_{metric}']).groupby('player_id').agg(total=('delta','sum'),n=('delta','size'))
            brng=np.random.default_rng(55);idx=brng.integers(len(by_player),size=(1000,len(by_player)))
            boot=by_player.total.to_numpy()[idx].sum(axis=1)/by_player.n.to_numpy()[idx].sum(axis=1)
            summary.append({'position':pos,'metric':metric,'n_seasons':len(g),'real':real,'generated':gen,
                            'difference':delta,'difference_ci_low':np.quantile(boot,.025),'difference_ci_high':np.quantile(boot,.975)})
            if metric in ['cv','weekly_sd','weekly_p95']:error=abs(delta)/max(real,.01);limit=.20
            else:error=abs(delta);limit={'max_share':.08,'top3_share':.10,'boom':.10,'bust':.10,'lag1':.15,'longest_gap':1.0}[metric]
            checks.append({'position':pos,'metric':metric,'error':error,'limit':limit,'passed':bool(error<=limit)})
    tails=[]
    for pos,d in distributions.items():
        real=np.asarray(d['real']);gen=np.asarray(d['generated'])
        for metric,actual,synthetic,limit,relative in [
            ('pooled_p99',float(np.quantile(real,.99)),float(np.quantile(gen,.99)),.20,True),
            ('over40_rate',float(np.mean(real>40)),float(np.mean(gen>40)),.005,False),
            ('pooled_p999',float(np.quantile(real,.999)),float(np.quantile(gen,.999)),.20,True),
            ('over60_rate',float(np.mean(real>60)),float(np.mean(gen>60)),.00025,False)]:
            error=abs(synthetic-actual)/(max(actual,.01) if relative else 1)
            tails.append({'position':pos,'metric':metric,'real':actual,'generated':synthetic,'error':error,'limit':limit,'passed':bool(error<=limit)})
            checks.append({'position':pos,'metric':metric,'error':error,'limit':limit,'passed':bool(error<=limit)})
    pd.DataFrame(tails).to_csv(Path(output)/f'{prefix}_tails.csv',index=False)
    pd.DataFrame(summary).to_csv(Path(output)/f'{prefix}_metrics.csv',index=False)
    pd.DataFrame(checks).to_csv(Path(output)/f'{prefix}_checks.csv',index=False)
    np.savez_compressed(Path(output)/f'{prefix}_distributions.npz',**{p+'_'+k:np.array(v) for p,d in distributions.items() for k,v in d.items()})
    Path(output,f'{prefix}_protocol.json').write_text(json.dumps({'cutoff':cutoff,'years':list(years),
        'engine_fingerprint':weekly_engine_fingerprint(),
        'draws_per_season':draws,'paths_conserved':conserved,'seasons':len(targets),'same_player_templates':'excluded',
        'calendar':'18 calendar weeks; one bye; exactly given participation count',
        'scope':'Qualified single-team seasons with independently reconciled snaps and box scores',
        'conditioning':'Season totals are deliberately known; variance/tails/timing are audited, not the tautological mean'},indent=2)+'\n')
    return pd.DataFrame(summary),pd.DataFrame(checks)


def calibrate_weekly(library,output):
    """Reproduce the two moment corrections using development seasons only."""
    retention={p:1. for p in ['QB','RB','WR','TE']}
    prefixes=['weekly_development','weekly_calibrated_development','weekly_final_development']
    for step,prefix in enumerate(prefixes):
        summary,_=evaluate_weekly(library,output,cutoff=2020,years=(2021,2022),draws=5,prefix=prefix,retention=retention)
        if step<2:
            for row in summary[summary.metric=='cv'].itertuples():
                retention[row.position]=float(np.clip(retention[row.position]*row.real/row.generated,.5,1))
    config={'shape_retention':retention,'calibration':'Two method-of-moments CV correction passes, 2021–22 only, templates through 2020',
            'engine_fingerprint':weekly_engine_fingerprint()}
    Path(output,'weekly_config.json').write_text(json.dumps(config,indent=2)+'\n')
    return config


def audit_weekly_structure(library,output,retention):
    """Exercise every reconciled corpus season, including tiny/rare stat lines."""
    model=WeeklyModel(library,2025,shape_retention=retention)
    rng=np.random.default_rng(712);failures=[]
    for n,r in enumerate(library.records):
        try:
            y,_=model.generate(r['totals'],r['position'],r['bye'],rng,exclude_player=r['id'])
            if not np.array_equal(y.sum(axis=0),r['totals']):raise AssertionError('Season totals')
            if np.any(y[r['bye']-1]):raise AssertionError('Bye production')
            if np.any(y[y[:,-1]==0]):raise AssertionError('Nonparticipation production')
            if np.any(y[:,1]>y[:,0]) or np.any(y[:,9]>y[:,8]):raise AssertionError('Event capacity')
            if not np.isclose(points(y).sum(),points(r['totals'][None,:])[0]):raise AssertionError('PPR sum')
        except (ValueError,AssertionError) as exc:
            failures.append({'player_id':r['id'],'season':r['year'],'error':str(exc)})
        if (n+1)%1000==0:print(f'Weekly corpus accounting: {n+1}/{len(library.records)}',flush=True)
    result={'seasons':len(library.records),'failed':len(failures),'failures':failures,'engine_fingerprint':weekly_engine_fingerprint()}
    Path(output,'weekly_structural_audit.json').write_text(json.dumps(result,indent=2)+'\n')
    return result
