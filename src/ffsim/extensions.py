"""Reproducible end-to-end ADP and weekly-results build."""
from pathlib import Path
import json
import pickle
import pandas as pd
from .draft_data import download_adp,build_adp
from .adp import fit_and_assign
from .weekly import WeeklyLibrary
from .weekly_validation import calibrate_weekly,evaluate_weekly,audit_weekly_structure
from .draft_weekly import make_weekly_outputs
from .draft_weekly_report import render_extensions


def build_extensions(root,weekly_draws=20):
    root=Path(root);out=root/'artifacts';raw=root/'data/raw'
    panel=pd.read_csv(root/'data/processed/player_seasons.csv')
    download_adp(raw)
    adp,players=build_adp(raw,panel,out)
    fit_and_assign(panel,adp,players,json.loads((out/'player_database.json').read_text()),out)
    library=WeeklyLibrary.load(raw,panel)
    # A trusted local cache for corpus regression tests; raw CSVs stay authoritative.
    (out/'weekly_library.pkl').write_bytes(pickle.dumps(library))
    config=calibrate_weekly(library,out)
    _,checks=evaluate_weekly(library,out,draws=weekly_draws,retention=config['shape_retention'])
    structural=audit_weekly_structure(library,out,config['shape_retention'])
    make_weekly_outputs(root,library)
    render_extensions(root)
    if not checks.passed.all():raise RuntimeError('Weekly distribution acceptance gates failed; inspect the report')
    if structural['failed']:raise RuntimeError('Weekly full-corpus accounting failed; inspect the report')
