"""Reused 2023–25 historical audit of the complete, balanced game law."""
import json
from pathlib import Path
import numpy as np
import pandas as pd
from scipy.stats import wasserstein_distance

from .calibrate import configured_model
from .data import transitions
from .league import BalancedSeason,engine_fingerprint
from .model import CORE,load_weekly,points,relevant


def audit_game(panel,output,replicates=64):
    output=Path(output)
    fingerprint=engine_fingerprint()
    config=json.loads((output/'model_config.json').read_text())
    model=configured_model(config,2022,load_weekly(output.parent/'data/raw')).fit(panel)
    simulator=BalancedSeason(model,panel)
    pairs=transitions(model.panel)
    records=[]
    for year in [2023,2024,2025]:
        current=model.panel[model.panel.season==year-1]
        actual=pairs[pairs.target_season==year].set_index('player_id')
        all_draws=[]
        for repeat in range(replicates):
            season,_=simulator.sample(current,np.random.default_rng(800000+1000*year+repeat))
            season=season[~season.new_entrant].set_index('id').loc[current.player_id]
            all_draws.append(season[CORE].to_numpy(float))
            if (repeat+1)%16==0:print(f'Balanced audit {year}: {repeat+1}/{replicates}',flush=True)
        samples=np.stack(all_draws,axis=1)
        scores=points(samples.reshape(-1,len(CORE))).reshape(len(current),replicates)
        zero=samples[:,:,[0,5,8]].sum(axis=2)==0
        for n,(_,row) in enumerate(current.iterrows()):
            observed=actual.loc[row.player_id]
            records.append({'position':row.position,'target_season':year,'player_id':row.player_id,
                            'relevant':bool(relevant(pd.DataFrame([row])).iloc[0]),
                            'actual_ppr':observed.next_ppr17,'last_ppr':row.ppr17,
                            'actual_no_production':observed.next_opportunities==0,
                            'generated_no_production':zero[n].mean(),
                            'generated_zero_ppr':(scores[n]==0).mean(),
                            'generated_mean':scores[n].mean(),'generated_p90':np.quantile(scores[n],.9),
                            'samples':scores[n].tolist()})
    individual=pd.DataFrame(records)
    metrics=[]
    for pos,g in individual[individual.relevant].groupby('position'):
        draws=np.asarray(g.samples.tolist())
        metrics.append({'position':pos,'n':len(g),'actual_mean':g.actual_ppr.mean(),
                        'generated_mean':draws.mean(),'actual_zero_ppr':g.actual_ppr.eq(0).mean(),
                        'generated_zero_ppr':(draws==0).mean(),
                        'actual_no_production':g.actual_no_production.mean(),
                        'generated_no_production':g.generated_no_production.mean(),
                        'actual_p90':g.actual_ppr.quantile(.9),'generated_p90':np.quantile(draws,.9),
                        'wasserstein_ppr':wasserstein_distance(g.actual_ppr,draws.ravel())})
    pd.DataFrame(metrics).to_csv(output/'balanced_historical_audit.csv',index=False)
    individual.drop(columns='samples').to_csv(output/'balanced_audit_individual.csv',index=False)
    (output/'balanced_audit_metadata.json').write_text(json.dumps({'engine_fingerprint':fingerprint,
        'replicates_per_year':replicates,'training_cutoff':2022,'audit_years':[2023,2024,2025],
        'status':'Reused historical audit; not an untouched test set'},indent=2)+'\n')
    return pd.DataFrame(metrics)
