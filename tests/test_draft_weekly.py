"""Real-corpus regression and invariant tests for ADP and weekly disaggregation."""
import json
import pickle
from pathlib import Path
import unittest
import numpy as np
import pandas as pd

from ffsim.adp import ADPModel,FEATURES,history_vector
from ffsim.data import add_derived
from ffsim.model import CORE,points
from ffsim.weekly import WeeklyModel,allocate,allocate_yards,sample_events,weekly_engine_fingerprint

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'artifacts'


class AllocationTests(unittest.TestCase):
    def test_randomized_capacity_conservation(self):
        rng=np.random.default_rng(22)
        for _ in range(100):
            cap=rng.integers(0,20,17);total=int(rng.integers(cap.sum()+1));w=rng.random(17)
            y=allocate(total,w,cap,rng)
            self.assertEqual(y.sum(),total);self.assertTrue((y<=cap).all());self.assertTrue((y>=0).all())

    def test_zero_weights_still_respect_capacities(self):
        np.testing.assert_array_equal(allocate(4,[0,0],[1,3]),[1,3])

    def test_impossible_capacity_rejected(self):
        with self.assertRaises(ValueError):allocate(5,[1,1],[1,2])

    def test_signed_yardage_and_laterals(self):
        rng=np.random.default_rng(1)
        y=allocate_yards(-7,np.array([1,2]),np.array([-2.,3.]),np.array([1,2]),rng)
        self.assertEqual(y.sum(),-7)
        lateral=allocate_yards(11,np.zeros(3,int),np.zeros(3),np.zeros(3),rng,True)
        self.assertEqual(lateral.sum(),11);self.assertEqual(np.count_nonzero(lateral),1)

    def test_passing_yards_need_a_completion(self):
        with self.assertRaises(ValueError):allocate_yards(5,np.zeros(3,int),np.zeros(3),np.zeros(3),np.random.default_rng(1))

    def test_positive_yardage_does_not_invent_negative_games(self):
        rng=np.random.default_rng(1)
        for _ in range(200):
            events=rng.integers(1,100,17);yards=rng.integers(0,1000,17);source_events=rng.integers(1,50,17)
            total=int(rng.integers(1,20));x=allocate_yards(total,events,yards,source_events,rng)
            self.assertEqual(x.sum(),total);self.assertTrue((x>=0).all())

    def test_one_observed_td_week_does_not_absorb_an_entire_new_season(self):
        rng=np.random.default_rng(17);source=np.r_[1,np.zeros(16)];exposure=np.full(17,20)
        samples=np.array([sample_events(20,source,exposure,exposure,500,rng) for _ in range(1000)])
        self.assertTrue((samples.sum(axis=1)==20).all());self.assertLess(samples[:,0].mean(),2)


@unittest.skipUnless((OUT/'adp_training_features.csv').exists(),'Run ff-data draft-weekly')
class ADPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data=pd.read_csv(OUT/'adp_training_features.csv');cls.model=ADPModel(2022).fit(cls.data)

    def test_targets_after_cutoff_are_excluded(self):
        self.assertLessEqual(self.model.training.draft_year.max(),2022)

    def test_changing_later_market_targets_cannot_change_prices(self):
        other=self.data.copy();other.loc[other.draft_year>=2023,'target']=-100
        model=ADPModel(2022).fit(other);query=self.data[self.data.draft_year==2023].iloc[:20].reset_index(drop=True)
        a,_=self.model.estimate(query);b,_=model.estimate(query)
        np.testing.assert_array_equal(a,b)

    def test_gadget_throws_do_not_dominate_rb_prices(self):
        row=self.data[(self.data.position=='RB')&(self.data.draft_year==2023)].iloc[0].copy()
        changed=row.copy();changed['passing_ypg']=90;changed['attempts_pg']=5
        x=pd.DataFrame([row,changed]).reset_index(drop=True);scores,_=self.model.estimate(x)
        self.assertAlmostEqual(scores[0],scores[1],places=10)

    def test_calendar_gap_is_not_mistaken_for_recent_production(self):
        h=pd.DataFrame([{'season':2018,'ppr17':300,'ppr':300,'games':17,'attempts':300,'carries':0,'targets':0,
                         'passing_yards':3000,'rushing_yards':0,'receiving_yards':0,'passing_tds':20,'rushing_tds':0,
                         'receiving_tds':0,'report_out_weeks':0},
                        {'season':2025,'ppr17':0,'ppr':0,'games':0,'attempts':0,'carries':0,'targets':0,
                         'passing_yards':0,'rushing_yards':0,'receiving_yards':0,'passing_tds':0,'rushing_tds':0,
                         'receiving_tds':0,'report_out_weeks':0}])
        x=dict(zip(FEATURES,history_vector(h,30,2026)))
        self.assertEqual(x['mean3'],0);self.assertEqual(x['max3'],0);self.assertEqual(x['years_since_last'],7)

    def test_future_season_rows_are_not_features(self):
        p=pd.read_csv(ROOT/'data/processed/player_seasons.csv');h=p[p.name.eq('Lamar Jackson')]
        a=history_vector(h,22,2019);changed=h.copy();changed.loc[changed.season>=2019,'ppr17']=100000
        b=history_vector(changed,22,2019);np.testing.assert_array_equal(a,b)
        self.assertAlmostEqual(a[2],h.loc[h.season==2018,'ppr17'].iloc[0])

    def test_no_history_has_explicit_indicator(self):
        x=history_vector(pd.DataFrame(columns=['season']),22,2026)
        self.assertEqual(len(x),len(FEATURES));self.assertEqual(x[-1],1)

    def test_entire_pool_has_finite_adp_and_pick_mass(self):
        p=pd.read_csv(OUT/'generated_adp.csv');n=len(p)
        self.assertEqual(n,972);self.assertFalse(p.player_id.duplicated().any())
        self.assertTrue(p.adp.between(1,n).all());self.assertEqual(p['rank'].nunique(),n)
        self.assertAlmostEqual(p.drafted_probability_192.sum(),192,places=8)
        self.assertAlmostEqual(p.adp.sum(),n*(n+1)/2,places=6)
        self.assertTrue((p.pick_p10<=p.pick_p90).all())

    def test_historical_top216_identity_coverage(self):
        issues=pd.read_csv(OUT/'adp_join_issues.csv')
        self.assertFalse(((issues.year>=2016)&(issues['rank']<=216)).any())

    def test_game_database_does_not_expose_real_names(self):
        d=json.loads((OUT/'player_database_with_adp.json').read_text())
        for p in d['players']:
            self.assertNotIn('name',p);self.assertNotIn('comparables',p);self.assertIn('adp',p['draft'])


@unittest.skipUnless((OUT/'weekly_library.pkl').exists(),'Run ff-data draft-weekly')
class WeeklyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.lib=pickle.loads((OUT/'weekly_library.pkl').read_bytes())
        cls.ret=json.loads((OUT/'weekly_config.json').read_text())['shape_retention']
        cls.model=WeeklyModel(cls.lib,2022,shape_retention=cls.ret)

    def test_all_positions_conserve_stats_games_and_ppr(self):
        for pos in ['QB','RB','WR','TE']:
            row=next(r for r in self.lib.records if r['position']==pos and r['year']==2024 and r['totals'][-1]>=12 and r['totals'][[0,5,8]].sum()>100)
            y,meta=self.model.generate(row['totals'],pos,9,np.random.default_rng(4),row['id'])
            np.testing.assert_array_equal(y.sum(axis=0),row['totals'])
            self.assertEqual(y.shape,(18,len(CORE)));self.assertTrue((y[8]==0).all())
            self.assertAlmostEqual(points(y).sum(),points(row['totals'][None,:])[0],places=8)
            self.assertLessEqual(meta['template_year'],2022);self.assertNotEqual(meta['template_id'],row['id'])
            self.assertTrue((y[:,1]<=y[:,0]).all());self.assertTrue((y[:,9]<=y[:,8]).all())

    def test_zero_production_can_still_mean_17_participated_games(self):
        x=np.zeros(len(CORE));x[-1]=17
        y,_=self.model.generate(x,'TE',11,np.random.default_rng(8))
        self.assertEqual(y[:,-1].sum(),17);self.assertTrue((points(y)==0).all());self.assertEqual(y[10,-1],0)

    def test_zero_games_means_all_zero_calendar(self):
        y,_=self.model.generate(np.zeros(len(CORE)),'QB',6,np.random.default_rng(2))
        self.assertFalse(y.any())

    def test_every_possible_participation_count(self):
        for g in range(1,18):
            x=np.zeros(len(CORE));x[5]=20;x[6]=-3;x[-1]=g
            y,_=self.model.generate(x,'RB',5,np.random.default_rng(g))
            self.assertEqual(y[:,-1].sum(),g);self.assertEqual(y[:,6].sum(),-3)
            self.assertFalse(y[y[:,-1]==0].any())

    def test_lateral_without_reception_and_strip_without_attempt(self):
        x=np.zeros(len(CORE));x[10]=11;x[-1]=1
        x[11]=1  # Receiving TD via lateral, no credited catch.
        y,_=self.model.generate(x,'QB',8,np.random.default_rng(9))
        self.assertEqual(y[:,9].sum(),0);self.assertEqual(y[:,10].sum(),11);self.assertEqual(y[:,11].sum(),1)
        x=np.zeros(len(CORE));x[8]=3;x[9]=2;x[10]=20;x[12]=1;x[-1]=1
        y,_=self.model.generate(x,'WR',8,np.random.default_rng(10))
        self.assertEqual(y[:,0].sum(),0);self.assertEqual(y[:,12].sum(),1)

    def test_invalid_calendar_and_box_score_rejected(self):
        x=np.zeros(len(CORE));x[-1]=18
        with self.assertRaises(ValueError):self.model.generate(x,'QB',8,np.random.default_rng(1))
        x[-1]=1;x[0]=1;x[1]=2
        with self.assertRaises(ValueError):self.model.generate(x,'QB',8,np.random.default_rng(1))

    def test_seed_reproducibility(self):
        r=next(r for r in self.lib.records if r['position']=='WR' and r['totals'][8]>100)
        a,_=self.model.generate(r['totals'],'WR',7,np.random.default_rng(3))
        b,_=self.model.generate(r['totals'],'WR',7,np.random.default_rng(3))
        np.testing.assert_array_equal(a,b)

    def test_receiver_templates_match_receiving_workload(self):
        # Tre Tucker's 2024 season formerly inherited a 20-catch reserve's
        # 11-catch outlier and scaled it into a 28-catch/388-yard game.
        r=next(r for r in self.lib.records if r['id']=='00-0038563' and r['year']==2024)
        rng=np.random.default_rng(22);volume=r['totals'][8]/r['totals'][-1]
        for _ in range(100):
            template=self.model.template(r['totals'],'WR',rng,r['id'])
            self.assertGreaterEqual(template['totals'][8]/template['totals'][-1]/volume,.5)

    def test_entire_export_sums_back_to_every_season(self):
        path=OUT/'weekly_results.csv.gz'
        if not path.exists():self.skipTest('Generate weekly exports')
        w=pd.read_csv(path);s=pd.read_csv(OUT/'league_seasons.csv');s=s[s.simulation<=3]
        a=w.groupby(['simulation','id','path'])[CORE].sum().sort_index();b=s.set_index(['simulation','id'])[CORE].reindex(a.index.droplevel('path'))
        np.testing.assert_array_equal(a.to_numpy(),b.to_numpy())
        actual_points=w.groupby(['simulation','id','path']).ppr.sum().sort_index()
        expected_points=s.set_index(['simulation','id']).ppr.reindex(actual_points.index.droplevel('path'))
        np.testing.assert_allclose(actual_points,expected_points,atol=1e-8)
        self.assertTrue(w.groupby(['simulation','id','path']).size().eq(18).all())
        self.assertTrue(w[w.status=='BYE'][CORE].eq(0).all().all())
        self.assertTrue(w[w.status=='NO_PARTICIPATION'][CORE].eq(0).all().all())
        self.assertTrue((w.completions<=w.attempts).all());self.assertTrue((w.receptions<=w.targets).all())
        self.assertTrue(w.groupby('schedule_group').bye_week.nunique().eq(1).all())

    def test_historical_distribution_acceptance(self):
        checks=pd.read_csv(OUT/'weekly_validation_checks.csv')
        self.assertEqual(len(checks),52)
        self.assertTrue(checks.passed.all(),checks[~checks.passed].to_string())
        protocol=json.loads((OUT/'weekly_validation_protocol.json').read_text())
        self.assertEqual(protocol['cutoff'],2022)
        self.assertEqual(protocol['same_player_templates'],'excluded')
        self.assertGreaterEqual(protocol['draws_per_season'],20)
        for name in ['weekly_validation_protocol.json','weekly_export_checks.json','weekly_config.json','weekly_structural_audit.json']:
            self.assertEqual(json.loads((OUT/name).read_text())['engine_fingerprint'],weekly_engine_fingerprint())

    def test_full_corpus_accounting_audit(self):
        audit=json.loads((OUT/'weekly_structural_audit.json').read_text())
        self.assertEqual(audit['seasons'],len(self.lib.records))
        self.assertEqual(audit['failed'],0,audit['failures'])


if __name__=='__main__':unittest.main()
