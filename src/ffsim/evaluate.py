"""Time-separated evaluation of distributions, not just plausible examples."""
from __future__ import annotations

import json
from pathlib import Path
import numpy as np
import pandas as pd
from scipy.stats import spearmanr, wasserstein_distance

from .data import transitions
from .model import EmpiricalModel, CORE, points, relevant, load_weekly
from .calibrate import configured_model


def crps(draws: np.ndarray, actual: float) -> float:
    """Sample CRPS, O(n log n); lower is better, in fantasy-point units."""
    ordered = np.sort(draws)
    n = len(ordered)
    half_pair_distance = np.sum((2 * np.arange(1, n + 1) - n - 1) * ordered) / n ** 2
    return float(np.mean(np.abs(draws - actual)) - half_pair_distance)


def validate(panel: pd.DataFrame, output: Path, draws: int = 256, seed: int = 20261030):
    output.mkdir(parents=True, exist_ok=True)
    config_path = output / "model_config.json"
    config = json.loads(config_path.read_text()) if config_path.exists() else {"neighbors": 12, "age_bandwidth": 3., "jitter": .25}
    weekly = load_weekly(output.parent / "data/raw")
    model = configured_model(config, 2022, weekly).fit(panel)
    test = transitions(model.panel)
    test = test[test.target_season.isin([2023, 2024, 2025])]
    rng = np.random.default_rng(seed)
    records, marginal = [], {p: {"actual": [], "generated": [], "actual_stats": [], "generated_stats": []} for p in model.groups}
    matched = {}
    for pos, rows in test.groupby("position"):
        ids, probabilities = model.analogs(rows)
        for index, candidates, weights in zip(rows.index, ids, probabilities):
            matched[index] = candidates, weights
    for index, row in test.iterrows():
        candidates, weights = matched[index]
        samples, diagnostic = model.sample_matched(row, candidates, weights, draws, rng)
        scores = points(samples)
        actual = float(row.next_ppr17)
        group = model.groups[row.position][0]
        is_relevant = bool(relevant(pd.DataFrame([row])).iloc[0])
        # A fair no-history baseline still knows position and cohort membership.
        baseline_pool = group[relevant(group).eq(is_relevant)].next_ppr17.to_numpy()
        unconditional = rng.choice(baseline_pool, size=draws)
        q05, q10, q25, q50, q75, q90, q95 = np.quantile(scores, [.05, .1, .25, .5, .75, .9, .95])
        records.append({"player_id": row.player_id, "name": row['name'], "position": row.position,
                        "target_season": row.target_season, "age": row.age, "relevant": is_relevant,
                        "actual_ppr17": actual, "last_ppr17": row.ppr17,
                        "predicted_mean": scores.mean(), "predicted_median": q50,
                        "absolute_error": abs(actual - q50), "repeat_last_error": abs(actual - row.ppr17),
                        "crps": crps(scores, actual), "unconditional_crps": crps(unconditional, actual),
                        "covered50": q25 <= actual <= q75, "covered80": q10 <= actual <= q90,
                        "covered90": q05 <= actual <= q95, "interval90_width": q95 - q05,
                        "q05": q05, "q95": q95, **diagnostic})
        if is_relevant:
            marginal[row.position]["actual"].append(actual)
            marginal[row.position]["generated"].extend(scores.tolist())
            marginal[row.position]["actual_stats"].append(row[[f"next_{c}" for c in CORE]].to_numpy(float))
            marginal[row.position]["generated_stats"].append(samples)
    predictions = pd.DataFrame(records)
    predictions.to_csv(output / "holdout_predictions.csv", index=False)
    metrics = []
    for cohort in ["all_rostered", "fantasy_relevant"]:
        subset = predictions if cohort == "all_rostered" else predictions[predictions.relevant]
        for pos, group in subset.groupby("position"):
            # Resample whole players, retaining correlation across their seasons.
            by_player = group.assign(improvement=group.repeat_last_error-group.absolute_error).groupby("player_id").agg(
                improvement=("improvement", "sum"), n=("improvement", "size"))
            boot_rng = np.random.default_rng(seed)
            selected = boot_rng.integers(len(by_player), size=(1000, len(by_player)))
            improvements = by_player.improvement.to_numpy()[selected].sum(axis=1) / by_player.n.to_numpy()[selected].sum(axis=1)
            metrics.append({"cohort": cohort, "position": pos, "n": len(group),
                            "mae": group.absolute_error.mean(), "repeat_last_mae": group.repeat_last_error.mean(),
                            "crps": group.crps.mean(), "unconditional_crps": group.unconditional_crps.mean(),
                            "coverage50": group.covered50.mean(), "coverage80": group.covered80.mean(),
                            "coverage90": group.covered90.mean(), "interval90_width": group.interval90_width.mean(),
                            "rank_correlation": spearmanr(group.actual_ppr17, group.predicted_mean).statistic,
                            "mae_improvement_ci_low": np.quantile(improvements, .025),
                            "mae_improvement_ci_high": np.quantile(improvements, .975)})
    metrics = pd.DataFrame(metrics)
    metrics.to_csv(output / "validation_metrics.csv", index=False)
    per_year = predictions[predictions.relevant].groupby(["position", "target_season"]).agg(
        n=("actual_ppr17", "size"), mae=("absolute_error", "mean"),
        repeat_last_mae=("repeat_last_error", "mean"), coverage90=("covered90", "mean"))
    per_year.to_csv(output / "validation_by_year.csv")
    distribution, stat_comparisons, joint_comparisons = [], [], []
    for pos, samples in marginal.items():
        actual, generated = np.asarray(samples["actual"]), np.asarray(samples["generated"])
        entry = {"position": pos, "wasserstein_ppr": wasserstein_distance(actual, generated)}
        for label, values in [("actual", actual), ("generated", generated)]:
            entry.update({f"{label}_mean": float(values.mean()), f"{label}_std": float(values.std()),
                          f"{label}_zero_fraction": float(np.mean(values == 0)),
                          **{f"{label}_p{q}": float(np.percentile(values, q)) for q in [10, 50, 90, 95, 99]}})
        distribution.append(entry)
        observed_stats = np.asarray(samples["actual_stats"])
        synthetic_stats = np.concatenate(samples["generated_stats"])
        for k, name in enumerate(CORE):
            observed, synthetic = observed_stats[:, k], synthetic_stats[:, k]
            stat_comparisons.append({"position": pos, "stat": name,
                                     "actual_mean": observed.mean(), "generated_mean": synthetic.mean(),
                                     "actual_p90": np.quantile(observed, .9), "generated_p90": np.quantile(synthetic, .9),
                                     "actual_p99": np.quantile(observed, .99), "generated_p99": np.quantile(synthetic, .99),
                                     "actual_max": observed.max(), "generated_max": synthetic.max(),
                                     "wasserstein": wasserstein_distance(observed, synthetic)})
        for a, b in [("carries", "rushing_yards"), ("targets", "receiving_yards"),
                     ("attempts", "passing_yards"), ("passing_yards", "rushing_yards"),
                     ("games", "targets")]:
            j, k = CORE.index(a), CORE.index(b)
            if observed_stats[:, j].std() > 0 and observed_stats[:, k].std() > 0:
                joint_comparisons.append({"position": pos, "stat_a": a, "stat_b": b,
                                          "actual_correlation": np.corrcoef(observed_stats[:, j], observed_stats[:, k])[0, 1],
                                          "generated_correlation": (np.corrcoef(synthetic_stats[:, j], synthetic_stats[:, k])[0, 1]
                                                                    if synthetic_stats[:, j].std() > 0 and synthetic_stats[:, k].std() > 0
                                                                    else np.nan)})
    pd.DataFrame(distribution).to_csv(output / "distribution_comparison.csv", index=False)
    pd.DataFrame(stat_comparisons).to_csv(output / "stat_distribution_comparison.csv", index=False)
    pd.DataFrame(joint_comparisons).to_csv(output / "joint_distribution_comparison.csv", index=False)
    arrays = {}
    for pos, group in marginal.items():
        arrays[f"{pos}_samples"] = np.asarray(group["generated_stats"])
        arrays[f"{pos}_actual"] = np.asarray(group["actual_stats"])
        arrays[f"{pos}_context"] = test[(test.position==pos) & relevant(test)][["age", "ppr17", "history_ppr17", "target_season"]].to_numpy()
    np.savez_compressed(output / "validation_samples.npz", **arrays)
    (output / "validation_protocol.json").write_text(json.dumps({
        "training_target_seasons": [2016, 2022], "held_out_target_seasons": [2023, 2024, 2025],
        "draws_per_player": draws, "seed": seed, "neighbors": model.neighbors,
        "model": "v2 conditional whole-season plus within-season game bootstrap",
        "age_bandwidth": model.age_bandwidth, "jitter": model.jitter,
        "hyperparameters": "Selected using 2019–22 distributional development folds, not individual forecast accuracy",
        "honesty": "2023–25 were inspected for v1, so v2 results are a reused historical audit, not a newly untouched test set",
        "scope": "Incumbent player forecasts; does not evaluate rookie intake or a complete league.",
        "identity": "Same player may appear in training and later holdout; only past data is used.",
        "intervals": "Discrete outcomes can make empirical interval coverage exceed nominal levels.",
        "scoring": "Full PPR, passing yards/25, passing TD=4, INT=-2, rush/rec yards/10, TD=6, offensive lost fumble=-2; no return/2pt points."
    }, indent=2) + "\n")
    return metrics
