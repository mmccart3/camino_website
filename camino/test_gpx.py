# camino/test_gpx.py
"""Tests for the GPX download of a stage's route. Plain unittest: no Django needed.

Run with:  python manage.py test camino      (or)      python -m unittest camino.test_gpx
"""
import math
import sqlite3
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from . import gpx

NS = '{http://www.topografix.com/GPX/1/1}'
DATABASE = Path(__file__).resolve().parent.parent / 'camino.sqlite'


def parse(text):
    return ET.fromstring(text.encode('utf-8'))


def small_guide():
    """Two stages. Stage 1 has two legs, inserted out of order (path 2 before path 1) and joined at a shared point."""
    con = sqlite3.connect(':memory:')
    con.executescript('''
        CREATE TABLE paths (pathID INTEGER PRIMARY KEY, stageID INTEGER, originLoc INTEGER, destinationLoc INTEGER);
        CREATE TABLE elevation_points (pathID INTEGER, sequence INTEGER, latitude REAL, longitude REAL, elevationMetres REAL);
    ''')
    con.executemany('INSERT INTO paths VALUES (?,?,?,?)', [(2, 1, 11, 12), (1, 1, 10, 11), (3, 2, 20, 21)])
    con.executemany('INSERT INTO elevation_points VALUES (?,?,?,?,?)', [
        (2, 2, 42.0020, -1.0, 120.0), (2, 1, 42.0010, -1.0, 110.0),    # starts where path 1 ends: a repeated point
        (1, 1, 42.0000, -1.0, 100.0), (1, 2, 42.0010, -1.0, 110.0),
        (3, 1, 43.0, -2.0, 500.0), (3, 2, 43.001, -2.0, 501.0),
    ])
    return con


class CleanPointsTests(unittest.TestCase):
    def test_unusable_positions_are_left_out(self):
        rows = [(42.0, -1.0, 10), (None, -1.0, 10), (42.1, None, 10), (91.0, -1.0, 10), (42.2, 181.0, 10),
                (float('nan'), -1.0, 10), ('x', -1.0, 10), (42.3, -1.1, 12)]
        self.assertEqual(gpx.clean_points(rows), [(42.0, -1.0, 10.0), (42.3, -1.1, 12.0)])

    def test_a_point_in_the_same_place_as_the_one_before_is_dropped_but_a_return_to_it_later_is_kept(self):
        rows = [(42.0, -1.0, 1), (42.0, -1.0, 1), (42.0000001, -1.0, 1), (42.001, -1.0, 2), (42.0, -1.0, 1)]
        points = gpx.clean_points(rows)
        self.assertEqual([p[:2] for p in points], [(42.0, -1.0), (42.001, -1.0), (42.0, -1.0)])

    def test_a_missing_height_stays_missing(self):
        self.assertEqual(gpx.clean_points([(42.0, -1.0, None), (42.1, -1.0)]), [(42.0, -1.0, None), (42.1, -1.0, None)])


class BuildGpxTests(unittest.TestCase):
    POINTS = [(42.0, -1.0, 100.04), (42.001, -1.0005, 101.26), (42.002, -1.001, None)]

    def build(self, **kwargs):
        values = dict(name='Stage 1a: Saint-Jean to Roncesvalles', points=self.POINTS,
                      places=[('Saint-Jean', 42.0, -1.0), ('Roncesvalles', 42.002, -1.001)],
                      page_url='https://saintjeantosantiago.com/stage/1/')
        values.update(kwargs)
        return gpx.build_gpx(**values)

    def test_it_is_a_gpx_1_1_file_in_the_order_the_schema_asks_for(self):
        text = self.build()
        self.assertTrue(text.startswith('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Saint Jean to Santiago"'))
        root = parse(text)
        self.assertEqual(root.tag, NS + 'gpx')
        self.assertEqual(root.get('version'), '1.1')
        self.assertEqual([child.tag.replace(NS, '') for child in root], ['metadata', 'wpt', 'wpt', 'trk'])
        self.assertEqual([child.tag.replace(NS, '') for child in root.find(NS + 'metadata')], ['name', 'link', 'bounds'])

    def test_the_track_has_every_point_with_its_height_to_a_tenth_of_a_metre(self):
        track = parse(self.build()).findall(f'{NS}trk/{NS}trkseg/{NS}trkpt')
        self.assertEqual(len(track), 3)
        self.assertEqual((track[0].get('lat'), track[0].get('lon')), ('42.000000', '-1.000000'))
        self.assertEqual(track[0].find(NS + 'ele').text, '100.0')
        self.assertEqual(track[1].find(NS + 'ele').text, '101.3')
        self.assertIsNone(track[2].find(NS + 'ele'))   # no height known: none written, not a made-up zero

    def test_bounds_surround_the_whole_track(self):
        bounds = parse(self.build()).find(f'{NS}metadata/{NS}bounds').attrib
        self.assertEqual(bounds, {'minlat': '42.000000', 'minlon': '-1.001000', 'maxlat': '42.002000', 'maxlon': '-1.000000'})

    def test_places_become_waypoints_and_ones_without_a_position_are_skipped(self):
        text = self.build(places=[('Good', 42.0, -1.0), ('Nowhere', None, None), ('Atlantic', 0, 0), ('Far', 95, 0), ('Fine', '42.5', '-1.5')])
        names = [w.find(NS + 'name').text for w in parse(text).findall(NS + 'wpt')]
        self.assertEqual(names, ['Good', 'Fine'])

    def test_names_are_escaped_and_stray_control_characters_dropped(self):
        text = self.build(name='Burgos & <León>', places=[('Rabé "de" las\x00 Calzadas', 42.0, -1.0)], page_url='https://x.test/?a=1&b="2"')
        root = parse(text)   # a broken name would make this fail to parse
        self.assertEqual(root.find(f'{NS}metadata/{NS}name').text, 'Burgos & <León>')
        self.assertEqual(root.find(f'{NS}wpt/{NS}name').text, 'Rabé "de" las Calzadas')
        self.assertEqual(root.find(f'{NS}metadata/{NS}link').get('href'), 'https://x.test/?a=1&b="2"')

    def test_the_link_is_left_out_without_a_page_address(self):
        root = parse(self.build(page_url=None))
        self.assertIsNone(root.find(f'{NS}metadata/{NS}link'))

    def test_a_route_needs_two_points(self):
        with self.assertRaises(ValueError):
            gpx.build_gpx('x', [(42.0, -1.0, 1.0)])


class FilenameTests(unittest.TestCase):
    def test_the_file_name_is_plain_ascii_whatever_the_stage_reference(self):
        self.assertEqual(gpx.filename('1a', 1), 'saint-jean-to-santiago-stage-1a.gpx')
        self.assertEqual(gpx.filename('16B', 17), 'saint-jean-to-santiago-stage-16b.gpx')
        self.assertEqual(gpx.filename(' ../é "x" ', 5), 'saint-jean-to-santiago-stage-x.gpx')
        self.assertEqual(gpx.filename(None, 7), 'saint-jean-to-santiago-stage-7.gpx')
        self.assertEqual(gpx.filename('///', 8), 'saint-jean-to-santiago-stage-8.gpx')


class LoadRouteTests(unittest.TestCase):
    def test_the_legs_are_in_walking_order_whatever_order_they_were_stored_in(self):
        route = gpx.load_route(small_guide().cursor(), 1)
        self.assertEqual([p[:2] for p in route['points']], [(42.0, -1.0), (42.001, -1.0), (42.002, -1.0)])
        self.assertEqual([p[2] for p in route['points']], [100.0, 110.0, 120.0])   # the shared point is listed once

    def test_the_places_are_the_start_of_the_first_leg_and_the_end_of_each_leg(self):
        self.assertEqual(gpx.load_route(small_guide().cursor(), 1)['place_ids'], [10, 11, 12])
        self.assertEqual(gpx.load_route(small_guide().cursor(), 2)['place_ids'], [20, 21])

    def test_a_stage_with_no_route_gives_nothing(self):
        route = gpx.load_route(small_guide().cursor(), 99)
        self.assertEqual(route, {'points': [], 'place_ids': []})

    def test_the_stage_id_cannot_carry_sql(self):
        with self.assertRaises(ValueError):
            gpx.load_route(small_guide().cursor(), '1; DROP TABLE paths')


@unittest.skipUnless(DATABASE.exists(), 'camino.sqlite not found')
class EveryStageTests(unittest.TestCase):
    """Reads the real guide (opened read-only) and makes the file for every stage."""

    @classmethod
    def setUpClass(cls):
        cls.con = sqlite3.connect(f'file:{DATABASE}?mode=ro', uri=True)
        cls.stages = cls.con.execute('SELECT ID, stageDisplayReference, stageName FROM stages ORDER BY ID').fetchall()
        cls.places = {row[0]: row[1:] for row in cls.con.execute('SELECT ID, locationName, latitude, longitude FROM locations')}

    @classmethod
    def tearDownClass(cls):
        cls.con.close()

    @staticmethod
    def metres(a, b):
        return math.hypot((a[0] - b[0]) * 110540, (a[1] - b[1]) * 111320 * math.cos(math.radians(a[0])))

    def test_every_stage_makes_a_valid_file_with_its_whole_route_and_its_places(self):
        self.assertGreaterEqual(len(self.stages), 44)
        for stage_id, ref, name in self.stages:
            route = gpx.load_route(self.con.cursor(), stage_id)
            stored = self.con.execute(
                'SELECT COUNT(*) FROM elevation_points e JOIN paths p ON p.pathID = e.pathID WHERE p.stageID = ?', (stage_id,)
            ).fetchone()[0]
            self.assertGreater(len(route['points']), 1000, f'stage {ref}')
            self.assertLessEqual(len(route['points']), stored, f'stage {ref}')
            self.assertGreater(len(route['points']), 0.99 * stored, f'stage {ref}')   # only repeats are dropped
            self.assertGreaterEqual(len(route['place_ids']), 2, f'stage {ref}')
            places = [(self.places[i][0], self.places[i][1], self.places[i][2]) for i in route['place_ids']]
            text = gpx.build_gpx(f'Stage {ref}: {name.strip()}', route['points'], places)
            self.assertLess(len(text.encode('utf-8')), 400_000, f'stage {ref}')
            root = parse(text)
            self.assertEqual(len(root.findall(f'{NS}trk/{NS}trkseg/{NS}trkpt')), len(route['points']), f'stage {ref}')
            self.assertEqual(len(root.findall(NS + 'wpt')), len(route['place_ids']), f'stage {ref}')
            self.assertEqual(len(root.findall(f'{NS}trk/{NS}trkseg/{NS}trkpt/{NS}ele')), len(route['points']), f'stage {ref}')

    def test_each_route_starts_and_ends_at_its_first_and_last_place(self):
        for stage_id, ref, _name in self.stages:
            route = gpx.load_route(self.con.cursor(), stage_id)
            first, last = self.places[route['place_ids'][0]], self.places[route['place_ids'][-1]]
            self.assertLess(self.metres(first[1:], route['points'][0][:2]), 300, f'start of stage {ref}')
            self.assertLess(self.metres(last[1:], route['points'][-1][:2]), 300, f'end of stage {ref}')

    def test_the_route_has_no_jumps(self):
        """Consecutive points are walking distance apart: no leg is out of order or joined to the wrong one."""
        for stage_id, ref, _name in self.stages:
            points = gpx.load_route(self.con.cursor(), stage_id)['points']
            worst = max(self.metres(a[:2], b[:2]) for a, b in zip(points, points[1:]))
            self.assertLess(worst, 250, f'stage {ref}')

    def test_every_place_has_a_position(self):
        for stage_id, ref, _name in self.stages:
            for place_id in gpx.load_route(self.con.cursor(), stage_id)['place_ids']:
                self.assertIn(place_id, self.places, f'stage {ref}')
                self.assertIsNotNone(self.places[place_id][1], f'stage {ref}, place {place_id}')


if __name__ == '__main__':
    unittest.main()
