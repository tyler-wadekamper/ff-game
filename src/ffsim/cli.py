from __future__ import annotations

import argparse
from pathlib import Path
import pandas as pd

from .download import download
from .data import build
from .analysis import analyze
from .evaluate import validate
from .generate import generate


def main():
    parser = argparse.ArgumentParser(description="Reproducible 2015–2025 NFL player-model research")
    parser.add_argument("command", choices=["download", "download-adp", "build", "analyze", "calibrate", "validate", "audit-game", "generate", "report", "draft-weekly", "all"])
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--refresh", action="store_true", help="Redownload and replace cached source files")
    parser.add_argument("--draws", type=int, default=256)
    parser.add_argument("--seasons", type=int, default=100, help="Complete alternative league seasons")
    parser.add_argument("--audit-seasons", type=int, default=64, help="Game audit replicates per historical year")
    parser.add_argument("--weekly-draws", type=int, default=20, help="Weekly paths per audit player-season")
    args = parser.parse_args()
    root = args.root.resolve()
    raw, processed, artifacts = root / "data/raw", root / "data/processed", root / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    if args.command=='download-adp':
        from .draft_data import download_adp
        download_adp(raw);return
    if args.command=='draft-weekly':
        from .extensions import build_extensions
        build_extensions(root,args.weekly_draws);return
    if args.command in ["all", "download"]:
        download(raw, refresh=args.refresh)
    if args.command in ["all", "build"]:
        build(raw, processed)
    if args.command not in ["download", "build"]:
        panel = pd.read_csv(processed / "player_seasons.csv")
        if args.command in ["all", "analyze"]:
            analyze(panel, artifacts)
        if args.command == "calibrate" or (args.command == "all" and not (artifacts/'model_config.json').exists()):
            from .calibrate import calibrate
            from .model import load_weekly
            calibrate(panel, artifacts, load_weekly(raw))
        if args.command in ["all", "validate"]:
            print(validate(panel, artifacts, draws=args.draws).to_string(index=False))
        if args.command in ["all", "generate"]:
            generate(panel, artifacts, replicates=args.seasons)
        if args.command in ["all", "audit-game"]:
            from .game_audit import audit_game
            print(audit_game(panel,artifacts,args.audit_seasons).to_string(index=False))
        if args.command in ["all", "report"]:
            from .reliability import assess
            from .presentation import present
            checks=assess(panel,artifacts)
            present(root)
            if not checks.passed.all():
                raise SystemExit('Realism acceptance checks failed; see artifacts/realism_checks.csv')
        if args.command=='all':
            from .extensions import build_extensions
            build_extensions(root,args.weekly_draws)


if __name__ == "__main__":
    main()
