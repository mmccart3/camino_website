# camino/test_stay_photos.py
"""Tests for the photos of a place to stay: which column values become pictures, the tool that prepares a picture,
and the town page.

Run with:  python manage.py test camino
"""
import importlib.util
import re
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django.conf import settings
from django.test import Client, SimpleTestCase

from . import stay_photos

ROOT = Path(__file__).resolve().parent.parent

try:
    from PIL import Image
except ImportError:   # the website does not need Pillow; only the tool does
    Image = None


def load_tool():
    spec = importlib.util.spec_from_file_location('add_stay_photo', ROOT / 'tool' / 'add_stay_photo.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PhotoListTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        for name in ('a1-1.webp', 'a1-1-s.webp', 'a1-2.webp', 'old.JPG', 'a1-3.webp', 'a1-4.webp'):
            (Path(self.folder.name) / name).write_bytes(b'x')

    def photos(self, *values):
        return stay_photos.photos(values, '/static/', self.folder.name)

    def test_most_places_have_none(self):
        self.assertEqual(self.photos(None, '', '   ', None), [])

    def test_a_file_name_uses_its_small_copy_on_the_card_when_there_is_one(self):
        self.assertEqual(self.photos('a1-1.webp', ' a1-2.webp '), [
            {'small': '/static/camino/img/stays/a1-1-s.webp', 'full': '/static/camino/img/stays/a1-1.webp'},
            {'small': '/static/camino/img/stays/a1-2.webp', 'full': '/static/camino/img/stays/a1-2.webp'},
        ])
        self.assertEqual(self.photos('old.JPG')[0]['full'], '/static/camino/img/stays/old.JPG')

    def test_a_full_https_address_is_used_as_it_is(self):
        self.assertEqual(self.photos('https://img.example/a.jpg'),
                         [{'small': 'https://img.example/a.jpg', 'full': 'https://img.example/a.jpg'}])

    def test_anything_else_shows_no_picture(self):
        for value in ('missing.webp', 'http://img.example/a.jpg', '../a1-1.webp', 'sub/a1-1.webp', '/etc/passwd',
                      'a1-1.webp"><script>', 'javascript:alert(1)', 'a1-1.gif', 'a1-1', '.webp', 'https://x.test/a b.jpg',
                      'C:\\photos\\a1-1.webp'):
            self.assertEqual(self.photos(value), [], value)

    def test_at_most_three_and_gaps_are_closed(self):
        found = self.photos('', 'a1-2.webp', 'a1-3.webp', 'a1-4.webp')
        self.assertEqual([p['full'].rsplit('/', 1)[1] for p in found], ['a1-2.webp', 'a1-3.webp', 'a1-4.webp'])
        self.assertEqual(len(self.photos('a1-1.webp', 'a1-2.webp', 'a1-3.webp', 'a1-4.webp')), 3)

    def test_a_folder_that_does_not_exist_yet_is_no_error(self):
        self.assertEqual(stay_photos.photos(['a1-1.webp'], '/static/', Path(self.folder.name) / 'nowhere'), [])


@unittest.skipUnless(Image, 'Pillow is not installed')
class PhotoToolTests(unittest.TestCase):
    def setUp(self):
        self.tool = load_tool()
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.dir = Path(self.folder.name)

    def camera_photo(self, size=(3000, 2000), orientation=6):
        """A JPEG as a phone writes it: stored on its side, with where it was taken."""
        picture = Image.new('RGB', size, (200, 120, 40))
        exif = Image.Exif()
        exif[0x0112] = orientation                 # 6: turn a quarter turn to see it upright
        exif[0x010F] = 'PhoneMaker'
        exif[0x8825] = {1: 'N', 2: (42.0, 30.0, 0.0), 3: 'W', 4: (1.0, 20.0, 0.0)}   # GPS
        path = self.dir / 'camera.jpg'
        picture.save(path, 'JPEG', exif=exif)
        return path

    def test_it_makes_an_upright_large_copy_and_a_card_sized_small_one_with_nothing_from_the_camera(self):
        large, small = self.tool.make_copies(self.camera_photo(), 4412, 2, self.dir / 'stays')
        self.assertEqual((large.name, small.name), ('a4412-2.webp', 'a4412-2-s.webp'))
        with Image.open(large) as picture:
            self.assertEqual(picture.format, 'WEBP')
            self.assertEqual(picture.size, (1400, 2100))      # 2000 x 3000 once upright, then narrowed to 1400
            self.assertEqual(len(picture.getexif()), 0)
        with Image.open(small) as picture:
            self.assertEqual(picture.size, (480, 320))
            self.assertEqual(len(picture.getexif()), 0)
        for path in (large, small):
            data = path.read_bytes()
            self.assertNotIn(b'PhoneMaker', data)
            self.assertNotIn(b'EXIF', data)
        self.assertLess(small.stat().st_size, 60_000)

    def test_a_small_picture_is_not_enlarged_and_a_tiny_one_is_refused(self):
        source = self.dir / 'small.png'
        Image.new('RGB', (900, 600), (10, 90, 160)).save(source)
        large, _small = self.tool.make_copies(source, 7, 1, self.dir / 'stays')
        with Image.open(large) as picture:
            self.assertEqual(picture.size, (900, 600))
        tiny = self.dir / 'tiny.png'
        Image.new('RGB', (150, 150)).save(tiny)
        with self.assertRaises(SystemExit):
            self.tool.make_copies(tiny, 7, 2, self.dir / 'stays')

    def test_the_site_shows_what_the_tool_made(self):
        self.tool.make_copies(self.camera_photo(), 4412, 1, self.dir / 'stays')
        self.assertEqual(stay_photos.photos(['a4412-1.webp'], '/static/', self.dir / 'stays'), [
            {'small': '/static/camino/img/stays/a4412-1-s.webp', 'full': '/static/camino/img/stays/a4412-1.webp'}])


class PhotoToolDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.tool = load_tool()
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.database = str(Path(self.folder.name) / 'guide.sqlite')
        con = sqlite3.connect(self.database)
        con.execute('CREATE TABLE albergues (ID INTEGER PRIMARY KEY, albergueName TEXT, alberguepic1URL TEXT, '
                    'alberguepic2URL TEXT, alberguepic3URL TEXT)')
        con.execute("INSERT INTO albergues (ID, albergueName) VALUES (4412, 'Refuge'), (5, 'Other')")
        con.commit()
        con.close()

    def columns(self):
        con = sqlite3.connect(self.database)
        try:
            return con.execute('SELECT ID, alberguepic1URL, alberguepic2URL, alberguepic3URL FROM albergues ORDER BY ID').fetchall()
        finally:
            con.close()

    def test_it_writes_one_column_of_one_albergue(self):
        self.assertEqual(self.tool.names(4412, 2), ('a4412-2.webp', 'a4412-2-s.webp'))
        self.assertEqual(self.tool.set_column(self.database, 4412, 2, 'a4412-2.webp'), 'Refuge')
        self.assertEqual(self.columns(), [(5, None, None, None), (4412, None, 'a4412-2.webp', None)])
        self.tool.set_column(self.database, 4412, 2, None)
        self.assertEqual(self.columns(), [(5, None, None, None), (4412, None, None, None)])

    def test_an_unknown_albergue_changes_nothing(self):
        with self.assertRaises(SystemExit):
            self.tool.set_column(self.database, 999, 1, 'a999-1.webp')
        self.assertEqual(self.columns(), [(5, None, None, None), (4412, None, None, None)])

    def test_a_missing_database_or_picture_stops_before_anything_is_written(self):
        with mock.patch.object(self.tool, 'PHOTO_DIR', Path(self.folder.name) / 'stays'):
            for arguments in (['4412', '1', 'nowhere.jpg', '--database', self.database],
                              ['999', '1', __file__, '--database', self.database],     # no such albergue
                              ['4412', '1', __file__, '--database', str(Path(self.folder.name) / 'nowhere.sqlite')]):
                with self.assertRaises(SystemExit):
                    self.tool.main(arguments)
            self.assertFalse((Path(self.folder.name) / 'stays').exists())
        self.assertEqual(self.columns(), [(5, None, None, None), (4412, None, None, None)])


class PhotoStylesTests(SimpleTestCase):
    def test_the_viewer_script_leaves_a_plain_link_working_without_it(self):
        script = (ROOT / 'camino' / 'static' / 'camino' / 'js' / 'stay-photos.js').read_text(encoding='utf-8')
        self.assertIn("typeof viewer.showModal !== 'function') return;", script)
        self.assertIn('event.ctrlKey || event.metaKey || event.shiftKey', script)   # open in a new tab still works


@unittest.skipUnless((settings.BASE_DIR / 'camino.sqlite').exists(), 'camino.sqlite not found')
class TownPagePhotoTests(unittest.TestCase):
    """The town page, read from the real guide. The guide has no photos yet, so one albergue is given some here."""

    def get(self, path):
        response = Client().get(path)
        self.assertEqual(response.status_code, 200, path)
        return response.content.decode()

    def test_a_town_with_no_photos_has_no_strip_and_no_viewer(self):
        html = self.get('/location/1/')
        body = html.split('</style>')[-1]
        self.assertNotIn('accomm-photo-strip', body)
        self.assertNotIn('photo-viewer', body)
        self.assertNotIn('stay-photos.js', body)

    def test_an_albergue_with_photos_shows_them_and_the_others_are_unchanged(self):
        def fake(values, static_url='/static/', photo_dir=None):
            fake.calls += 1
            if fake.calls > 1:
                return []
            return [{'small': '/static/camino/img/stays/a1-1-s.webp', 'full': '/static/camino/img/stays/a1-1.webp'},
                    {'small': 'https://img.example/b.jpg', 'full': 'https://img.example/b.jpg'}]
        fake.calls = 0
        with mock.patch.object(stay_photos, 'photos', fake):
            html = self.get('/es/location/1/')
        body = html.split('</style>')[-1]
        self.assertEqual(body.count('class="accomm-photo-strip"'), 1)
        strip = re.search(r'<div class="accomm-photo-strip" data-count="2">(.*?)</div>', body, re.S).group(1)
        links = re.findall(r'<a class="stay-photo" href="([^"]+)"><img src="([^"]+)" alt="([^"]+)" width="480" height="320" '
                           r'loading="lazy" decoding="async"></a>', strip)
        self.assertEqual([l[:2] for l in links], [
            ('/static/camino/img/stays/a1-1.webp', '/static/camino/img/stays/a1-1-s.webp'),
            ('https://img.example/b.jpg', 'https://img.example/b.jpg')])
        self.assertRegex(links[0][2], r': foto 1$')
        self.assertRegex(links[1][2], r': foto 2$')
        self.assertIn('<dialog id="photo-viewer"', body)
        self.assertIn('>Cerrar</button>', body)
        self.assertEqual(body.count('camino/js/stay-photos.js'), 1)
