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


def legs_of(paths, points):
    """The (path, ordered points) pairs that build_route_graph takes, in the order given."""
    return [(p, planner.order_points(points[p['id']])) for p in paths]


def chain_totals(graph, chain):
    """Distance and weighted distance of a day over these paths, worked out from the graph the
    way the page does it (see build_route_graph)."""
    rows = {r[0]: r for r in graph['paths']}
    metres = weighted = 0.0
    for i, pid in enumerate(chain):
        _, _, _, _, total, total_w, first, first_w, _ = rows[pid]
        continues = i > 0 and [pid, 1] in graph['next'].get(str(chain[i - 1]), [])
        metres += total if continues else total - first
        weighted += total_w if continues else total_w - first_w
    return metres, weighted


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

    def test_the_ordered_points_are_handed_on_for_the_route_graph(self):
        stage, paths, points, locations = guide()
        result = planner.stage_totals(stage, paths, points, locations)
        self.assertEqual([p['id'] for p, _ in result['ordered']], [1, 2])
        self.assertEqual([[r['id'] for r in rows] for _, rows in result['ordered']], [[1, 2, 3], [4, 5]])


class RouteGraphTests(unittest.TestCase):
    def two_stages(self, shift=0.0, extra_stage_prev=None):
        """Stage 10 (paths 1 and 2) and the start of stage 20 (path 3, from location 3 to 4)."""
        stage, paths, points, locations = guide()
        paths.append({'id': 3, 'stage': 20, 'origin': 3, 'dest': 4})
        points[3] = [point(10, extra_stage_prev, 4, 40, 4, lat=LAT0 + 4 * STEP + shift),
                     point(11, 10, 5, 60, 6, lat=LAT0 + 5 * STEP + shift)]
        return paths, points

    def test_a_path_is_described_by_its_totals_and_its_first_point(self):
        stage, paths, points, locations = guide()
        graph = planner.build_route_graph(legs_of(paths, points))
        one, two = graph['paths']
        self.assertEqual(one[:8], [1, 1, 2, 10, 210, 21, 0, 0])
        self.assertEqual(two[:8], [2, 2, 3, 10, 170, 17, 90, 9])
        self.assertRegex(one[8], r'^[0-9a-f]{8}$')
        self.assertNotEqual(one[8], two[8])

    def test_paths_of_one_track_join_and_continue(self):
        stage, paths, points, locations = guide(second_prev=3)
        graph = planner.build_route_graph(legs_of(paths, points))
        self.assertEqual(graph['next'], {'1': [[2, 1]]})
        self.assertEqual(chain_totals(graph, [1, 2]), (380, 38))
        self.assertEqual(chain_totals(graph, [2]), (80, 8))   # alone, its first point adds nothing

    def test_a_path_of_the_same_stage_on_another_track_does_not_join(self):
        stage, paths, points, locations = guide(second_prev=None)
        graph = planner.build_route_graph(legs_of(paths, points))
        self.assertEqual(graph['next'], {})

    def test_the_next_stage_joins_but_does_not_continue_the_track(self):
        paths, points = self.two_stages()
        graph = planner.build_route_graph(legs_of(paths, points))
        self.assertEqual(graph['next'], {'1': [[2, 1]], '2': [[3, 0]]})
        self.assertEqual(chain_totals(graph, [2, 3]), (80 + 60, 8 + 6))  # the first point of path 3 adds nothing

    def test_a_gap_of_more_than_150_m_does_not_join(self):
        paths, points = self.two_stages(shift=0.003)  # about 330 m
        graph = planner.build_route_graph(legs_of(paths, points))
        self.assertEqual(graph['next'], {'1': [[2, 1]]})

    def test_two_paths_that_follow_the_same_line_have_the_same_shape(self):
        stage, paths, points, locations = guide()
        a = planner.path_shape(planner.order_points(points[1]))
        copy = [dict(p, id=p['id'] + 100, prev=(p['prev'] + 100 if p['prev'] else None)) for p in points[1]]
        self.assertEqual(a, planner.path_shape(planner.order_points(copy)))
        self.assertNotEqual(a, planner.path_shape(planner.order_points(points[2])))

    def test_a_repeated_point_does_not_change_the_shape(self):
        stage, paths, points, locations = guide()
        rows = planner.order_points(points[1])
        doubled = [rows[0], dict(rows[0], id=99)] + rows[1:]
        self.assertEqual(planner.path_shape(rows), planner.path_shape(doubled))


class PlannerDataTests(unittest.TestCase):
    def build(self, **kw):
        stage, paths, points, locations = guide()
        bad = {'id': 11, 'name': 'Broken', 'ref': '11', 'start': 3, 'finish': 1}
        stays = [(0, 7, 3, 'Albergue End'), (1, 8, 3, 'Hostal End'), (0, 9, 2, 'Albergue Middle'), (0, 10, 99, 'Nowhere')]
        locations[99] = ('Off the route', LAT0 + 1, -1.0)
        return planner.build_planner_data([stage, bad], paths, points, locations, stays, **kw)

    def test_stage_entry_and_skipped_stage(self):
        data = self.build()
        self.assertEqual(list(data['stages']), ['10'])
        s = data['stages']['10']
        self.assertEqual((s['start'], s['finish'], s['m'], s['w'], s['paths']), (1, 3, 380.0, 38, [1, 2]))
        self.assertEqual([x['stage'] for x in data['skipped']], [11])

    def test_places_and_stays_cover_every_place_on_the_routes_in_a_stable_order(self):
        data = self.build()
        self.assertEqual(data['places'], {'1': 'Start', '2': 'Middle', '3': 'End'})
        self.assertEqual(data['stays'], [[0, 9, 2, 'Albergue Middle'], [0, 7, 3, 'Albergue End'], [1, 8, 3, 'Hostal End']])

    def test_the_route_graph_is_included(self):
        data = self.build()
        self.assertEqual([r[0] for r in data['routes']['paths']], [1, 2])
        self.assertEqual(data['routes']['next'], {'1': [[2, 1]]})

    def test_a_skipped_stage_leaves_no_paths_in_the_graph(self):
        stage, paths, points, locations = guide(second_lat_shift=0.003)
        points[2][0]['prev'] = None   # a real gap, so the stage is refused
        data = planner.build_planner_data([stage], paths, points, locations, [])
        self.assertEqual(data['routes'], {'paths': [], 'next': {}})
        self.assertEqual(len(data['skipped']), 1)

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

    def test_walking_a_whole_stage_through_the_graph_gives_the_stage_figures(self):
        graph = self.data['routes']
        by_id = {row[0]: row for row in graph['paths']}
        for sid, stage in self.data['stages'].items():
            for a, b in zip(stage['paths'], stage['paths'][1:]):
                self.assertIn([b, 1], graph['next'].get(str(a), []), f'stage {sid}: path {a} does not lead on to {b}')
            metres, weighted = chain_totals(graph, stage['paths'])
            self.assertLess(abs(metres - stage['m']), 0.01, sid)
            self.assertLess(abs(weighted - stage['w']), 0.01, sid)
            self.assertEqual(by_id[stage['paths'][0]][1], stage['start'], sid)
            self.assertEqual(by_id[stage['paths'][-1]][2], stage['finish'], sid)

    def test_the_graph_covers_every_path_and_only_known_ones(self):
        in_db = {r[0] for r in self.db.execute('SELECT pathID FROM paths')}
        in_graph = {row[0] for row in self.data['routes']['paths']}
        self.assertEqual(in_graph, in_db)
        for a, joins in self.data['routes']['next'].items():
            self.assertIn(int(a), in_graph)
            self.assertTrue(all(b in in_graph and flag in (0, 1) for b, flag in joins))

    def test_every_place_on_a_route_has_a_name_and_stays_belong_to_those_places(self):
        places = self.data['places']
        for row in self.data['routes']['paths']:
            self.assertIn(str(row[1]), places)
            self.assertIn(str(row[2]), places)
        self.assertTrue(all(places.values()))
        self.assertTrue(self.data['stays'])
        self.assertTrue(all(str(s[2]) in places for s in self.data['stays']))
        self.assertTrue(all(s[3] for s in self.data['stays']))

    def test_stages_start_and_finish_at_places_with_names(self):
        for stage in self.data['stages'].values():
            self.assertIn(str(stage['start']), self.data['places'])
            self.assertIn(str(stage['finish']), self.data['places'])

    def test_the_page_data_stays_a_reasonable_size(self):
        size = len(json.dumps(self.data, separators=(',', ':')))
        self.assertLess(size, 150_000, f'{size} bytes: the page now carries a lot more than before')


if __name__ == '__main__':
    unittest.main()
