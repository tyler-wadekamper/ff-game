"""Observable parameter ranges, priors, age associations, and real examples."""
from __future__ import annotations

from pathlib import Path
import numpy as np
import pandas as pd

from .data import transitions
from .model import relevant

RATES = [
    ("completion_rate", "completions", "attempts", 100, ["QB"]),
    ("passing_yards_per_attempt", "passing_yards", "attempts", 100, ["QB"]),
    ("passing_td_rate", "passing_tds", "attempts", 100, ["QB"]),
    ("interception_rate", "passing_interceptions", "attempts", 100, ["QB"]),
    ("rushing_yards_per_carry", "rushing_yards", "carries", 50, ["QB", "RB", "WR", "TE"]),
    ("rushing_td_rate", "rushing_tds", "carries", 50, ["QB", "RB", "WR", "TE"]),
    ("catch_rate", "receptions", "targets", 30, ["RB", "WR", "TE"]),
    ("receiving_yards_per_reception", "receiving_yards", "receptions", 20, ["RB", "WR", "TE"]),
    ("receiving_td_rate", "receiving_tds", "receptions", 20, ["RB", "WR", "TE"]),
    ("lost_fumble_rate", "lost_fumbles", "ball_handling_events", 75, ["QB", "RB", "WR", "TE"]),
]


def analyze(panel: pd.DataFrame, output: Path):
    output.mkdir(parents=True, exist_ok=True)
    summaries, priors = [], []
    def summarize(pos, name, values, cohort, threshold="", pooled=np.nan):
        values = pd.Series(values).dropna()
        summaries.append({"position": pos, "parameter": name, "cohort": cohort,
                          "threshold": threshold, "n": len(values),
                          "min": values.min() if len(values) else np.nan,
                          "max": values.max() if len(values) else np.nan,
                          "mean": values.mean() if len(values) else np.nan,
                          "p10": values.quantile(.1) if len(values) else np.nan,
                          "median": values.median() if len(values) else np.nan,
                          "p90": values.quantile(.9) if len(values) else np.nan,
                          "pooled_rate": pooled})
    for pos, group in panel.groupby("position"):
        eligible = group[relevant(group)]
        for cohort, rows in [("all_rostered", group), ("fantasy_relevant", eligible)]:
            for name in ["age", "experience", "games", "offense_snaps", "attempts", "carries", "targets", "receptions",
                         "passing_yards", "rushing_yards", "receiving_yards", "passing_tds", "rushing_tds", "receiving_tds",
                         "opportunities_per_game", "ppr", "ppr17", "ppr_per_game", "participation_fraction", "report_out_weeks"]:
                summarize(pos, name, rows[name], cohort)
        for name, num, den, threshold, positions in RATES:
            if pos not in positions:
                continue
            rows = group[group[den] >= threshold]
            values = rows[num] / rows[den]
            pooled = rows[num].sum() / rows[den].sum() if len(rows) else np.nan
            summarize(pos, name, values, "rate_qualified", f"{den}>={threshold}", pooled)
            if name.endswith("rate") and len(rows) > 2 and 0 < pooled < 1:
                # Approximate beta-binomial method of moments, with sampling variance removed.
                between = max(float(values.var() - np.mean(pooled * (1 - pooled) / rows[den])), 1e-6)
                concentration = np.clip(pooled * (1 - pooled) / between - 1, 2, 1000)
                priors.append({"position": pos, "parameter": name, "mean": pooled,
                               "alpha": pooled * concentration, "beta": (1 - pooled) * concentration,
                               "concentration": concentration, "n": len(rows),
                               "status": "descriptive prior; not used by the empirical transition sampler"})
    pd.DataFrame(summaries).to_csv(output / "parameter_summary.csv", index=False)
    pd.DataFrame(priors).to_csv(output / "beta_priors.csv", index=False)

    pairs = transitions(panel)
    training = pairs[pairs.target_season <= 2022]
    age_rows, persistence_rows = [], []
    for pos, rows in training.groupby("position"):
        good = rows[relevant(rows) & (rows.next_games >= 4) & (rows.games >= 4)].copy()
        for metric in ["ppr_per_game", "opportunities_per_game"]:
            if metric == "ppr_per_game":
                future = good.next_ppr / good.next_games
            else:
                future = good.next_opportunities / good.next_games
            current = good[metric]
            change = np.log1p(future.clip(lower=0)) - np.log1p(current.clip(lower=0))
            turning = {"QB": 30, "RB": 27, "WR": 28, "TE": 29}[pos]
            a, b = good.age.to_numpy(), good.age.to_numpy() + 1
            x = np.column_stack([np.minimum(b-turning, 0)-np.minimum(a-turning, 0),
                                 np.maximum(b-turning, 0)-np.maximum(a-turning, 0)])
            valid = np.isfinite(x).all(axis=1) & np.isfinite(change)
            slopes = np.linalg.lstsq(x[valid], change.to_numpy()[valid], rcond=None)[0]
            residual = change.to_numpy()[valid] - x[valid] @ slopes
            age_rows.append({"position": pos, "metric": metric, "n": int(valid.sum()),
                             "fixed_turning_age": turning, "early_log_slope": slopes[0], "late_log_slope": slopes[1],
                             "residual_sd": residual.std(),
                             "upside_rms": np.sqrt(np.mean(residual[residual>0]**2)),
                             "downside_rms": np.sqrt(np.mean(residual[residual<0]**2)),
                             "status": "survivor-conditioned association, not causal aging or individual peak estimate"})
        change = rows.next_ppr17 - rows.ppr17
        persistence_rows.append({"position": pos, "n": len(rows), "ppr17_lag_correlation": rows.ppr17.corr(rows.next_ppr17),
                                 "change_min": change.min(), "change_max": change.max(), "change_mean": change.mean(),
                                 "change_sd": change.std(), "no_next_production_rate": rows.next_opportunities.eq(0).mean(),
                                 "status": "observed persistence; not latent ability rho"})
    pd.DataFrame(age_rows).to_csv(output / "age_associations.csv", index=False)
    pd.DataFrame(persistence_rows).to_csv(output / "persistence.csv", index=False)
    role = training.groupby(["position", "role", "next_role"]).size().rename("count").reset_index()
    role["probability"] = role["count"] / role.groupby(["position", "role"])["count"].transform("sum")
    role.to_csv(output / "role_transitions.csv", index=False)
    names = ["Lamar Jackson", "Michael Vick", "Christian McCaffrey", "Derrick Henry", "Justin Jefferson", "Tyreek Hill", "Travis Kelce", "George Kittle"]
    examples = panel[panel.name.isin(names)]
    examples.to_csv(output / "real_player_histories.csv", index=False)
    correlations = []
    columns = ["age", "games", "ppr17", "attempts", "carries", "targets", "rushing_yards", "receiving_yards", "report_out_weeks"]
    for pos, group in panel[relevant(panel)].groupby("position"):
        matrix = group[columns].corr().stack().rename("correlation").reset_index()
        matrix.columns = ["trait_a", "trait_b", "correlation"]
        matrix["position"] = pos
        correlations.append(matrix)
    pd.concat(correlations).to_csv(output / "trait_correlations.csv", index=False)
