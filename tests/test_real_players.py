"""The real-name game library must trace to the cached public NFL panel."""
import gzip
import json
from pathlib import Path
import unittest
import numpy as np
import pandas as pd
from ffsim.model import CORE

ROOT = Path(__file__).resolve().parents[1]

class RealPlayerLibraryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.library = json.loads(gzip.decompress((ROOT/'game/data/real-players.json.gz').read_bytes()))
        cls.panel = pd.read_csv(ROOT/'data/processed/player_seasons.csv')

    def test_names_positions_and_every_checkpoint_trace_to_nfl_data(self):
        self.assertGreater(len(self.library['players']), 2500)
        records = {(r.player_id, int(r.season)): r for _, r in self.panel.iterrows()}
        ids = set()
        for person in self.library['players']:
            self.assertNotIn(person['id'], ids)
            ids.add(person['id'])
            rows = self.panel[self.panel.player_id.eq(person['id'])]
            self.assertIn(person['name'], set(rows['name']))
            self.assertIn(person['position'], set(rows.position))
            for checkpoint in person['states']:
                actual = records[(person['id'], checkpoint['season'])]
                self.assertTrue(2015 <= checkpoint['season'] <= 2025)
                self.assertTrue(np.isfinite(checkpoint['age']))
                self.assertEqual(checkpoint['scheduled_games'], int(actual.scheduled_games))
                for key in CORE:
                    self.assertEqual(checkpoint[key], int(actual[key]))
                expected = int(actual.report_out_weeks) if pd.notna(actual.report_out_weeks) else None
                self.assertEqual(checkpoint['listed_out_weeks'], expected)

if __name__ == '__main__':
    unittest.main()
