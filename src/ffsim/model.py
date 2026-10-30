"""Conditional empirical transition bootstrap; not a fitted causal injury model.

Given a history, select similar historical current->next transitions, then apply
their joint changes to a smoothed baseline. One donor supplies all components,
preserving relationships between workload, availability and efficiency.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.special import softmax
from sklearn.preprocessing import StandardScaler
from sklearn.neighbors import NearestNeighbors

from .data import COUNTS, fantasy, scheduled_games, transitions

CORE = ["attempts", "completions", "passing_yards", "passing_tds", "passing_interceptions",
        "carries", "rushing_yards", "rushing_tds", "targets", "receptions", "receiving_yards", "receiving_tds",
        "sack_fumbles_lost", "rushing_fumbles_lost", "receiving_fumbles_lost", "games"]

# Per-season equivalent stabilizers: prevent tiny denominator ratios from exploding.
# These are explicit modeling choices, not historical parameter estimates.
OFFSETS = np.array([100, 60, 700, 5, 3, 40, 160, 2, 30, 20, 200, 2, 1, 1, 1, 4], dtype=float)


def relevant(frame: pd.DataFrame) -> pd.Series:
    return ((frame.position.eq("QB") & (frame.attempts >= 100))
            | (frame.position.eq("RB") & (frame.opportunities >= 75))
            | (frame.position.eq("WR") & (frame.targets >= 40))
            | (frame.position.eq("TE") & (frame.targets >= 25)))


def history_features(panel: pd.DataFrame) -> pd.DataFrame:
    frame = panel.sort_values(["player_id", "season"]).copy()
    # Previous history only; rolling is within player and never includes next year.
    frame["history_ppr17"] = frame.groupby("player_id").ppr17.transform(lambda s: s.rolling(3, min_periods=1).mean())
    frame["history_games"] = frame.groupby("player_id").participation_fraction.transform(lambda s: s.rolling(3, min_periods=1).mean())
    return frame


def features(frame: pd.DataFrame) -> np.ndarray:
    games = frame.games.clip(lower=1)
    values = [frame.age.fillna(26), frame.experience.fillna(2).clip(0),
              frame.participation_fraction.clip(0, 1),
              np.log1p(frame.attempts / games), np.log1p(frame.carries / games),
              np.log1p(frame.targets / games),
              np.arcsinh(frame.ppr_per_game.fillna(0) / 5),
              np.arcsinh(frame.history_ppr17.fillna(frame.ppr17) / 80),
              frame.history_games.fillna(frame.participation_fraction).clip(0, 1),
              frame.report_out_weeks.fillna(0) / frame.scheduled_games,
              # Smoothed rates: denominator floors avoid one-play outliers.
              frame.passing_yards / (frame.attempts + 50),
              frame.rushing_yards / (frame.carries + 25),
              frame.receiving_yards / (frame.targets + 20)]
    return np.nan_to_num(np.column_stack(values).astype(float))


def repair(values: np.ndarray) -> np.ndarray:
    """Enforce event accounting, without clipping to observed season maxima."""
    if not np.isfinite(values).all():
        raise ValueError('Non-finite simulated statistics')
    y = np.rint(values).astype(float)
    # Net yardage can be negative (kneels, sacks are separate, backward catches).
    # Event counts cannot. Do not silently turn a real loss into zero production.
    nonnegative=[n for n,c in enumerate(CORE) if c not in ['passing_yards','rushing_yards','receiving_yards']]
    y[:,nonnegative]=np.maximum(y[:,nonnegative],0)
    idx = {c: n for n, c in enumerate(CORE)}
    y[:, idx["games"]] = np.clip(y[:, idx["games"]], 0, 17)
    for child, parent in [("completions", "attempts"), ("passing_tds", "completions"),
                          ("receptions", "targets"), ("receiving_tds", "receptions"),
                          ("rushing_tds", "carries")]:
        y[:, idx[child]] = np.minimum(y[:, idx[child]], y[:, idx[parent]])
    y[:, idx["passing_interceptions"]] = np.minimum(y[:, idx["passing_interceptions"]], y[:, idx["attempts"]] - y[:, idx["completions"]])
    for yards, events in [("passing_yards", "completions"), ("receiving_yards", "receptions"), ("rushing_yards", "carries")]:
        y[y[:, idx[events]] == 0, idx[yards]] = 0
    for lost, events in [("sack_fumbles_lost", "attempts"), ("rushing_fumbles_lost", "carries"), ("receiving_fumbles_lost", "receptions")]:
        y[:, idx[lost]] = np.minimum(y[:, idx[lost]], y[:, idx[events]])
    y[y[:, idx["games"]] == 0, :-1] = 0
    return y


def points(values: np.ndarray) -> np.ndarray:
    d = pd.DataFrame(values, columns=CORE)
    d["lost_fumbles"] = d.sack_fumbles_lost + d.rushing_fumbles_lost + d.receiving_fumbles_lost
    return fantasy(d).to_numpy()


class LegacyEmpiricalModel:
    """Fit only to transitions whose target season is <= train_end.

    z=log1p(count/offset); draw matched donor d and transfer its joint change:
    z_next = z_d,next + elasticity * (z_query,current - z_d,current).
    Counts are normalized to a 17-game era. Elasticity is fixed before holdout.
    This is an empirical baseline, not the full latent weekly offense model.
    """
    def __init__(self, train_end: int = 2022, neighbors: int = 40, elasticity: float = 0.5):
        self.train_end, self.neighbors, self.elasticity = train_end, neighbors, elasticity
        self.groups = {}

    def fit(self, panel: pd.DataFrame):
        self.panel = history_features(panel)
        pairs = transitions(self.panel)
        # transitions drops no history feature, so current columns are retained.
        train = pairs[pairs.target_season <= self.train_end].copy()
        for pos, group in train.groupby("position"):
            group = group.reset_index(drop=True)
            scaler = StandardScaler().fit(features(group))
            x = scaler.transform(features(group))
            # Position/style, production, and age dominate; administrative history less.
            weights = np.array([1.3, .4, .8, 1.1, 1.1, 1.1, 1.3, 1., .5, .35, .6, .6, .6])
            x *= weights
            search = NearestNeighbors(n_neighbors=min(self.neighbors * 3, len(group))).fit(x)
            self.groups[pos] = (group, scaler, weights, search)
        return self

    def sample(self, row: pd.Series, draws: int, rng: np.random.Generator, exclude_player: bool = False):
        group, scaler, feature_weights, search = self.groups[row.position]
        query = pd.DataFrame([row])
        x = scaler.transform(features(query)) * feature_weights
        distances, ids = search.kneighbors(x)
        ids, distances = ids[0], distances[0]
        if exclude_player:
            mask = group.iloc[ids].player_id.ne(row.player_id).to_numpy()
            ids, distances = ids[mask], distances[mask]
        ids, distances = ids[:self.neighbors], distances[:self.neighbors]
        if not len(ids):
            raise ValueError("No independent analogs")
        # Relative distances set weights; no test-set tuning.
        bandwidth = max(float(np.median(distances)), .5)
        probabilities = softmax(-distances ** 2 / (2 * bandwidth ** 2))
        selected = rng.choice(ids, size=draws, p=probabilities)
        donor = group.iloc[selected]
        current = donor[CORE].to_numpy(dtype=float) * (17 / donor.scheduled_games.to_numpy())[:, None]
        future = donor[[f"next_{c}" for c in CORE]].to_numpy(dtype=float)
        future *= (17 / scheduled_games(donor.target_season))[:, None]
        q = row[CORE].to_numpy(dtype=float) * 17 / row.scheduled_games
        # Negative net rushing yardage is supported in raw summaries, but this
        # log-count prototype floors it at zero (explicit limitation).
        z_current = np.log1p(np.maximum(current, 0) / OFFSETS)
        z_query = np.log1p(np.maximum(q, 0) / OFFSETS)
        z_future = np.log1p(np.maximum(future, 0) / OFFSETS)
        result = np.expm1(z_future + self.elasticity * (z_query - z_current)) * OFFSETS
        # Preserve structural zeros and joint dropout events from the donor.
        result[future == 0] = 0
        # Passing belongs to QB; gadget throws for other positions are omitted.
        if row.position != "QB":
            result[:, :5] = 0
            result[:, 12] = 0
        values = repair(result)
        diagnostics = {"effective_analogs": float(1 / np.sum(probabilities ** 2)),
                       "nearest_distance": float(distances[0]),
                       "donor_target_max": int(group.iloc[ids].target_season.max())}
        return values, diagnostics


class EmpiricalModel(LegacyEmpiricalModel):
    """Game-oriented conditional joint season sampler (v2).

    Whole observed successor seasons establish workload/availability/efficiency.
    Optional within-season game bootstrap supplies new stat lines without log
    extrapolation. Age is measured in years, not diluted by population variance.
    A zero-production draw must come from a zero-production historical successor.
    """
    def __init__(self, train_end=2022, neighbors=24, age_bandwidth=2.0,
                 jitter=.25, weekly=None):
        super().__init__(train_end, neighbors, elasticity=0.)
        self.age_bandwidth, self.jitter, self.weekly = age_bandwidth, jitter, weekly
        if not 0 <= jitter < .5:
            raise ValueError("jitter must be in [0, .5) to preserve sparse production")

    def fit(self, panel):
        super().fit(panel)
        for pos, (group, scaler, _, _) in self.groups.items():
            weights = np.array([scaler.scale_[0]/self.age_bandwidth, .35, .8,
                                1.2, 1.2, 1.2, 1.1, 1., .6, .25, .6, .6, .6])
            x = scaler.transform(features(group)) * weights
            search = NearestNeighbors(n_neighbors=min(self.neighbors*4, len(group))).fit(x)
            self.groups[pos] = group, scaler, weights, search
        return self

    def analogs(self, rows, exclude_player=False):
        """Batch matching for one position, using current/past information only."""
        if rows.position.nunique() != 1:
            raise ValueError("Match one position at a time")
        group, scaler, weights, search = self.groups[rows.position.iloc[0]]
        distances, ids = search.kneighbors(scaler.transform(features(rows))*weights)
        matched, probabilities = [], []
        for row_index, (d, candidates) in enumerate(zip(distances, ids)):
            if exclude_player:
                keep = group.iloc[candidates].player_id.ne(rows.player_id.iloc[row_index]).to_numpy()
                d, candidates = d[keep], candidates[keep]
            d, candidates = d[:self.neighbors], candidates[:self.neighbors]
            if not len(candidates):
                raise ValueError("No independent analogs")
            bandwidth = max(float(np.median(d)), .5)
            matched.append(candidates)
            probabilities.append(softmax(-d*d/(2*bandwidth*bandwidth)))
        return matched, probabilities

    def sample_matched(self, row, ids, probabilities, draws, rng):
        group = self.groups[row.position][0]
        selected = rng.choice(ids, size=draws, p=probabilities)
        donor = group.iloc[selected]
        future = donor[[f"next_{c}" for c in CORE]].to_numpy(float)
        future *= (17/scheduled_games(donor.target_season))[:, None]
        result = future.copy()
        if self.weekly is not None and self.jitter:
            for index in np.unique(selected):
                mask = selected == index
                d = group.iloc[index]
                games = int(min(17, round(float(d.next_games)*17/int(scheduled_games(d.target_season)))))
                observations = self.weekly.get((d.player_id, int(d.target_season)))
                if observations is None or games == 0:
                    continue
                # Pad games with no offensive events (e.g. special-team appearances).
                recorded_games = max(int(d.next_games), len(observations))
                padded = np.zeros((recorded_games, len(CORE)-1))
                padded[:len(observations)] = observations
                n = int(mask.sum())
                weights = rng.multinomial(games, np.full(recorded_games, 1/recorded_games), size=n)
                resampled = weights @ padded
                result[mask, :-1] = ((1-self.jitter)*future[mask, :-1] + self.jitter*resampled)
        # Structural zeros stay zero; no arbitrary query correction creates exits.
        result[future == 0] = 0
        values = repair(result)
        return values, {"effective_analogs": float(1/np.sum(probabilities**2)),
                        "donor_target_max": int(group.iloc[ids].target_season.max()),
                        "donor_zero_probability": float(np.dot(probabilities, group.iloc[ids].next_opportunities.eq(0))),
                        "nearest_distance": float("nan")}

    def sample(self, row, draws, rng, exclude_player=False):
        ids, probabilities = self.analogs(pd.DataFrame([row]), exclude_player)
        return self.sample_matched(row, ids[0], probabilities[0], draws, rng)


def load_weekly(raw):
    """Game-level box scores for plausible within-season bootstrap variation."""
    from pathlib import Path
    result = {}
    for path in sorted(Path(raw).glob("stats_*.csv")):
        data = pd.read_csv(path, usecols=["player_id", "season", "season_type", "game_id"]+CORE[:-1])
        data = data[data.season_type.eq("REG")]
        for (player, year), group in data.groupby(["player_id", "season"]):
            result[(player, int(year))] = group[CORE[:-1]].to_numpy(float)
    return result
