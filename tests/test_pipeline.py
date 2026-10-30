import unittest
import numpy as np
import pandas as pd

from ffsim.data import COUNTS, add_derived, scheduled_games, transitions
from ffsim.model import CORE, repair, points
from ffsim.evaluate import crps


class AccountingTests(unittest.TestCase):
    def test_repair_event_constraints(self):
        x = np.full((2, len(CORE)), 100.)
        x[0, CORE.index('attempts')] = 10
        x[0, CORE.index('targets')] = 5
        x[1, CORE.index('games')] = 0
        y = repair(x)
        self.assertLessEqual(y[0, CORE.index('completions')], 10)
        self.assertLessEqual(y[0, CORE.index('receptions')], 5)
        self.assertLessEqual(y[0, CORE.index('passing_interceptions')], 10-y[0, CORE.index('completions')])
        self.assertTrue(np.all(y[1] == 0))

    def test_ppr_known_line(self):
        x = np.zeros((1, len(CORE)))
        values = dict(attempts=30, completions=20, passing_yards=250, passing_tds=2,
                      passing_interceptions=1, carries=4, rushing_yards=30, rushing_tds=1,
                      targets=3, receptions=2, receiving_yards=20, receiving_tds=0,
                      rushing_fumbles_lost=1, games=1)
        for k, v in values.items(): x[0, CORE.index(k)] = v
        self.assertEqual(points(x)[0], 27.)

    def test_schedule_era(self):
        np.testing.assert_array_equal(scheduled_games([2015, 2020, 2021, 2025]), [16, 16, 17, 17])

    def test_negative_net_yardage_is_preserved(self):
        x=np.zeros((1,len(CORE)))
        for key,value in dict(games=1,attempts=1,completions=1,passing_yards=-5,
                              carries=2,rushing_yards=-7,targets=1,receptions=1,receiving_yards=-2).items():
            x[0,CORE.index(key)]=value
        y=repair(x)
        self.assertEqual(y[0,CORE.index('rushing_yards')],-7)
        self.assertEqual(y[0,CORE.index('receiving_yards')],-2)
        self.assertEqual(y[0,CORE.index('passing_yards')],-5)

    def test_missing_next_season_is_not_dropped(self):
        records = []
        for player, season in [('A', 2024), ('B', 2024), ('B', 2025)]:
            r = dict(player_id=player, season=season, position='RB', games=10,
                     report_out_weeks=0, age=25, experience=2, offense_snaps=100)
            r.update({c: 0 for c in COUNTS})
            r['carries'], r['rushing_yards'] = 100, 400
            records.append(r)
        pairs = transitions(add_derived(pd.DataFrame(records)))
        self.assertEqual(len(pairs), 2)
        self.assertEqual(pairs.loc[pairs.player_id.eq('A'), 'next_ppr17'].iloc[0], 0)
        self.assertFalse(pairs.loc[pairs.player_id.eq('A'), 'next_rostered'].iloc[0])
        self.assertNotIn(2026, pairs.target_season.values)

    def test_crps_matches_bruteforce(self):
        x = np.array([0., 3., 8., 15.])
        expected = np.mean(abs(x-4)) - .5*np.mean(abs(x[:, None]-x[None, :]))
        self.assertAlmostEqual(crps(x, 4), expected)


if __name__ == '__main__':
    unittest.main()
