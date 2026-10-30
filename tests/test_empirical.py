"""Integration tests against the downloaded corpus; no network required."""
import json
from pathlib import Path
import unittest

import numpy as np
import pandas as pd

from ffsim.data import COUNTS, add_derived
from ffsim.model import CORE, EmpiricalModel, points

ROOT = Path(__file__).resolve().parents[1]
PANEL = ROOT / 'data/processed/player_seasons.csv'


@unittest.skipUnless(PANEL.exists(), 'Run ff-data build to enable corpus integration tests')
class EmpiricalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.panel = pd.read_csv(PANEL)
        cls.model = EmpiricalModel(train_end=2022).fit(cls.panel)

    def test_regular_season_coverage_and_unique_ids(self):
        coverage = json.loads((ROOT / 'data/processed/coverage.json').read_text())
        self.assertEqual([x['season'] for x in coverage], list(range(2015, 2026)))
        for x in coverage:
            self.assertEqual(x['stats_teams'], 32)
            self.assertEqual(x['stats_max_week'], 18 if x['season'] >= 2021 else 17)
        self.assertFalse(self.panel.duplicated(['player_id', 'season']).any())
        self.assertFalse(self.panel[(self.panel.opportunities > 0)].age.isna().any())

    def test_no_target_after_training_cutoff(self):
        for group, *_ in self.model.groups.values():
            self.assertLessEqual(group.target_season.max(), 2022)

    def test_future_outcomes_do_not_change_fitted_draws(self):
        altered = self.panel.copy()
        altered.loc[altered.season >= 2023, COUNTS] = 0
        altered = add_derived(altered)
        other = EmpiricalModel(train_end=2022).fit(altered)
        query = self.model.panel[(self.model.panel.season == 2022) & (self.model.panel.position == 'QB')].iloc[0]
        original, _ = self.model.sample(query, 100, np.random.default_rng(123))
        changed, _ = other.sample(query, 100, np.random.default_rng(123))
        np.testing.assert_array_equal(original, changed)

    def test_samples_reproducible_and_accounted_for(self):
        for pos in ['QB', 'RB', 'WR', 'TE']:
            query = self.model.panel[(self.model.panel.season == 2022) & self.model.panel.position.eq(pos)].sort_values('ppr17').iloc[-1]
            a, _ = self.model.sample(query, 100, np.random.default_rng(3))
            b, _ = self.model.sample(query, 100, np.random.default_rng(3))
            np.testing.assert_array_equal(a, b)
            self.assertTrue(np.isfinite(a).all())
            self.assertTrue((a[:, CORE.index('receptions')] <= a[:, CORE.index('targets')]).all())
            self.assertTrue((a[:, CORE.index('completions')] <= a[:, CORE.index('attempts')]).all())
            self.assertTrue((a[:, CORE.index('games')] <= 17).all())

    def test_injury_reports_are_not_missed_game_labels(self):
        cmc = self.panel[(self.panel['name'] == 'Christian McCaffrey') & (self.panel.season == 2020)].iloc[0]
        self.assertEqual(cmc.games, 3)
        self.assertLess(cmc.report_out_weeks, cmc.scheduled_games-cmc.games)

    def test_generated_players_have_no_identity_fields_and_valid_points(self):
        path = ROOT / 'artifacts/showcase_players.json'
        if not path.exists():
            self.skipTest('Run ff-data generate')
        profiles = json.loads(path.read_text())['players']
        self.assertEqual(len(profiles), 12)
        def check_keys(value):
            if isinstance(value, dict):
                self.assertFalse({'name', 'team', 'player_id', 'gsis_id', 'historical_anchor_id'} & value.keys())
                for v in value.values(): check_keys(v)
            elif isinstance(value, list):
                for v in value: check_keys(v)
        check_keys(profiles)
        for p in profiles:
            for future in p['alternatives']:
                values = np.array([[future[c] for c in CORE]], dtype=float)
                self.assertAlmostEqual(points(values)[0], future['ppr'], places=2)


if __name__ == '__main__':
    unittest.main()
