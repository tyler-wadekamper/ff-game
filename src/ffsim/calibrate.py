"""Choose simulator settings on earlier years using distributional fidelity."""
from __future__ import annotations

import json
from pathlib import Path
import numpy as np
import pandas as pd
from scipy.stats import wasserstein_distance

from .data import transitions
from .model import EmpiricalModel, points, relevant


def calibrate(panel, output, weekly=None):
    results = []
    # Forward-only development folds. 2023–25 are excluded from selection.
    for k in [12, 24, 40]:
        for age in [1.5, 3.0]:
            for jitter in [0., .25]:
                scores = []
                for cutoff, targets in [(2018, [2019, 2020]), (2020, [2021, 2022])]:
                    model = EmpiricalModel(cutoff, k, age, jitter, weekly).fit(panel)
                    pairs = transitions(model.panel)
                    pairs = pairs[pairs.target_season.isin(targets) & relevant(pairs)]
                    for pos, group in pairs.groupby("position"):
                        group = group.reset_index(drop=True)
                        ids, weights = model.analogs(group)
                        rng = np.random.default_rng(20261031)
                        sampled = [points(model.sample_matched(row, ids[n], weights[n], 128, rng)[0])
                                   for n, (_, row) in enumerate(group.iterrows())]
                        samples = np.asarray(sampled)
                        actual = group.next_ppr17.to_numpy()
                        scale = max(float(actual.std()), 20)
                        wd = wasserstein_distance(actual, samples.ravel())/scale
                        zero_error = abs(np.mean(actual == 0)-np.mean(samples == 0))
                        # Do not reward matching marginals while ignoring history.
                        conditional = []
                        ranks = group.ppr17.rank(pct=True).to_numpy()
                        for mask in [ranks <= 1/3, (ranks > 1/3) & (ranks <= 2/3), ranks > 2/3]:
                            conditional.append(wasserstein_distance(actual[mask], samples[mask].ravel())/scale)
                        score = .5*wd + .5*np.mean(conditional) + 2*zero_error
                        scores.append(score)
                        results.append({"neighbors": k, "age_bandwidth": age, "jitter": jitter,
                                        "cutoff": cutoff, "position": pos, "n": len(group),
                                        "wasserstein_scaled": wd, "zero_error": zero_error,
                                        "conditional_wasserstein_scaled": np.mean(conditional), "objective": score})
                print(f"development k={k} age={age} jitter={jitter}: {np.mean(scores):.4f}", flush=True)
    frame = pd.DataFrame(results)
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    frame.to_csv(output / "development_calibration.csv", index=False)
    # Zero jitter is an ablation, not a game generator: it copies complete lines.
    # Require nonzero within-season variation for procedural novelty.
    ranking = frame[frame.jitter > 0].groupby(["neighbors", "age_bandwidth", "jitter"]).objective.mean().sort_values()
    k, age, jitter = ranking.index[0]
    config = {"neighbors": int(k), "age_bandwidth": float(age), "jitter": float(jitter),
              "selection": "Minimum mean distributional score across 2019–22 forward-only folds among nonzero-jitter generators; zero jitter is an ablation; no 2023–25 selection",
              "objective": ".5 * pooled normalized Wasserstein + .5 * past-score-tercile normalized Wasserstein + 2 * zero-rate absolute error",
              "development_score": float(ranking.iloc[0])}
    (output / "model_config.json").write_text(json.dumps(config, indent=2)+"\n")
    return config


def configured_model(config, cutoff, weekly=None):
    return EmpiricalModel(cutoff, config["neighbors"], config["age_bandwidth"], config["jitter"], weekly)
