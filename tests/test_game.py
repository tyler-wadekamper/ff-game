"""Behavioral tests of the game law, distinct from fitted-margin checks."""
import copy
import json
from pathlib import Path
import unittest

import numpy as np
import pandas as pd

from ffsim.calibrate import configured_model
from ffsim.league import BalancedSeason,season_index,score_scale
from ffsim.model import CORE,points

ROOT=Path(__file__).resolve().parents[1]
PANEL=ROOT/'data/processed/player_seasons.csv'


@unittest.skipUnless(PANEL.exists(),'Run ff-data build for integration tests')
class GameTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.panel=pd.read_csv(PANEL)
        cls.config={'neighbors':12,'age_bandwidth':3.,'jitter':.25}
        cls.model=configured_model(cls.config,2022).fit(cls.panel)
        cls.game=BalancedSeason(cls.model,cls.panel)
        cls.current=cls.model.panel[cls.model.panel.season==2022]

    def test_outcome_pool_never_uses_future_year(self):
        self.assertTrue(all(y<=2022 for y in self.game.years))
        self.assertTrue(all(y<=2022 for _,y in self.game.pools))

    def test_each_source_slot_used_exactly_once(self):
        season,diagnostics=self.game.sample(self.current,np.random.default_rng(42))
        for d in diagnostics:
            ids=d['assigned_source_indices']
            self.assertEqual(len(ids),d['source_n'])
            self.assertEqual(len(ids),len(set(ids)))
        self.assertFalse(season.id.duplicated().any())

    def test_seed_reproducibility(self):
        a,da=self.game.sample(self.current,np.random.default_rng(81))
        b,db=self.game.sample(self.current,np.random.default_rng(81))
        pd.testing.assert_frame_equal(a,b)
        self.assertEqual(da,db)

    def test_matching_does_not_inspect_successor_statistics(self):
        other=copy.deepcopy(self.model)
        for group,*_ in other.groups.values():
            # Tamper future outcomes without altering any historical input.
            group.loc[:,[f'next_{c}' for c in CORE]]=0
        modified=BalancedSeason(other,self.panel)
        _,a=self.game.sample(self.current,np.random.default_rng(27))
        _,b=modified.sample(self.current,np.random.default_rng(27))
        self.assertEqual([d['query_assignment'] for d in a],[d['query_assignment'] for d in b])

    def test_positive_successor_cannot_become_numerical_dropout(self):
        for pos,(group,*_) in self.model.groups.items():
            candidates=group.index[group.next_opportunities>0].to_numpy()
            rng=np.random.default_rng(4)
            ids=rng.choice(candidates,size=100)
            row=group.iloc[0]
            y,_=self.model.sample_matched(row,ids,np.full(100,.01),500,rng)
            self.assertTrue((y[:,[0,5,8]].sum(axis=1)>0).all())

    def test_fixed_score_scale_is_not_a_rank_transform(self):
        scales=score_scale(self.panel)
        for pos,scale in scales.items():
            np.testing.assert_allclose(season_index([0,scale/2,scale,2*scale],pos,scales),[0,50,100,100])

    def test_complete_population_accounting(self):
        season,_=self.game.sample(self.current,np.random.default_rng(13))
        self.assertTrue((season.completions<=season.attempts).all())
        self.assertTrue((season.receptions<=season.targets).all())
        self.assertTrue((season.receiving_tds<=season.receptions).all())
        self.assertTrue((season.passing_tds<=season.completions).all())
        self.assertTrue(season.games.between(0,17).all())
        np.testing.assert_allclose(points(season[CORE].to_numpy(float)),season.ppr)
        self.assertTrue(np.isfinite(season.age).all())

    def test_saved_ensemble_and_examples_are_not_cherry_picked(self):
        path=ROOT/'artifacts/league_seasons.csv'
        if not path.exists():self.skipTest('Run ff-data generate')
        results=pd.read_csv(path)
        showcase=json.loads((ROOT/'artifacts/showcase_players.json').read_text())
        self.assertGreaterEqual(results.simulation.nunique(),100)
        for p in showcase['players']:
            rows=results[results.id.eq(p['id'])].sort_values('simulation')
            for n,draw in enumerate(p['alternatives']):
                self.assertAlmostEqual(rows.iloc[n].ppr,draw['ppr'],places=2)

    def test_saved_realism_gates_pass(self):
        path=ROOT/'artifacts/realism_checks.csv'
        if not path.exists():self.skipTest('Run ff-data report')
        checks=pd.read_csv(path)
        self.assertTrue(checks.passed.all(),checks[~checks.passed].to_string(index=False))

    def test_full_fictional_database_has_consistent_histories(self):
        path=ROOT/'artifacts/player_database.json'
        if not path.exists():self.skipTest('Run ff-data generate')
        players=json.loads(path.read_text())['players']
        self.assertGreater(len(players),800)
        self.assertEqual(len(players),len({p['id'] for p in players}))
        for p in players:
            self.assertTrue(p['history'])
            previous=None
            for h in p['history']:
                self.assertGreaterEqual(h['age'],19)
                self.assertLessEqual(h['relative_season'],0)
                values=np.array([[h[c] for c in CORE]],float)
                self.assertAlmostEqual(points(values)[0],h['ppr'],places=2)
                if previous:
                    self.assertEqual(h['age']-previous['age'],h['relative_season']-previous['relative_season'])
                previous=h

    def test_report_payload_is_standalone_and_versioned(self):
        path=ROOT/'reports/SEASON_EXPLORER.html'
        if not path.exists():self.skipTest('Run ff-data report')
        from html.parser import HTMLParser
        class Parser(HTMLParser):
            def __init__(self):super().__init__();self.payload='';self.inside=False;self.external=[]
            def handle_starttag(self,tag,attrs):
                attrs=dict(attrs)
                self.inside=tag=='script' and attrs.get('id')=='report-data' or self.inside
                for key in ['src','href']:
                    if attrs.get(key,'').startswith(('http://','https://')):self.external.append(attrs[key])
            def handle_endtag(self,tag):
                if tag=='script':self.inside=False
            def handle_data(self,data):
                if self.inside:self.payload+=data
        parser=Parser();parser.feed(path.read_text());payload=json.loads(parser.payload)
        self.assertEqual(parser.external,[])
        self.assertEqual(len(payload['players']),12)
        self.assertTrue(all(v.startswith('data:image/png;base64,') for v in payload['images'].values()))
        self.assertEqual(payload['checks']['passed'],payload['checks']['total'])


if __name__=='__main__':unittest.main()
