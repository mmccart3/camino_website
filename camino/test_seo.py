# camino/test_seo.py
"""Tests for the search-engine details: holding places, the sitemap's dates, stage snippets and share pictures,
alt text and link text, and the paid-link mark on Booking.com buttons.

Run with:  python manage.py test camino

The first group never touches the database. The second group makes read-only GET requests against the real
camino.sqlite and is skipped when it is not there.
"""
import html
import re
import unittest
import xml.etree.ElementTree as ET
from decimal import Decimal
from pathlib import Path
from unittest import mock

from django.conf import settings
from django.test import Client, SimpleTestCase
from django.utils import translation
from django.utils.html import escape

from . import i18n, planner, seo, stage_maps, views
from .models import Location, MapLocationCoord, Stage
from .stage_names import clean_stage_name

CAMINO = Path(__file__).resolve().parent
SITEMAP = '{http://www.sitemaps.org/schemas/sitemap/0.9}'
XHTML = '{http://www.w3.org/1999/xhtml}'

ELEVATION = {'ascent_m': 780, 'descent_m': 1090}
DEFAULT_MAP = {'src': 'https://img.example/maps/a.jpg', 'width': 1024, 'height': 617}


def place(name, latitude='42.8', longitude='-1.6'):
    return Location(
        id=1, location_name=name,
        latitude=None if latitude is None else Decimal(latitude),
        longitude=None if longitude is None else Decimal(longitude),
    )


class HoldingPlaceTests(SimpleTestCase):
    def test_the_holding_place_is_recognised_by_its_name_or_its_empty_coordinates(self):
        self.assertTrue(place('Unassigned', '0.00001', '0.00001').is_placeholder)
        for name in ('Unassigned', '  unknown place', 'TBC', 'TODO', 'Placeholder 2'):
            with self.subTest(name=name):
                self.assertTrue(place(name).is_placeholder)
        self.assertTrue(place('Somewhere', '0', '0').is_placeholder)

    def test_real_places_are_never_taken_for_holding_places(self):
        for name in ('Pamplona', 'Unamuno', 'Todos Santos', 'Tbcville'):
            with self.subTest(name=name):
                self.assertFalse(place(name).is_placeholder)
        self.assertFalse(place('Pamplona', None, None).is_placeholder)       # no position is not "0, 0"
        self.assertFalse(place('Gibraltar Strait', '0.0005', '-1.6').is_placeholder)

    def test_a_holding_place_asks_search_engines_to_skip_it_and_carries_no_structured_data(self):
        for language in ('en', 'es'):
            with translation.override(language):
                data = seo.location_seo(place('Unassigned', '0.00001', '0.00001'), [], [], None,
                                        'https://site', 'https://site/location/290/')
            self.assertTrue(data['noindex'])
            self.assertNotIn('jsonld', data)
            self.assertNotIn('image', data)
            self.assertLessEqual(len(data['description']), seo.MAX_DESCRIPTION)

    def test_an_ordinary_place_is_indexed_with_structured_data(self):
        data = seo.location_seo(place('Zubiri'), [], [], None, 'https://site', 'https://site/location/9/')
        self.assertNotIn('noindex', data)
        self.assertIn('BreadcrumbList', data['jsonld'])


class SitemapDateTests(SimpleTestCase):
    @staticmethod
    def cursor_returning(rows=None, error=None):
        cursor = mock.MagicMock()
        if error:
            cursor.execute.side_effect = error
        cursor.fetchall.return_value = rows or []
        connection = mock.MagicMock()
        connection.cursor.return_value.__enter__.return_value = cursor
        return connection, cursor

    def test_each_place_gets_the_latest_day_any_of_its_facilities_was_checked(self):
        rows = [
            (1, '2026-09-16T10:07:42.313562+00:00', None, '2026-10-20', '2026-10-16'),   # two formats, one empty
            (2, None, None, None, None),                                                 # never checked
            (3, 'not a date', '', '2026-13-45', '2026-02-30'),                           # nothing usable
            (4, '2026-09-16T10:07:42.313562+00:00', None, None, None),
        ]
        connection, cursor = self.cursor_returning(rows)
        with mock.patch.object(views, 'connection', connection):
            dates = views.location_check_dates()
        self.assertEqual(dates, {1: '2026-10-20', 4: '2026-09-16'})
        sql = cursor.execute.call_args[0][0]
        for column in ('hasBarCafeCheckedAt', 'hasPharmacyCheckedAt', 'hasGroceryStoreCheckedAt', 'hasAtmCheckedAt'):
            self.assertIn(column, sql)

    def test_a_database_without_the_date_columns_gives_a_sitemap_without_dates_not_an_error(self):
        connection, _ = self.cursor_returning(error=RuntimeError('no such column'))
        with mock.patch.object(views, 'connection', connection):
            self.assertEqual(views.location_check_dates(), {})


class StageSnippetTests(SimpleTestCase):
    def description(self, name='Zubiri to Pamplona', km=20.4, minutes=300, elevation=ELEVATION, ref='3'):
        return seo.stage_description(ref, name, km, seo.minutes_text(minutes), elevation)

    def test_the_snippet_gives_climb_and_descent_in_both_languages(self):
        self.assertIn('Climbs 780 m, descends 1090 m.', self.description())
        with translation.override('es'):
            self.assertIn('Sube 780 m y baja 1090 m.', self.description())

    def test_a_stage_without_elevation_data_has_no_climb_sentence(self):
        for elevation in (None, {}, {'ascent_m': 0, 'descent_m': 0}):
            self.assertNotIn('Climbs', self.description(elevation=elevation))

    def test_the_long_closing_sentence_is_shortened_then_dropped_before_the_climb_is_lost(self):
        stage_name = 'San Juan de Ortega to Burgos (River Option)'
        text = self.description(name=stage_name)
        self.assertIn('Climbs', text)
        longest = 'X' * 70
        for name in (stage_name, 'A' * 40, 'B' * 60, longest):
            with self.subTest(name=name):
                for language in ('en', 'es'):
                    with translation.override(language):
                        self.assertLessEqual(len(self.description(name=name)), seo.MAX_DESCRIPTION)
        # A name so long that only the name and distance fit still gives a complete sentence, not a cut-off one.
        self.assertTrue(self.description(name=longest).endswith('.') or self.description(name=longest).endswith('…'))

    def test_the_walking_time_goes_before_the_climb_does(self):
        name = 'L' * 82                                   # intro, distance and climb together would be 166 characters
        text = self.description(name=name)
        self.assertIn('Climbs 780 m', text)
        self.assertNotIn('about', text)
        self.assertIn('20.4 km.', text)
        self.assertLessEqual(len(text), seo.MAX_DESCRIPTION)

    def test_the_climb_is_kept_when_only_the_closing_sentence_has_to_go(self):
        name = 'N' * 48                                    # fits with the climb, not with the long closing sentence
        text = self.description(name=name)
        self.assertIn('Climbs 780 m', text)
        self.assertNotIn('villages on the way', text)

    def test_stage_seo_passes_the_snippet_and_share_picture_through(self):
        stage = mock.Mock(distance_km=20.4, display_ref='3', stage_name='Zubiri to Pamplona', time_minutes=300)
        data = seo.stage_seo(stage, 'https://site', 'https://site/stage/3/', elevation=ELEVATION, stage_map=DEFAULT_MAP)
        self.assertIn('Climbs 780 m', data['description'])
        self.assertEqual(data['image'], DEFAULT_MAP['src'])
        self.assertEqual((data['image_width'], data['image_height']), (1024, 617))
        plain = seo.stage_seo(stage, 'https://site', 'https://site/stage/3/')
        self.assertNotIn('image', plain)


class ShareImageTests(SimpleTestCase):
    def test_a_map_shaped_like_a_preview_card_is_offered_and_other_shapes_are_not(self):
        cases = [
            (617, True),     # 1.66 wide
            (1024, True),    # square: the edge of the range
            (394, True),     # 2.60 wide: the other edge
            (1132, False),   # taller than wide
            (1794, False),   # the Roncesvalles map
            (372, False),    # 2.75: too thin
            (197, False),    # the thinnest map
        ]
        for height, offered in cases:
            with self.subTest(height=height):
                picture = seo.stage_share_image({'src': 'https://img.example/m.jpg', 'width': 1024, 'height': height})
                self.assertEqual(bool(picture), offered)
                if offered:
                    self.assertEqual(picture, {'image': 'https://img.example/m.jpg', 'image_width': 1024,
                                               'image_height': height})

    def test_a_map_that_cannot_be_described_properly_falls_back_to_the_default_picture(self):
        good = dict(DEFAULT_MAP)
        for change in ({'src': 'http://img.example/m.jpg'}, {'src': ''}, {'src': None}, {'height': None},
                       {'width': None}, {'height': 0}):
            with self.subTest(change=change):
                self.assertEqual(seo.stage_share_image({**good, **change}), {})
        self.assertEqual(seo.stage_share_image(None), {})
        self.assertEqual(seo.stage_share_image({}), {})
        self.assertEqual(seo.stage_share_image(good)['image'], good['src'])


class StageNameTests(SimpleTestCase):
    """A name that repeats its own stage number ("16b: Frómista to ...") is shown without the number."""

    def test_only_the_stages_own_number_is_removed_from_the_front_of_its_name(self):
        cases = [
            ('16b: Frómista to Carrión de los Condes (river route)', '16b', 'Frómista to Carrión de los Condes (river route)'),
            ('  16B :   Frómista to Carrión', '16b', 'Frómista to Carrión'),      # spacing and capitals do not matter
            ('16b:Frómista', '16b', 'Frómista'),
            ('Frómista to Carrión', '16b', 'Frómista to Carrión'),                # nothing to remove
            ('16a: Frómista to Carrión', '16b', '16a: Frómista to Carrión'),      # another stage's number is left alone
            ('1: Roncesvalles', '10', '1: Roncesvalles'),
            ('10: Roncesvalles', '1', '10: Roncesvalles'),
            ('Stage 16b: Frómista', '16b', 'Stage 16b: Frómista'),                # only at the very start
            ('16b:', '16b', '16b:'),                                              # never leaves an empty name
            ('16b: 16b: Frómista', '16b', '16b: Frómista'),                       # one prefix at a time
        ]
        for name, ref, expected in cases:
            with self.subTest(name=name, ref=ref):
                self.assertEqual(clean_stage_name(name, ref), expected)

    def test_a_missing_name_or_number_is_passed_through_untouched(self):
        self.assertIsNone(clean_stage_name(None, '1'))
        self.assertEqual(clean_stage_name('16b: Frómista', None), '16b: Frómista')
        self.assertEqual(clean_stage_name('16b: Frómista', ''), '16b: Frómista')
        self.assertEqual(clean_stage_name('16b: Frómista', '  '), '16b: Frómista')

    def test_the_model_cleans_the_name_when_it_loads_a_stage(self):
        stage = Stage.from_db(None, ['id', 'stage_name', 'stage_display_reference'], [20, '16b: Frómista', '16b'])
        self.assertEqual(stage.stage_name, 'Frómista')
        self.assertEqual(stage.display_ref, '16b')

    def test_the_model_leaves_the_name_alone_when_the_number_was_not_loaded(self):
        stage = Stage.from_db(None, ['id', 'stage_name'], [20, '16b: Frómista'])   # the number is a deferred field
        self.assertEqual(stage.stage_name, '16b: Frómista')

    def test_the_planner_reads_the_cleaned_name_too(self):
        cursor = mock.MagicMock()
        cursor.fetchall.return_value = []
        cursor.fetchall.side_effect = [[(20, '16b: Frómista', 1, 2, '16b'), (3, 'Zubiri to Pamplona', 1, 2, '3')]] + [[]] * 8
        stages = planner.load_inputs(cursor)[0]
        self.assertEqual([s['name'] for s in stages], ['Frómista', 'Zubiri to Pamplona'])
        self.assertEqual([s['ref'] for s in stages], ['16b', '3'])


class SourceMarkTests(SimpleTestCase):
    """The Booking.com buttons carry the site's affiliate code, so search engines are told they are paid links."""

    def test_both_booking_buttons_on_a_place_page_are_marked_sponsored(self):
        source = (CAMINO / 'templates' / 'camino' / 'location_detail.html').read_text(encoding='utf-8')
        buttons = re.findall(r'<a [^>]*class="btn btn-booking"[^>]*>', source)
        self.assertEqual(len(buttons), 2)
        for button in buttons:
            self.assertIn('rel="sponsored noopener"', button)

    def test_the_planner_marks_its_booking_button_sponsored_and_no_other_link(self):
        source = (CAMINO / 'static' / 'camino' / 'js' / 'plan.js').read_text(encoding='utf-8')
        self.assertIn("rel: key === 'booking' ? 'sponsored noopener' : 'noopener'", source)
        self.assertEqual(source.count('sponsored'), 1)   # only the Booking.com rule


def meta(body, kind, name):
    found = re.search(r'<meta %s="%s" content="([^"]*)"' % (kind, re.escape(name)), body)
    return html.unescape(found.group(1)) if found else None


class LivePagesTests(unittest.TestCase):
    """Read-only GET requests against the real camino.sqlite."""

    @classmethod
    def setUpClass(cls):
        if not (settings.BASE_DIR / 'camino.sqlite').exists():
            raise unittest.SkipTest('camino.sqlite not found')
        cls.client = Client()
        cls.stages = list(Stage.objects.order_by('id'))

    def get(self, path):
        response = self.client.get(path)
        self.assertEqual(response.status_code, 200, path)
        return response.content.decode()

    def stage_path(self, stage, language):
        with translation.override(language):
            from django.urls import reverse
            return reverse('stage_detail', args=[stage.id])

    # -- holding places -------------------------------------------------------------------------------

    def test_location_290_asks_search_engines_to_skip_it_in_both_languages(self):
        for path in ('/location/290/', '/es/location/290/'):
            body = self.get(path)
            self.assertIn('<meta name="robots" content="noindex,follow">', body, path)
            self.assertNotIn('rel="canonical"', body, path)
            self.assertNotIn('<link rel="alternate"', body, path)
            self.assertNotIn('application/ld+json', body, path)

    def test_location_290_is_not_in_the_sitemap_but_real_places_are(self):
        body = self.get('/sitemap.xml')
        self.assertNotIn('/location/290/<', body)
        self.assertNotIn('/es/location/290/<', body)
        self.assertIn('/location/', body)
        page = self.get('/location/1/')
        self.assertIn('rel="canonical"', page)
        self.assertNotIn('noindex', page)

    def test_no_place_on_the_route_is_ever_taken_for_a_holding_place(self):
        holding = [loc.id for loc in Location.objects.all() if loc.is_placeholder]
        self.assertIn(290, holding)
        on_route = MapLocationCoord.objects.filter(location_id__in=holding).count()
        self.assertEqual(on_route, 0, 'A place on a stage map would be hidden from search engines')

    # -- sitemap dates --------------------------------------------------------------------------------

    def test_the_sitemap_dates_place_pages_only_and_puts_the_date_right_after_the_address(self):
        root = ET.fromstring(self.get('/sitemap.xml').encode())
        dated = 0
        for url in root.findall(SITEMAP + 'url'):
            tags = [child.tag for child in url]
            self.assertEqual(tags[0], SITEMAP + 'loc')
            loc = url.find(SITEMAP + 'loc').text
            lastmod = url.find(SITEMAP + 'lastmod')
            if lastmod is None:
                self.assertTrue(all(tag == XHTML + 'link' for tag in tags[1:]), loc)
                continue
            dated += 1
            self.assertEqual(tags[1], SITEMAP + 'lastmod', loc)
            self.assertRegex(lastmod.text, r'^\d{4}-\d{2}-\d{2}$')
            self.assertRegex(loc, r'/location/\d+/$')
        self.assertGreater(dated, 20)
        self.assertFalse([u for u in root.findall(SITEMAP + 'url')
                          if '/stage/' in u.find(SITEMAP + 'loc').text and u.find(SITEMAP + 'lastmod') is not None])

    def test_both_languages_of_a_place_carry_the_same_date(self):
        root = ET.fromstring(self.get('/sitemap.xml').encode())
        by_loc = {u.find(SITEMAP + 'loc').text: u.find(SITEMAP + 'lastmod') for u in root.findall(SITEMAP + 'url')}
        for loc, lastmod in by_loc.items():
            if lastmod is not None and '/es/' not in loc:
                twin = re.sub(r'^(https?://[^/]+)/', r'\1/es/', loc)
                self.assertIn(twin, by_loc)
                self.assertEqual(by_loc[twin].text, lastmod.text)

    # -- stage snippets and share pictures --------------------------------------------------------------

    def test_every_stage_snippet_fits_and_gives_the_climb_whenever_the_page_has_elevation_data(self):
        with_climb = 0
        for language, climb_word in (('en', 'Climbs'), ('es', 'Sube')):
            for stage in self.stages:
                path = self.stage_path(stage, language)
                body = self.get(path)
                description = meta(body, 'name', 'description')
                self.assertLessEqual(len(description), seo.MAX_DESCRIPTION, (path, description))
                self.assertEqual(description, meta(body, 'property', 'og:description'), path)
                has_data = i18n.lookup('Elevation data pending for this stage.', language) not in body \
                    and 'Elevation data pending for this stage.' not in body
                if has_data:
                    self.assertIn(climb_word, description, (path, description))
                    with_climb += 1
                else:
                    self.assertNotIn(climb_word, description, path)
        self.assertGreater(with_climb, 40)

    def test_each_stage_page_offers_its_map_as_the_share_picture_only_when_the_shape_suits(self):
        own_map, default = 0, 0
        for stage in self.stages:
            body = self.get(self.stage_path(stage, 'en'))
            described = stage_maps.describe(stage)
            expected = seo.stage_share_image(described)
            image = meta(body, 'property', 'og:image')
            self.assertEqual(image, meta(body, 'name', 'twitter:image'), stage.id)
            if expected:
                own_map += 1
                self.assertEqual(image, expected['image'], stage.id)
                self.assertTrue(image.startswith('https://'), stage.id)
                self.assertEqual(meta(body, 'property', 'og:image:width'), str(expected['image_width']), stage.id)
                self.assertEqual(meta(body, 'property', 'og:image:height'), str(expected['image_height']), stage.id)
                ratio = expected['image_width'] / expected['image_height']
                self.assertTrue(1.0 <= ratio <= 2.6, stage.id)
            else:
                default += 1
                self.assertEqual(meta(body, 'property', 'og:image:width'), '1200', stage.id)
                self.assertEqual(meta(body, 'property', 'og:image:height'), '630', stage.id)
        self.assertGreater(own_map, 5)
        self.assertGreater(default, 5)

    def test_the_spanish_page_offers_the_same_picture(self):
        for stage in self.stages[:12]:
            self.assertEqual(
                meta(self.get(self.stage_path(stage, 'es')), 'property', 'og:image'),
                meta(self.get(self.stage_path(stage, 'en')), 'property', 'og:image'),
                stage.id,
            )

    # -- alt text and link text -----------------------------------------------------------------------

    def test_the_stage_map_describes_the_stage_in_its_alt_text(self):
        for stage in self.stages:
            for language, template in (('en', 'Illustrated map of Camino Francés stage %s: %s'),
                                       ('es', 'Mapa ilustrado de la etapa %s del Camino Francés: %s')):
                body = self.get(self.stage_path(stage, language))
                with translation.override(language):
                    name = i18n.lookup(stage.stage_name)
                expected = template % (stage.display_ref, name)
                alt = re.search(r'<img id="stage-map-img"[^>]*?\salt="([^"]*)"', body, re.S)
                self.assertIsNotNone(alt, stage.id)
                self.assertEqual(html.unescape(alt.group(1)), expected, (stage.id, language))

    def test_alternative_route_links_name_the_route_they_lead_to_in_full(self):
        names = {s.id: s for s in self.stages}
        found = 0
        for language, prior, following in (
            ('en', '⇠ Alternative route: Stage {ref}: {name}', 'Alternative route: Stage {ref}: {name} ⇢'),
            ('es', '⇠ Ruta alternativa: etapa {ref}: {name}', 'Ruta alternativa: etapa {ref}: {name} ⇢'),
        ):
            for stage in self.stages:
                body = self.get(self.stage_path(stage, language))
                links = re.findall(r'<a href="[^"]*?/stage/(\d+)/" class="btn-nav btn-alt">\s*(.*?)\s*</a>', body, re.S)
                for stage_id, text in links:
                    target = names[int(stage_id)]
                    with translation.override(language):
                        name = i18n.lookup(target.stage_name)
                    text = html.unescape(text)
                    self.assertIn(text, (prior.format(ref=target.display_ref, name=name),
                                         following.format(ref=target.display_ref, name=name)), (stage.id, text))
                    self.assertNotIn('…', text)
                    self.assertNotIn('Alt Prior', text)
                    self.assertNotIn('Alt Next', text)
                    found += 1
        self.assertGreater(found, 4)

    def test_the_top_and_bottom_navigation_bars_show_the_same_alternative_links(self):
        for stage in self.stages:
            body = self.get(self.stage_path(stage, 'en'))
            links = re.findall(r'class="btn-nav btn-alt">\s*(.*?)\s*</a>', body, re.S)
            self.assertEqual(len(links) % 2, 0, stage.id)
            half = len(links) // 2
            self.assertEqual(links[:half], links[half:], stage.id)

    # -- stage names ----------------------------------------------------------------------------------

    def test_no_page_shows_a_stage_number_twice_in_a_row(self):
        twice = re.compile(r'(?:Stage|Etapa) (\w+): \1:')
        paths = ['/', '/es/', '/search/?q=fromista', '/es/search/?q=fromista']
        paths += [self.stage_path(stage, language) for stage in self.stages for language in ('en', 'es')]
        for path in paths:
            self.assertIsNone(twice.search(self.get(path)), path)

    def test_the_two_fromista_routes_are_named_without_their_number_in_both_languages(self):
        stages = {s.id: s for s in self.stages}
        for stage_id, ref in ((19, '16a'), (20, '16b')):
            self.assertEqual(stages[stage_id].display_ref, ref)
            self.assertFalse(stages[stage_id].stage_name.startswith(ref), stages[stage_id].stage_name)
            for language, label in (('en', 'Stage'), ('es', 'Etapa')):
                body = self.get(self.stage_path(stages[stage_id], language))
                with translation.override(language):
                    name = i18n.lookup(stages[stage_id].stage_name)
                self.assertIn('<h2>%s %s: %s</h2>' % (label, ref, escape(name)), body)

    def test_the_planner_data_carries_the_cleaned_names(self):
        body = self.get('/plan/')
        for ref in ('16a', '16b'):
            self.assertNotIn('"name":"%s: ' % ref, body)
        self.assertIn('"ref":"16a","name":"Frómista to Carrión de los Condes (road route)"', body)

    # -- paid links -----------------------------------------------------------------------------------

    def test_every_booking_button_on_every_place_page_is_marked_as_a_paid_link(self):
        buttons = 0
        for loc_id in Location.objects.order_by('id').values_list('id', flat=True):
            body = self.get('/location/%d/' % loc_id)
            for anchor in re.findall(r'<a [^>]*class="btn btn-booking"[^>]*>', body):
                buttons += 1
                self.assertIn('rel="sponsored noopener"', anchor, loc_id)
                self.assertIn('target="_blank"', anchor, loc_id)
        self.assertGreater(buttons, 20)
