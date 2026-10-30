"""Build a player-season panel, retaining zero-production roster players."""
from __future__ import annotations

import json
from pathlib import Path
import numpy as np
import pandas as pd

POSITIONS = ("QB", "RB", "WR", "TE")
COUNTS = ["attempts", "completions", "passing_yards", "passing_tds", "passing_interceptions",
          "carries", "rushing_yards", "rushing_tds", "targets", "receptions", "receiving_yards",
          "receiving_tds", "sack_fumbles_lost", "rushing_fumbles_lost", "receiving_fumbles_lost"]


def scheduled_games(season):
    return np.where(np.asarray(season) >= 2021, 17, 16)


def position(series: pd.Series) -> pd.Series:
    return series.replace({"FB": "RB", "HB": "RB"})


def fantasy(frame: pd.DataFrame) -> pd.Series:
    """Full PPR; four-point passing TDs; offensive lost fumbles only."""
    return (frame.passing_yards / 25 + 4 * frame.passing_tds - 2 * frame.passing_interceptions
            + (frame.rushing_yards + frame.receiving_yards) / 10
            + 6 * (frame.rushing_tds + frame.receiving_tds) + frame.receptions
            - 2 * frame.lost_fumbles)


def add_derived(frame: pd.DataFrame) -> pd.DataFrame:
    frame = frame.copy()
    frame["scheduled_games"] = scheduled_games(frame.season)
    frame["touches"] = frame.carries + frame.receptions
    frame["ball_handling_events"] = frame.attempts + frame.touches
    frame["opportunities"] = frame.attempts + frame.carries + frame.targets
    frame["lost_fumbles"] = frame.sack_fumbles_lost + frame.rushing_fumbles_lost + frame.receiving_fumbles_lost
    frame["ppr"] = fantasy(frame)
    frame["ppr17"] = frame.ppr * 17 / frame.scheduled_games
    denominator = frame.games.replace(0, np.nan)
    frame["ppr_per_game"] = frame.ppr / denominator
    frame["opportunities_per_game"] = frame.opportunities / denominator
    frame["participation_fraction"] = frame.games / frame.scheduled_games
    for name, num, den in [
        ("completion_rate", "completions", "attempts"),
        ("passing_yards_per_attempt", "passing_yards", "attempts"),
        ("passing_td_rate", "passing_tds", "attempts"),
        ("interception_rate", "passing_interceptions", "attempts"),
        ("rushing_yards_per_carry", "rushing_yards", "carries"),
        ("rushing_td_rate", "rushing_tds", "carries"),
        ("catch_rate", "receptions", "targets"),
        ("receiving_yards_per_reception", "receiving_yards", "receptions"),
        ("receiving_td_rate", "receiving_tds", "receptions"),
        ("rushing_opportunity_share", "carries", "opportunities"),
    ]:
        frame[name] = frame[num] / frame[den].replace(0, np.nan)
    frame["lost_fumble_rate"] = frame.lost_fumbles / frame.ball_handling_events.replace(0, np.nan)
    frame["role"] = "depth"
    qb = frame.position.eq("QB")
    frame.loc[qb & (frame.attempts >= 100), "role"] = "part_time"
    frame.loc[qb & (frame.attempts >= 300), "role"] = "starter"
    rb = frame.position.eq("RB")
    frame.loc[rb & (frame.opportunities >= 75), "role"] = "committee"
    frame.loc[rb & (frame.opportunities >= 200), "role"] = "lead"
    for p in ["WR", "TE"]:
        mask = frame.position.eq(p)
        low, high = (40, 100) if p == "WR" else (25, 75)
        frame.loc[mask & (frame.targets >= low), "role"] = "supporting"
        frame.loc[mask & (frame.targets >= high), "role"] = "primary"
    return frame


def build(raw: Path, output: Path, start: int = 2015, end: int = 2025) -> pd.DataFrame:
    output.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((raw / "manifest.json").read_text())
    players = pd.read_csv(raw / "players.csv", low_memory=False)
    metadata = players.dropna(subset=["gsis_id"]).drop_duplicates("gsis_id")
    mapping = metadata[["pfr_id", "gsis_id"]].dropna().drop_duplicates("pfr_id")
    panels, coverage = [], []
    for year in range(start, end + 1):
        rosters = pd.read_csv(raw / f"rosters_{year}.csv", low_memory=False)
        rosters["position"] = position(rosters.position)
        rosters = rosters[rosters.position.isin(POSITIONS) & rosters.gsis_id.notna()]
        base = rosters.drop_duplicates("gsis_id")[["gsis_id", "position", "full_name", "birth_date", "rookie_year"]]
        base = base.rename(columns={"gsis_id": "player_id", "full_name": "name"})
        stats = pd.read_csv(raw / f"stats_{year}.csv", low_memory=False)
        stats = stats[stats.season_type.eq("REG")].copy()
        stats["position"] = position(stats.position)
        stats = stats[stats.position.isin(POSITIONS)]
        if stats.duplicated(["player_id", "game_id"]).any():
            raise ValueError(f"Duplicate player/game stats in {year}")
        absent = stats[~stats.player_id.isin(base.player_id)].drop_duplicates("player_id")
        if len(absent):
            extras = absent[["player_id", "position", "player_display_name"]].rename(columns={"player_display_name": "name"})
            extras = extras.merge(metadata[["gsis_id", "birth_date", "rookie_season"]], left_on="player_id", right_on="gsis_id", how="left")
            extras = extras.rename(columns={"rookie_season": "rookie_year"}).drop(columns="gsis_id")
            base = pd.concat([base, extras], ignore_index=True)
        # Statistics position takes precedence over end-of-season roster position.
        pos = stats.groupby("player_id").position.agg(lambda s: s.mode().iloc[0])
        base["position"] = base.player_id.map(pos).fillna(base.position)
        grouped = stats.groupby("player_id")[COUNTS].sum()
        base = base.merge(grouped, on="player_id", how="left")
        base[COUNTS] = base[COUNTS].fillna(0)
        handling = stats[(stats.attempts + stats.carries + stats.targets + stats.sacks_suffered) > 0]
        stat_games = handling.groupby("player_id").game_id.nunique()

        snaps = pd.read_csv(raw / f"snaps_{year}.csv", low_memory=False)
        snaps = snaps[snaps.game_type.eq("REG")].copy()
        snaps = snaps.merge(mapping, left_on="pfr_player_id", right_on="pfr_id", how="left")
        # Annual rosters can map IDs missing from the cross-era player table.
        roster_map = rosters.dropna(subset=["pfr_id"]).drop_duplicates("pfr_id").set_index("pfr_id").gsis_id
        snaps["gsis_id"] = snaps.gsis_id.fillna(snaps.pfr_player_id.map(roster_map))
        positive = snaps[(snaps.offense_snaps + snaps.defense_snaps + snaps.st_snaps) > 0]
        snap_games = positive.groupby("gsis_id").game_id.nunique()
        base["games"] = np.maximum(base.player_id.map(stat_games).fillna(0), base.player_id.map(snap_games).fillna(0)).astype(int)
        base["offense_snaps"] = base.player_id.map(snaps.groupby("gsis_id").offense_snaps.sum()).fillna(0)
        base["season"] = year
        meta = metadata.set_index("gsis_id")
        base["birth_date"] = base.birth_date.fillna(base.player_id.map(meta.birth_date))
        base["rookie_year"] = base.rookie_year.fillna(base.player_id.map(meta.rookie_season))
        birth = pd.to_datetime(base.birth_date, errors="coerce")
        base["age"] = (pd.Timestamp(year, 9, 1) - birth).dt.days / 365.2425
        base["experience"] = year - pd.to_numeric(base.rookie_year, errors="coerce")
        injury_path = raw / f"injuries_{year}.csv"
        injury_coverage = {}
        if injury_path.exists() and manifest["files"][injury_path.name]["status"] == "downloaded":
            injuries = pd.read_csv(injury_path, low_memory=False)
            kind = "game_type" if "game_type" in injuries else "season_type"
            injuries = injuries[injuries[kind].eq("REG") & injuries.gsis_id.notna()]
            injuries["report_status"] = injuries.report_status.fillna("").str.strip().str.lower()
            for label, mask in [("report_listed_weeks", pd.Series(True, index=injuries.index)),
                                ("report_out_weeks", injuries.report_status.eq("out")),
                                ("report_doubtful_weeks", injuries.report_status.eq("doubtful"))]:
                counts = injuries[mask].groupby("gsis_id").week.nunique()
                base[label] = base.player_id.map(counts).fillna(0).astype(int)
            injury_coverage = {"injury_rows": len(injuries), "injury_weeks": sorted(map(int, injuries.week.unique())),
                               "injury_teams": int(injuries.team.nunique())}
        else:
            for label in ["report_listed_weeks", "report_out_weeks", "report_doubtful_weeks"]:
                base[label] = np.nan
        coverage.append({"season": year, "roster_players": len(base), "stat_rows": len(stats),
                         "stats_max_week": int(stats.week.max()), "stats_teams": int(stats.team.nunique()),
                         "snap_rows": len(snaps), "unmapped_snap_rows": int(snaps.gsis_id.isna().sum()),
                         "missing_birth_dates": int(base.age.isna().sum()), **injury_coverage})
        panels.append(base)
    panel = add_derived(pd.concat(panels, ignore_index=True))
    if panel.duplicated(["player_id", "season"]).any():
        raise ValueError("Duplicate player-season")
    if (panel.completions > panel.attempts).any() or (panel.receptions > panel.targets).any():
        raise ValueError("Invalid completion/reception counts")
    panel.to_csv(output / "player_seasons.csv", index=False)
    (output / "coverage.json").write_text(json.dumps(coverage, indent=2) + "\n")
    return panel


def transitions(panel: pd.DataFrame, target_end: int = 2025) -> pd.DataFrame:
    """Keep nonreturners as zero observed production; never treat 2025 as an exit."""
    current = panel[panel.season < target_end].copy()
    following = panel.copy()
    following["season"] -= 1
    following = following.rename(columns={c: f"next_{c}" for c in following.columns if c not in ["player_id", "season"]})
    result = current.merge(following, on=["player_id", "season"], how="left", validate="one_to_one")
    result["next_rostered"] = result.next_position.notna()
    for column in COUNTS + ["ppr", "ppr17", "games", "opportunities", "lost_fumbles", "offense_snaps"]:
        result[f"next_{column}"] = result[f"next_{column}"].fillna(0)
    result["next_role"] = result.next_role.fillna("not_rostered")
    result["target_season"] = result.season + 1
    return result
