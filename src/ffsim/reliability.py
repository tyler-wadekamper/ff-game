"""Game realism checks: population margins, conditional changes and diversity.

These check fidelity to an empirical design target, not predictive skill or a
claim of independent discovery. The historical forecast audit is separate.
"""
from __future__ import annotations

import json
from pathlib import Path
import numpy as np
import pandas as pd
from scipy.stats import spearmanr, wasserstein_distance

from .data import transitions
from .league import season_index
from .model import relevant


def ranked(values,n=100):
    values=np.sort(np.asarray(values,float))[::-1]
    return np.pad(values[:n],(0,max(0,n-len(values))))


def assess(panel,output):
    output=Path(output)
    generated=pd.read_csv(output/'league_seasons.csv')
    current=pd.read_csv(output/'fictional_population.csv')
    showcase=json.loads((output/'showcase_players.json').read_text())
    from .league import engine_fingerprint
    if showcase.get('engine_fingerprint')!=engine_fingerprint():
        raise ValueError('Saved ensemble is stale for the current engine; run ff-data generate')
    scales=showcase['scales']
    checks,metrics,conditional,curves=[],[],[],{}
    real=panel[panel.season>=2021]
    pairs=transitions(panel)
    pairs=pairs[pairs.target_season>=2021]
    def check(name,pos,value,limit,passed,description):
        checks.append({'check':name,'position':pos,'value':float(value),'limit':str(limit),
                       'passed':bool(passed),'description':description})
    for pos in ['QB','RB','WR','TE']:
        historical=real[real.position.eq(pos)]
        future=generated[generated.position.eq(pos)]
        observed_curves=np.array([ranked(g.ppr17) for _,g in historical.groupby('season')])
        sampled_curves=np.array([ranked(g.ppr) for _,g in future.groupby('simulation')])
        observed_mean=observed_curves.mean(axis=0)
        sampled_mean=sampled_curves.mean(axis=0)
        rank_error=float(np.mean(abs(sampled_mean-observed_mean))/scales[pos]*100)
        top12_error=float(abs(sampled_mean[:12].mean()-observed_mean[:12].mean())/scales[pos]*100)
        check('mean_rank_curve_score_error',pos,rank_error,'<=4',rank_error<=4,'Mean absolute difference over ranks 1–100 on fixed score scale')
        check('top12_mean_score_error',pos,top12_error,'<=8',top12_error<=8,'Elite population production; fixed training-based scale')
        odd=sampled_curves[::2].mean(axis=0);even=sampled_curves[1::2].mean(axis=0)
        seed_error=float(np.mean(abs(odd-even))/scales[pos]*100)
        check('independent_seed_batches',pos,seed_error,'<=3',seed_error<=3,'Odd/even replicate rank curves agree')
        active=future[future.rostered_next]
        realzero=historical.groupby('season').opportunities.agg(lambda s:(s==0).mean())
        genzero=active.groupby('simulation').apply(lambda g:((g.attempts+g.carries+g.targets)==0).mean(),include_groups=False)
        zero_error=abs(float(genzero.mean()-realzero.mean()))
        check('active_pool_zero_fraction_error',pos,zero_error,'<=0.03',zero_error<=.03,'Zero offensive production among rostered players; unrostered players excluded')
        # Independent of score display clipping: check raw PPR and workloads.
        primary={'QB':'attempts','RB':'carries','WR':'targets','TE':'targets'}[pos]
        realtotal=historical.groupby('season')[primary].sum().mean()
        gentotal=future.groupby('simulation')[primary].sum().mean()
        volume_error=abs(gentotal/realtotal-1)
        check('total_opportunity_budget_error',pos,volume_error,'<=0.05',volume_error<=.05,'Position opportunity volume versus modern empirical population')
        old=current[current.position.eq(pos)]
        joined=future.merge(old[['id','ppr17','age','history_ppr17']],on='id',how='inner')
        relevant_old=old[old.ppr17>30]
        cut1,cut2=np.quantile(relevant_old.ppr17,[1/3,2/3])
        means=[]
        for label,mask in [('low',joined.ppr17.between(30,cut1)),('middle',joined.ppr17.between(cut1,cut2,inclusive='right')),('high',joined.ppr17>cut2)]:
            group=joined[mask]
            means.append(float(group.ppr.mean()))
            conditional.append({'position':pos,'past_tier':label,'n_players':group.id.nunique(),
                                'past_mean':group.ppr17.mean(),'next_mean':group.ppr.mean(),
                                'next_p10':group.ppr.quantile(.1),'next_p90':group.ppr.quantile(.9),
                                'zero_fraction':(group.attempts+group.carries+group.targets).eq(0).mean()})
        check('history_remains_informative',pos,(means[-1]-means[0])/scales[pos]*100,'>=15 and ordered',
              means[0]<means[1]<means[2] and (means[-1]-means[0])/scales[pos]*100>=15,
              'Previous low/mid/high producers have ordered next-season distributions')
        per_id=joined.groupby('id').agg(past=('ppr17','first'),future=('ppr','mean'))
        correlation=float(spearmanr(per_id.past,per_id.future).statistic)
        check('history_rank_relationship',pos,correlation,'>=0.5',correlation>=.5,'History affects conditional allocation, not just final marginal histograms')
        observed_pairs=pairs[(pairs.position==pos)&(pairs.ppr17>30)]
        observed_rhos=observed_pairs.groupby('target_season').apply(lambda g:spearmanr(g.ppr17,g.next_ppr17).statistic,include_groups=False)
        simulated_rhos=joined[joined.ppr17>30].groupby('simulation').apply(lambda g:spearmanr(g.ppr17,g.ppr).statistic,include_groups=False)
        realized_rho=float(simulated_rhos.mean())
        lo_rho=float(observed_rhos.min())-.10;hi_rho=float(observed_rhos.max())+.10
        check('realized_rank_persistence',pos,realized_rho,f'[{lo_rho:.3f},{hi_rho:.3f}]',lo_rho<=realized_rho<=hi_rho,
              'Realized season rank correlation, not correlation with an averaged forecast')
        for name,factor,greater in [('bust_fraction',.5,False),('breakout_fraction',1.5,True)]:
            obs=observed_pairs.groupby('target_season').apply(
                lambda g:(g.next_ppr17>factor*g.ppr17).mean() if greater else (g.next_ppr17<factor*g.ppr17).mean(),include_groups=False)
            sim=joined[joined.ppr17>30].groupby('simulation').apply(
                lambda g:(g.ppr>factor*g.ppr17).mean() if greater else (g.ppr<factor*g.ppr17).mean(),include_groups=False)
            value=float(sim.mean());low=max(0,float(obs.min())-.05);high=min(1,float(obs.max())+.05)
            check(name,pos,value,f'[{low:.3f},{high:.3f}]',low<=value<=high,
                  'Current PPR>30; historical annual range plus five percentage points')
        # PPR-threshold dropout comparison is also built with the same real threshold.
        historical_drop=pairs[(pairs.position==pos)&(pairs.ppr17>30)].groupby('target_season').next_opportunities.agg(lambda s:(s==0).mean())
        generated_drop=joined[joined.ppr17>30].groupby('simulation').apply(lambda g:(g.attempts+g.carries+g.targets).eq(0).mean(),include_groups=False)
        drop=float(generated_drop.mean())
        lo=max(0,float(historical_drop.min())-.03);hi=float(historical_drop.max())+.03
        check('incumbent_dropout_historical_range',pos,drop,f'[{lo:.3f},{hi:.3f}]',lo<=drop<=hi,
              'No-production seasons among prior PPR>30; historical annual range plus 3 percentage points')
        metrics.append({'position':pos,'rank_curve_error_score':rank_error,'top12_error_score':top12_error,
                        'historical_zero_active':realzero.mean(),'generated_zero_active':genzero.mean(),
                        'historical_opportunities':realtotal,'generated_opportunities':gentotal,
                        'incumbent_dropout':drop,'historical_dropout_mean':historical_drop.mean(),
                        'rank_correlation':correlation,
                        'historical_top12_ppr':observed_mean[:12].mean(),'generated_top12_ppr':sampled_mean[:12].mean()})
        curves[pos]={'real':observed_curves.tolist(),'generated':sampled_curves.tolist(),
                     'reference_years':sorted(map(int,historical.season.unique()))}
    qb=generated[generated.position=='QB']
    maxattempt=float(qb.attempts.max())
    check('no_runaway_qb_workloads','QB',maxattempt,'<=850 in tested sample',maxattempt<=850,
          'Stress guard far above an ordinary season; not a hard cap in the generator')
    for p in showcase['players']:
        scores=np.asarray(p['sample_ppr'])
        check('non_deterministic_player_seasons',p['id'],scores.std(),'>=10 PPR',scores.std()>=10,
              'Same history supports materially different outcomes')
        check('novel_positive_stat_lines',p['id'],p['distribution']['unique_positive_lines'],'>=10',
              p['distribution']['unique_positive_lines']>=10,'Within-season bootstrap creates new box-score vectors')
    pd.DataFrame(checks).to_csv(output/'realism_checks.csv',index=False)
    pd.DataFrame(metrics).to_csv(output/'game_realism_metrics.csv',index=False)
    pd.DataFrame(conditional).to_csv(output/'conditional_history_metrics.csv',index=False)
    (output/'rank_curves.json').write_text(json.dumps(curves)+'\n')
    return pd.DataFrame(checks)
