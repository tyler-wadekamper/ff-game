"""Export the fitted history-only market kernel for browser universe creation."""
from pathlib import Path
import gzip,json
import numpy as np
import pandas as pd
from .adp import ADPModel,FEATURES,LIMIT

def export_market(root):
    root=Path(root);out=root/'game/data';data=pd.read_csv(root/'artifacts/adp_training_features.csv')
    k=json.loads((root/'artifacts/adp_protocol.json').read_text())['selected_neighbors']
    model=ADPModel(2024,k).fit(data);groups={}
    for pos,(rows,scaler,weights,search) in model.groups.items():
        groups[pos]={'mean':scaler.mean_.tolist(),'scale':scaler.scale_.tolist(),
                     'weights':weights.tolist(),'vectors':np.round(search._fit_X,5).tolist(),
                     'targets':rows.target.tolist()}
    historical=pd.read_csv(root/'artifacts/historical_adp.csv');curves=[]
    for _,g in historical[historical.draft_year>=2016].groupby('draft_year'):
        g=g.sort_values('eligible_rank');adjusted=g.source_adp-(g.source_rank-g.eligible_rank)
        curves.append(np.interp(np.arange(1,LIMIT+1),g.eligible_rank,adjusted))
    curve=np.maximum(np.maximum.accumulate(np.mean(curves,axis=0)),np.arange(1,LIMIT+1)*.8)
    payload={'features':FEATURES,'neighbors':k,'limit':LIMIT,'groups':groups,'curve':curve.tolist(),
             'scales':[5,3,60,5,8,60,60,80,60,10,5,5,100,30,40,1,2,.5,1,1],
             'training_cutoff':2024,'source':'History-only FantasyPros consensus market kernel; source format not certified'}
    with gzip.open(out/'adp-model.json.gz','wt') as f:json.dump(payload,f,separators=(',',':'))
    print('Exported browser market kernel:',sum(len(g['targets']) for g in groups.values()),'historical states')

if __name__=='__main__':export_market(Path.cwd())
