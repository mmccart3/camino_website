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
        total, total_w, first, first_w = rows[pid][4:8]
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


def climb_chain(graph, chain):
    """Climb and descent of a day over these paths, worked out from the graph the way the page does it:
    each path's own, plus the step from one path's last height to the next one's first."""
    rows = {r[0]: r for r in graph['paths']}
    up = down = 0.0
    for i, pid in enumerate(chain):
        up += rows[pid][9]
        down += rows[pid][10]
        if i > 0:
            step = rows[pid][11] - rows[chain[i - 1]][12]
            if step > 0:
                up += step
            else:
                down -= step
    return up, down


class ClimbTests(unittest.TestCase):
    def test_every_step_up_is_climb_and_every_other_step_is_descent(self):
        self.assertEqual(planner.climb_of([100, 120, 110, 115, 115, 100]), (25, 25))
        self.assertEqual(planner.climb_of([5]), (0, 0))
        self.assertEqual(planner.climb_of([]), (0, 0))
        self.assertEqual(planner.climb_of([10.5, 12.0]), (1.5, 0))

    def test_climb_and_descent_are_whole_figures_for_every_step_not_a_net_height(self):
        up, down = planner.climb_of([0, 10, 0, 10, 0])
        self.assertEqual((up, down), (20, 20))


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

    def test_heights_add_climb_descent_and_first_and_last_height_to_a_path(self):
        stage, paths, points, locations = guide()
        graph = planner.build_route_graph(legs_of(paths, points), {1: [100, 130, 120], 2: [120, 150.123456, 90]})
        one, two = graph['paths']
        self.assertEqual(one[9:], [30, 10, 100, 120])
        self.assertEqual(two[9:], [30.12, 60.12, 120, 90])
        self.assertEqual(one[:9], planner.build_route_graph(legs_of(paths, points))['paths'][0])   # the rest is untouched

    def test_a_path_without_heights_has_no_climb_figures(self):
        stage, paths, points, locations = guide()
        graph = planner.build_route_graph(legs_of(paths, points), {1: [100, 130, 120], 2: [150]})
        self.assertEqual(len(graph['paths'][0]), 13)
        self.assertEqual(len(graph['paths'][1]), 9)     # one height is not a line
        self.assertEqual(len(planner.build_route_graph(legs_of(paths, points), {})['paths'][0]), 9)
        self.assertEqual(len(planner.build_route_graph(legs_of(paths, points), None)['paths'][1]), 9)

    def test_a_day_over_two_paths_adds_the_step_between_them(self):
        stage, paths, points, locations = guide()
        graph = planner.build_route_graph(legs_of(paths, points), {1: [100, 130, 120], 2: [125, 150, 90]})
        self.assertEqual(climb_chain(graph, [1, 2]), (30 + 25 + 5, 10 + 60))      # 120 -> 125 is a 5 m step up
        graph = planner.build_route_graph(legs_of(paths, points), {1: [100, 130, 120], 2: [110, 150, 90]})
        self.assertEqual(climb_chain(graph, [1, 2]), (30 + 40, 10 + 60 + 10))     # 120 -> 110 is a 10 m step down

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


class StayDetailsTests(unittest.TestCase):
    """The prices, facilities and contact details the stay picker shows (planner.build_stay_details)."""

    def albergue(self, **changes):
        row = {'id': 1, 'address': ' 5  Calle Mayor ', 'beds': 32, 'low': 16, 'high': None, 'notes': None, 'kitchen': 1,
               'meal': 0, 'washer': 1, 'dryer': 0, 'rooms': 1, 'opening': 'April to October', 'checkin': '14:00 - 20:00',
               'country': '+34', 'phone': '987 123 456', 'whatsapp': '34987123456', 'email': 'casa@example.es',
               'website': 'https://casa.example.es/', 'booking': 'https://www.booking.com/hotel/es/casa.html'}
        row.update(changes)
        return row

    def test_an_albergue_keeps_what_it_has_in_short_keys(self):
        d = planner.albergue_details(self.albergue())
        self.assertEqual(d, {'p': 16, 'n': 32, 'f': 'kwr', 'ad': '5 Calle Mayor', 't': '+34987123456', 'wa': '34987123456',
                             'em': 'casa@example.es', 'web': 'https://casa.example.es/',
                             'bk': 'https://www.booking.com/hotel/es/casa.html', 'op': 'April to October', 'ci': '14:00 - 20:00'})

    def test_a_top_price_is_kept_only_when_it_is_higher(self):
        self.assertEqual(planner.albergue_details(self.albergue(low=10, high=15))['px'], 15)
        self.assertNotIn('px', planner.albergue_details(self.albergue(low=10, high=10)))
        self.assertNotIn('px', planner.albergue_details(self.albergue(low=10, high=None)))

    def test_zero_and_nonsense_prices_mean_unknown(self):
        for bad in (0, '0', None, '', 'free', -3, float('nan'), 99999):
            self.assertNotIn('p', planner.albergue_details(self.albergue(low=bad)), bad)
        self.assertEqual(planner.albergue_details(self.albergue(low='16.50'))['p'], 16.5)

    def test_a_private_place_has_a_single_and_a_double_price(self):
        row = {'id': 2, 'single': 45, 'double': 0, 'phone': '948 12 34 56', 'country': '34'}
        self.assertEqual(planner.private_details(row), {'p': 45, 't': '+34948123456'})
        self.assertEqual(planner.private_details({'id': 3, 'single': 0, 'double': 55.5})['p2'], 55.5)
        self.assertEqual(planner.private_details({'id': 4, 'single': 0, 'double': 0}), {})

    def test_placeholders_become_missing_values(self):
        row = self.albergue(website='no website available', booking='not on Booking', email='NULL', opening='  ', notes='None')
        d = planner.albergue_details(row)
        for key in ('web', 'bk', 'em', 'op', 'rn'):
            self.assertNotIn(key, d)

    def test_only_plain_web_addresses_and_email_addresses_are_kept(self):
        self.assertIsNone(planner.clean_url('javascript:alert(1)'))
        self.assertIsNone(planner.clean_url('www.example.es'))
        self.assertIsNone(planner.clean_url('https://exa mple.es'))
        self.assertEqual(planner.clean_url(' http://example.es/a?b=1 '), 'http://example.es/a?b=1')
        self.assertIsNone(planner.clean_email_address('a@b'))
        self.assertIsNone(planner.clean_email_address('one@x.es, two@x.es'))
        self.assertEqual(planner.clean_email_address(' hola@casa.es '), 'hola@casa.es')

    def test_telephone_numbers_are_made_international(self):
        self.assertEqual(planner.clean_phone('+34', '987 12 34 56'), '+34987123456')
        self.assertEqual(planner.clean_phone('34', '987123456'), '+34987123456')
        self.assertEqual(planner.clean_phone('+34', '34987123456'), '+34987123456')       # already has the country code
        self.assertEqual(planner.clean_phone('+34', '+34 987 123 456'), '+34987123456')
        self.assertEqual(planner.clean_phone('+34', '0034987123456'), '+34987123456')
        self.assertEqual(planner.clean_phone('+33', '0559370974'), '+33559370974')        # the French 0 is not dialled abroad
        self.assertEqual(planner.clean_phone('+33', '617103189'), '+33617103189')
        self.assertEqual(planner.clean_phone(None, '987123456'), '+34987123456')          # the Camino is mostly in Spain
        self.assertIsNone(planner.clean_phone(None, '12345'))
        for bad in (None, '', '  ', '9', '0', 'none', 12):
            self.assertIsNone(planner.clean_phone('+34', bad), bad)

    def test_whatsapp_numbers_are_digits_with_the_country_code(self):
        self.assertEqual(planner.clean_whatsapp('+34 987 123 456'), '34987123456')
        self.assertIsNone(planner.clean_whatsapp('123'))
        self.assertIsNone(planner.clean_whatsapp(None))

    def test_long_text_is_cut_and_whitespace_is_tidied(self):
        d = planner.albergue_details(self.albergue(address='x ' * 200, notes='a\n\tb'))
        self.assertLessEqual(len(d['ad']), planner.LIMITS['address'])
        self.assertTrue(d['ad'].endswith('\u2026'))
        self.assertEqual(d['rn'], 'a b')

    def test_the_owner_language_follows_the_apps_rules(self):
        """The cases of 'owner language uses phone prefix then calling code then border fallback' in the app's tests."""
        self.assertEqual(planner.owner_language(34, '33612345678', None, None), 'fr')     # a +33 WhatsApp number wins
        for code in (33, '33', '+33'):
            self.assertEqual(planner.owner_language(code, None, None, None), 'fr')
        self.assertEqual(planner.owner_language(None, None, 43.16, -1.23), 'fr')          # no calling code: the border decides
        self.assertEqual(planner.owner_language('', None, 43.16, -1.23), 'fr')
        self.assertIsNone(planner.owner_language(None, None, 42.9, -1.5))
        self.assertIsNone(planner.owner_language(None, None, None, None))
        self.assertIsNone(planner.owner_language(34, None, 43.16, -1.23))                 # a Spanish code is not overruled by position
        self.assertIsNone(planner.owner_language(34, '34612345678', None, None))
        self.assertIsNone(planner.owner_language(None, None, 'x', 'y'))

    def test_only_french_places_say_so(self):
        self.assertEqual(planner.albergue_details(self.albergue(country='+33', whatsapp=None, lat=43.0, lon=-1.2))['lg'], 'fr')
        self.assertNotIn('lg', planner.albergue_details(self.albergue()))
        self.assertEqual(planner.private_details({'id': 5, 'country': 33})['lg'], 'fr')

    def test_the_file_has_both_kinds_the_affiliate_once_and_no_empty_entries(self):
        data = planner.build_stay_details([self.albergue(id=9), self.albergue(id=5), {'id': 6}], [{'id': 7, 'single': 40}],
                                          {'aid': '1'})
        self.assertEqual(data['v'], planner.STAY_DETAILS_VERSION)
        self.assertEqual(data['aff'], {'aid': '1'})
        self.assertEqual(list(data['a']), ['5', '9'])        # id order; the empty record is left out
        self.assertEqual(data['p'], {'7': {'p': 40}})
        self.assertNotIn('aid=', json.dumps({k: v for k, v in data.items() if k != 'aff'}))

    def test_nothing_in_it_can_end_a_script_tag_or_hide_markup(self):
        d = planner.albergue_details(self.albergue(address='<b>Calle</b> & Co'))
        self.assertEqual(d['ad'], '<b>Calle</b> & Co')       # kept as text: the page puts it in with textContent


class RealGuideTests(unittest.TestCase):
    """Reads camino.sqlite directly (read-only). Skipped when the file is not there."""

    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parent.parent / 'camino.sqlite'
        if not path.exists():
            raise unittest.SkipTest('camino.sqlite not found')
        cls.db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
        cls.data = planner.build_planner_data(*planner.load_inputs(cls.db.cursor()),
                                              elevations=planner.load_elevations(cls.db.cursor()))

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

    def test_a_stage_climb_in_the_planner_is_the_figure_on_its_stage_page(self):
        # The stage page lays all of a stage's elevation points end to end and counts every step.
        graph = self.data['routes']
        for sid, stage in self.data['stages'].items():
            heights = []
            for pid in stage['paths']:
                heights += [r[0] for r in self.db.execute(
                    'SELECT elevationMetres FROM elevation_points WHERE pathID = ? ORDER BY sequence', (pid,))]
            expected_up, expected_down = planner.climb_of(heights)
            up, down = climb_chain(graph, stage['paths'])
            self.assertLess(abs(up - expected_up), 1.0, f'stage {sid} climb')
            self.assertLess(abs(down - expected_down), 1.0, f'stage {sid} descent')

    def test_every_path_has_heights_and_they_are_sensible(self):
        for row in self.data['routes']['paths']:
            self.assertEqual(len(row), 13, f'path {row[0]} has no heights')
            up, down, first, last = row[9:]
            self.assertGreaterEqual(up, 0)
            self.assertGreaterEqual(down, 0)
            self.assertTrue(-100 < first < 3000 and -100 < last < 3000, row)
            self.assertLess(abs((first + up - down) - last), 0.1, f'path {row[0]}: climb and descent do not join its ends')

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

    def test_the_stay_details_cover_the_places_to_stay_in_the_planner(self):
        details = planner.build_stay_details(*planner.load_stay_rows(self.db.cursor()), {'aid': '1'})
        listed = {(('a' if kind == 0 else 'p'), str(ident)) for kind, ident, _, _ in self.data['stays']}
        have = {(k, i) for k in ('a', 'p') for i in details[k]}
        self.assertGreater(len(listed & have), 0.95 * len(listed))
        self.assertLess(len(have - listed), 0.1 * len(listed))      # few details for places the planner does not list

    def test_every_detail_is_clean(self):
        details = planner.build_stay_details(*planner.load_stay_rows(self.db.cursor()))
        for kind in ('a', 'p'):
            for ident, d in details[kind].items():
                self.assertTrue(d, ident)
                for key in ('p', 'px', 'p2'):
                    if key in d:
                        self.assertTrue(0 < d[key] <= planner.MAX_PRICE, (kind, ident, key))
                if 't' in d:
                    self.assertRegex(d['t'], r'^\+\d{8,15}$')
                if 'wa' in d:
                    self.assertRegex(d['wa'], r'^\d{8,15}$')
                for key in ('web', 'bk'):
                    if key in d:
                        self.assertRegex(d[key], r'^https?://\S+$')
                if 'em' in d:
                    self.assertIn('@', d['em'])
                self.assertTrue(set(d.get('f', '')) <= set('kmwdr'))
                self.assertFalse(set(d) - {'p', 'px', 'p2', 'n', 'f', 'ad', 'rn', 'op', 'ci', 't', 'wa', 'em', 'web', 'bk', 'lg'}, (kind, ident))

    def test_the_french_places_are_those_the_app_would_write_to_in_french(self):
        details = planner.build_stay_details(*planner.load_stay_rows(self.db.cursor()))
        french = {(k, i) for k in ('a', 'p') for i, d in details[k].items() if d.get('lg') == 'fr'}
        in_france = {('a', str(r[0])) for r in self.db.execute('SELECT ID FROM albergues WHERE tel1CountryCode = 33')}
        in_france |= {('p', str(r[0])) for r in self.db.execute('SELECT ID FROM privateAccommDetail WHERE tel1CountryCode = 33')}
        self.assertTrue(in_france <= french)
        self.assertLess(len(french - in_france), 5)      # a few more where only the position or WhatsApp number says France

    def test_the_stay_details_stay_a_reasonable_size(self):
        body = json.dumps(planner.build_stay_details(*planner.load_stay_rows(self.db.cursor())), ensure_ascii=False, separators=(',', ':'))
        self.assertLess(len(body), 350_000, f'{len(body)} bytes: the stay details have grown a lot')


if __name__ == '__main__':
    unittest.main()
