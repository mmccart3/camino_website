# camino/test_planner.py
"""Tests for the planner's arithmetic and data. Plain unittest: no Django needed.

Run with:  python manage.py test camino      (or)      python -m unittest camino.test_planner
"""
import json
import math
import sqlite3
import unittest
from pathlib import Path

from . import planner

LAT0 = 42.0
STEP = 0.0005  # about 55 m of latitude


def point(pid, prev, n, d3, w, ele=100.0, lat=None):
    return {'id': pid, 'prev': prev, 'lat': LAT0 + n * STEP if lat is None else lat, 'lon': -1.0,
            'ele': ele, 'd3': d3, 'w': w}


def guide(second_prev=3, second_lat_shift=0.0, ele=100.0):
    """Stage 10 from location 1 to 3 over two paths. The second path continues the first
    track when second_prev is 3, and starts a new track when it is None."""
    locations = {1: ('Start', LAT0, -1.0), 2: ('Middle', LAT0 + 2 * STEP, -1.0), 3: ('End', LAT0 + 4 * STEP + second_lat_shift, -1.0)}
    stage = {'id': 10, 'name': 'Start to End', 'ref': '10', 'start': 1, 'finish': 3}
    paths = [{'id': 1, 'stage': 10, 'origin': 1, 'dest': 2}, {'id': 2, 'stage': 10, 'origin': 2, 'dest': 3}]
    points = {
        1: [point(1, None, 0, 0, 0), point(2, 1, 1, 100, 10), point(3, 2, 2, 110, 11, ele=ele)],
        2: [point(4, second_prev, 3, 90, 9, lat=LAT0 + (3 * STEP) + second_lat_shift),
            point(5, 4, 4, 80, 8, lat=LAT0 + (4 * STEP) + second_lat_shift)],
    }
    return stage, paths, points, locations


class StageTotalsTests(unittest.TestCase):
    def test_continuing_paths_add_every_point_after_the_first(self):
        stage, paths, points, locations = guide(second_prev=3)
        result = planner.stage_totals(stage, paths, points, locations)
        self.assertEqual(result['paths'], [1, 2])
        self.assertEqual(result['metres'], 100 + 110 + 90 + 80)
        self.assertEqual(result['weighted'], 10 + 11 + 9 + 8)

    def test_a_join_that_does_not_continue_the_track_skips_the_first_point(self):
        stage, paths, points, locations = guide(second_prev=None)
        result = planner.stage_totals(stage, paths, points, locations)
        self.assertEqual(result['metres'], 100 + 110 + 80)
        self.assertEqual(result['weighted'], 10 + 11 + 8)

    def test_a_gap_between_paths_is_refused(self):
        stage, paths, points, locations = guide(second_prev=None, second_lat_shift=0.003)
        with self.assertRaises(planner.RouteData):
            planner.stage_totals(stage, paths, points, locations)

    def test_missing_elevation_is_refused(self):
        stage, paths, points, locations = guide()
        points[1][2]['ele'] = None
        with self.assertRaises(planner.RouteData):
            planner.stage_totals(stage, paths, points, locations)

    def test_a_path_without_track_points_is_refused(self):
        stage, paths, points, locations = guide()
        points[2] = []
        with self.assertRaises(planner.RouteData):
            planner.stage_totals(stage, paths, points, locations)

    def test_alternative_paths_inside_a_stage_are_not_guessed(self):
        stage, paths, points, locations = guide()
        paths.append({'id': 3, 'stage': 10, 'origin': 1, 'dest': 3})
        points[3] = [point(7, None, 0, 0, 0), point(8, 7, 4, 200, 20)]
        with self.assertRaises(planner.RouteData):
            planner.stage_totals(stage, paths, points, locations)

    def test_broken_track_chain_is_refused(self):
        stage, paths, points, locations = guide()
        points[1][2]['prev'] = 99  # two heads
        with self.assertRaises(planner.RouteData):
            planner.stage_totals(stage, paths, points, locations)


class PlannerDataTests(unittest.TestCase):
    def build(self, **kw):
        stage, paths, points, locations = guide()
        bad = {'id': 11, 'name': 'Broken', 'ref': '11', 'start': 3, 'finish': 1}
        stays = [(0, 7, 3, 'Albergue End'), (1, 8, 3, 'Hostal End'), (0, 9, 2, 'Albergue Middle')]
        return planner.build_planner_data([stage, bad], paths, points, locations, stays, **kw)

    def test_stage_entry_and_skipped_stage(self):
        data = self.build()
        self.assertEqual(list(data['stages']), ['10'])
        s = data['stages']['10']
        self.assertEqual((s['start'], s['finish'], s['m'], s['w'], s['paths']), (1, 3, 380.0, 38, [1, 2]))
        self.assertEqual([x['stage'] for x in data['skipped']], [11])

    def test_only_stays_at_stage_finishes_are_listed_in_a_stable_order(self):
        data = self.build()
        self.assertEqual(data['stays'], [[0, 7, 3, 'Albergue End'], [1, 8, 3, 'Hostal End']])
        self.assertEqual(data['places'], {'1': 'Start', '3': 'End'})

    def test_sections_default_and_custom(self):
        self.assertEqual(self.build()['sections'], [{'n': 1, 'stages': [10]}])
        custom = [{'n': 4, 'stages': [10, 99], 'variants': {10: 'valley'}}]
        data = self.build(sections=custom)
        self.assertEqual(data['sections'], [{'n': 4, 'stages': [10]}])
        self.assertEqual((data['stages']['10']['section'], data['stages']['10']['kind']), (4, 'valley'))

    def test_json_round_trip_and_constants(self):
        data = self.build()
        again = json.loads(json.dumps(data, separators=(',', ':')))
        self.assertEqual(again['flat'], math.exp(-2.25 * 0.07))
        self.assertEqual(again['pace']['default'], 4.2)
        self.assertRegex(again['guide'], r'^[0-9a-f]{16}$')

    def test_fingerprint_changes_when_the_route_structure_changes(self):
        stage, paths, points, locations = guide()
        a = planner.guide_fingerprint(paths, locations)
        paths[1] = dict(paths[1], dest=2)
        self.assertNotEqual(a, planner.guide_fingerprint(paths, locations))


class RealGuideTests(unittest.TestCase):
    """Reads camino.sqlite directly (read-only). Skipped when the file is not there."""

    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parent.parent / 'camino.sqlite'
        if not path.exists():
            raise unittest.SkipTest('camino.sqlite not found')
        cls.db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
        cls.data = planner.build_planner_data(*planner.load_inputs(cls.db.cursor()))

    def test_every_stage_can_be_planned(self):
        total = self.db.execute('SELECT count(*) FROM stages').fetchone()[0]
        self.assertEqual(self.data['skipped'], [])
        self.assertEqual(len(self.data['stages']), total)

    def test_distances_and_times_match_the_guide(self):
        for sid, stored_m, stored_min in self.db.execute('SELECT ID, stageDistanceInMetres, stageTimeInMinutes FROM stages'):
            s = self.data['stages'][str(sid)]
            self.assertLess(abs(s['m'] - stored_m), 1.0, sid)
            minutes = s['w'] * planner.FLAT_SLOPE_EFFECT / planner.DEFAULT_PACE / 60
            self.assertLess(abs(minutes - stored_min), 1.5, sid)

    def test_stays_belong_to_stage_finishes(self):
        finishes = {s['finish'] for s in self.data['stages'].values()}
        self.assertTrue(self.data['stays'])
        self.assertTrue(all(s[2] in finishes for s in self.data['stays']))
        self.assertTrue(all(s[3] for s in self.data['stays']))


if __name__ == '__main__':
    unittest.main()
