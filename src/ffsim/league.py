"""Fictional NFL-sized populations, including new entrants and visible histories."""
from __future__ import annotations

import json
import hashlib
from pathlib import Path
import numpy as np
import pandas as pd

from .calibrate import configured_model
from .data import COUNTS, add_derived, transitions
from .model import CORE, OFFSETS, history_features, load_weekly, points, repair
from .model import features
from scipy.optimize import linear_sum_assignment
from scipy.spatial.distance import cdist


def engine_fingerprint():
    root=Path(__file__).parent
    return hashlib.sha256((root/'model.py').read_bytes()+(root/'league.py').read_bytes()).hexdigest()


class BalancedSeason:
    """Allocate a complete empirical NFL outcome pool, conditional on histories.

    Distributional realism is a construction constraint, not a forecast claim.
    Gumbel-perturbed matching gives stochastic role allocation without replacing
    the league's limited opportunity budget with independent player draws.
    """
    def __init__(self, model, panel, temperature=1.):
        self.model, self.temperature = model, temperature
        self.pools = entrant_pools(panel, model.train_end)
        self.years = sorted(set(model.groups['QB'][0].target_season))
        # Production game is a 17-game NFL: modern season ecology. All 2015+
        # careers still inform matching/history. Backtests use only available years.
        modern = [y for y in self.years if y >= 2021]
        self.years = modern or self.years

    def sample(self, current, rng):
        target_year = int(rng.choice(self.years))
        lines, identities, diagnostics = [], [], []
        for pos, group in current.groupby('position'):
            source, scaler, weights, _ = self.model.groups[pos]
            donors = source[source.target_season==target_year]
            qx = scaler.transform(features(group))*weights
            dx = scaler.transform(features(donors))*weights
            n, m = len(group), len(donors)
            size = max(n,m)
            cost = np.zeros((size,size))
            cost[:n,:m] = cdist(qx,dx,'sqeuclidean')
            tiers={'depth':0,'part_time':1,'starter':2,'committee':1,'lead':2,'supporting':1,'primary':2}
            qt=group.role.map(tiers).to_numpy();dt=donors.role.map(tiers).to_numpy()
            # Opportunity role takes precedence over demographic similarity: an
            # elite young starter must not inherit a holder's future just because
            # both are young. Historical demotions still occur via donor next year.
            cost[:n,:m] += 12*(qt[:,None]-dt[None,:])**2
            def baseline(rows):
                now=rows.ppr_per_game.fillna(0).to_numpy()
                past=rows.history_ppr17.to_numpy()/np.maximum(1,rows.history_games.to_numpy()*17)
                return .6*now+.4*past
            # A high-efficiency young star should not repeatedly inherit the
            # benching outcome of a lower-efficiency young volume passer. Use
            # sustained per-game production, not age or workload alone.
            ppg_scale=5. if pos in ['QB','RB'] else 4.
            cost[:n,:m] += 4*((baseline(group)[:,None]-baseline(donors)[None,:])/ppg_scale)**2
            # Unequal population sizes are absorbed by low-opportunity fringe
            # slots, not by forcing high-workload players out of the league.
            if n>m:
                cost[:n,m:] = np.log1p(group.opportunities.to_numpy())[:,None]**2
            if m>n:
                cost[n:,:m] = np.log1p(donors.opportunities.to_numpy())[None,:]**2
            cost -= self.temperature*rng.gumbel(size=(size,size))
            rows, cols = linear_sum_assignment(cost)
            for q,d in zip(rows,cols):
                if q>=n:
                    if d<m:
                        donor_index=int(donors.index[d])
                        sampled,_=self.model.sample_matched(group.iloc[0],np.array([donor_index]),np.array([1.]),1,rng)
                        lines.append(sampled[0])
                        identities.append({'id':f'POOL-{pos}-{d+1:03d}','position':pos,'new_entrant':True,
                                           'rostered_next':bool(donors.iloc[d].next_rostered),
                                           'age':float(donors.iloc[d].age+1) if pd.notna(donors.iloc[d].age) else 26.})
                    continue
                row = group.iloc[q]
                if d>=m:
                    sampled=np.zeros(len(CORE))
                else:
                    donor_index=int(donors.index[d])
                    sampled,_=self.model.sample_matched(row,np.array([donor_index]),np.array([1.]),1,rng)
                    sampled=sampled[0]
                lines.append(sampled)
                identities.append({'id':row.player_id,'position':pos,'new_entrant':False,
                                   'rostered_next':bool(donors.iloc[d].next_rostered) if d<m else False,
                                   'age':float(row.age+1) if pd.notna(row.age) else 26.})
            entrants=self.pools.get((pos,target_year),pd.DataFrame())
            for k,(_,entrant) in enumerate(entrants.iterrows()):
                # The whole source cohort preserves entry volume, including depth.
                y=entrant[CORE].to_numpy(float)*17/entrant.scheduled_games
                lines.append(repair(y[None,:])[0])
                identities.append({'id':f'NEW-{pos}-{k+1:03d}','position':pos,'new_entrant':True,'rostered_next':True,
                                   'age':float(entrant.age) if pd.notna(entrant.age) else 26.})
            diagnostics.append({'position':pos,'query_n':n,'source_n':m,'padding':abs(n-m),
                                'assigned_source_indices':[int(donors.index[d]) for d in cols if d<m],
                                'query_assignment':[(int(q),int(donors.index[d]) if d<m else -1) for q,d in zip(rows,cols) if q<n]})
        frame=pd.DataFrame(lines,columns=CORE)
        frame['ppr']=points(np.asarray(lines))
        frame=pd.concat([pd.DataFrame(identities),frame],axis=1)
        frame['source_season']=target_year
        return frame,diagnostics


def score_scale(panel):
    # Fixed before the audit. No re-ranking or rescaling each generated season.
    from .model import relevant
    reference = panel[(panel.season <= 2022) & relevant(panel)]
    return {p: float(g.ppr17.quantile(.99)) for p, g in reference.groupby("position")}


def season_index(ppr, position, scales):
    """0=no production, 100=historical positional 99th percentile; display-only."""
    return np.clip(np.asarray(ppr, float)/scales[position]*100, 0, 100)


def fictional_history(panel, anchor, identity, rng):
    history = panel[(panel.player_id==anchor.player_id) & (panel.season<=anchor.season)].sort_values("season").copy()
    peers = panel[(panel.season==anchor.season) & panel.position.eq(anchor.position) & panel.player_id.ne(anchor.player_id)]
    if history.age.isna().any():
        known=history[history.age.notna()]
        if len(known):
            latest=known.iloc[-1];age=float(latest.age+anchor.season-latest.season)
        else:
            minimum_age=20+int(anchor.season-history.season.min())
            pool=peers[(peers.opportunities==0)&(peers.age>=minimum_age)].age.dropna()
            age=float(rng.choice(pool)) if len(pool) else float(max(26,minimum_age))
        history['age']=history.age.fillna(age+history.season-anchor.season)
    # A fictional birth date is persistent. Annual source snapshots can disagree,
    # and approximate fractional ages near birthdays can cross an integer twice.
    # Anchor the current age and advance it exactly with each visible season.
    anchored_age=float(history.age.iloc[-1])
    history['age']=anchored_age+history.season-anchor.season
    distance = ((peers.age.fillna(26)-float(anchor.age if pd.notna(anchor.age) else 26))/3)**2 + ((peers.ppr17-anchor.ppr17)/80)**2
    peer = peers.loc[distance.nsmallest(8).index].iloc[int(rng.integers(min(8,len(peers))))]
    a = np.maximum(anchor[CORE].to_numpy(float), 0)
    b = np.maximum(peer[CORE].to_numpy(float), 0)
    # Small persistent vector blend, with the same transformation across history.
    multiplier = np.exp(.10*(np.log1p(b/OFFSETS)-np.log1p(a/OFFSETS)))
    raw = history[CORE].to_numpy(float)
    transformed = raw*multiplier
    transformed[:, -1] = raw[:, -1]
    history[CORE] = repair(transformed)
    history["player_id"], history["name"] = identity, identity
    return history_features(add_derived(history))


def entrant_pools(panel, cutoff):
    """Newly rostered compared with prior year, including veterans returning."""
    pools = {}
    # 2015 roster source coverage is smaller; exclude that intake discontinuity.
    for year in range(2017, cutoff+1):
        prior = set(panel.loc[panel.season==year-1, "player_id"])
        for pos in ["QB", "RB", "WR", "TE"]:
            pools[(pos,year)] = panel[(panel.season==year) & panel.position.eq(pos) & ~panel.player_id.isin(prior)]
    return pools


def simulate_population(model, current, pools, rng, with_intake=True):
    lines, identities = [], []
    for pos, group in current.groupby("position"):
        group = group.reset_index(drop=True)
        ids, weights = model.analogs(group)
        for n, (_, row) in enumerate(group.iterrows()):
            sampled, _ = model.sample_matched(row, ids[n], weights[n], 1, rng)
            lines.append(sampled[0]); identities.append({"id": row.player_id, "position": pos, "new_entrant": False})
        if with_intake:
            years = sorted(y for p,y in pools if p==pos)
            chosen_year = int(rng.choice(years))
            entrants = pools[(pos, chosen_year)]
            if len(entrants):
                # Bootstrap a whole empirical entrant cohort size; never fill with elites.
                chosen = entrants.iloc[rng.integers(len(entrants),size=len(entrants))]
                for n, (_, entrant) in enumerate(chosen.iterrows()):
                    y = entrant[CORE].to_numpy(float)*17/entrant.scheduled_games
                    lines.append(repair(y[None,:])[0])
                    identities.append({"id": f"NEW-{pos}-{n+1:03d}", "position": pos, "new_entrant": True})
    frame = pd.DataFrame(lines, columns=CORE)
    frame["ppr"] = points(np.asarray(lines))
    frame = pd.concat([pd.DataFrame(identities),frame],axis=1)
    return frame


def make_showcase(panel, output, replicates=100, seed=20261030):
    output = Path(output)
    fingerprint=engine_fingerprint()
    config = json.loads((output / "model_config.json").read_text())
    weekly = load_weekly(output.parent / "data/raw")
    model = configured_model(config,2025,weekly).fit(panel)
    scales = score_scale(panel)
    rng = np.random.default_rng(seed)
    base = panel[panel.season==2025].copy()
    histories = []
    for pos, group in base.groupby("position"):
        for n, (_, anchor) in enumerate(group.sort_values("ppr17",ascending=False).iterrows()):
            identity = f"{pos}-{n+1:03d}"
            histories.append(fictional_history(panel,anchor,identity,rng))
    population = pd.concat([h.tail(1) for h in histories],ignore_index=True)
    def visible_history(history,pos):
        return [{"age":int(old.age),"relative_season":int(old.season-2025),"games":int(old.games),
                 "ppr":round(float(old.ppr),2),"score":round(float(season_index(old.ppr,pos,scales)),1),
                 **{c:int(old[c]) for c in CORE if c!='games'},
                 "listed_out_weeks":None if pd.isna(old.report_out_weeks) else int(old.report_out_weeks)}
                for _,old in history.iterrows()]
    full_database={'players':[{'id':h.player_id.iloc[-1],'position':h.position.iloc[-1],
                               'age':int(h.age.iloc[-1]),'history':visible_history(h,h.position.iloc[-1])}
                              for h in histories]}
    output.mkdir(parents=True,exist_ok=True)
    (output/'player_database.json').write_text(json.dumps(full_database,indent=2)+'\n')
    pools = entrant_pools(panel,2025)
    simulator=BalancedSeason(model,panel)
    seasons = []
    for simulation in range(replicates):
        future,_ = simulator.sample(population,np.random.default_rng(seed+1000+simulation))
        future["simulation"] = simulation+1
        seasons.append(future)
        if (simulation+1)%20==0:
            print(f'Generated {simulation+1}/{replicates} complete seasons',flush=True)
    results = pd.concat(seasons,ignore_index=True)
    results.to_csv(output / "league_seasons.csv",index=False)
    # Representative profiles selected by previous score strata, before futures.
    selected = []
    for pos in ["QB","RB","WR","TE"]:
        eligible = population[population.position.eq(pos) & (population.ppr17>30)].sort_values("ppr17",ascending=False)
        for fraction in [.05,.30,.65]:
            row = eligible.iloc[min(int(len(eligible)*fraction),len(eligible)-1)]
            h = next(h for h in histories if h.player_id.iloc[-1]==row.player_id)
            selected_lines=results[results.id.eq(row.player_id)]
            draws=selected_lines[CORE].to_numpy(float)
            ppr=selected_lines.ppr.to_numpy(float)
            future_lines = []
            for n in range(3):
                d = {c:int(v) for c,v in zip(CORE,draws[n])}
                future_lines.append({**d,"age":int(row.age)+1,"ppr":round(float(ppr[n]),2),"score":round(float(season_index(ppr[n],pos,scales)),1)})
            visible = visible_history(h,pos)
            selected.append({"id":row.player_id,"position":pos,"age":int(row.age),"history":visible,
                             "alternatives":future_lines,
                             "distribution":{"p10":float(np.quantile(ppr,.1)),"median":float(np.median(ppr)),
                                             "p90":float(np.quantile(ppr,.9)),"zero_probability":float(np.mean(draws[:,[0,5,8]].sum(axis=1)==0)),
                                             "unique_positive_lines":int(len(np.unique(draws[draws[:,[0,5,8]].sum(axis=1)>0],axis=0)))},
                             "sample_ppr":ppr.tolist()})
    data={"seed":seed,"engine_fingerprint":fingerprint,"score_definition":"100 * season PPR / positional 2015–22 relevant-player P99, capped only for display",
          "scales":scales,"players":selected,"replicates":replicates,
          "note":"Three alternative upcoming seasons from the same history, not three consecutive seasons. New entrant cohorts are included in population curves.",
          "mechanism":"Stochastic one-to-one allocation of complete modern-NFL successor pools; conditional histories determine allocation; distributional margins are a construction constraint, not an out-of-sample discovery."}
    (output/"showcase_players.json").write_text(json.dumps(data,indent=2)+"\n")
    population[["player_id","position","age","ppr17","games","history_ppr17"]].rename(columns={"player_id":"id"}).to_csv(output/'fictional_population.csv',index=False)
    return data,results
