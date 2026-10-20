# camino/tests.py
"""Tests for the SEO helpers, PWA endpoints and (read-only) smoke checks of the real data.

Run with:  python manage.py test camino

The Camino tables are unmanaged, so Django cannot build a test copy of them. The pure tests
and the SimpleTestCase tests never touch the database. LiveDatabaseSmokeTests is a plain
unittest case that only performs GET requests against the real camino.sqlite.
"""
import json
import re
import unittest
from decimal import Decimal
from types import SimpleNamespace

from django.conf import settings
from django.test import Client, SimpleTestCase

from . import seo


class SeoHelperTests(SimpleTestCase):
    def test_normalise_removes_accents_and_case(self):
        self.assertEqual(seo.normalise('  Logroño   Santo Domingo '), 'logrono santo domingo')

    def test_clip_shortens_on_word_boundary(self):
        text = 'word ' * 80
        clipped = seo.clip(text, 60)
        self.assertLessEqual(len(clipped), 60)
        self.assertTrue(clipped.endswith('…'))

    def test_compose_title_adds_site_name_only_when_it_fits(self):
        self.assertTrue(seo.compose_title('Pamplona').endswith(seo.SITE_NAME))
        long_title = 'A very long title that would make the browser tab and search result too long to read'
        self.assertEqual(seo.compose_title(long_title), long_title)

    def test_telephone_formats(self):
        self.assertEqual(seo.telephone('+34', '948 12 34 56'), '+34948123456')
        self.assertEqual(seo.telephone('+34', '0034948123456'), '+34948123456')
        self.assertEqual(seo.telephone('+34', '+33 5 59 37'), '+3355937')
        self.assertIsNone(seo.telephone('+34', ''))
        # The database stores country codes as numbers as well as text.
        self.assertEqual(seo.telephone(34, '948 12 34 56'), '+34948123456')
        self.assertEqual(seo.telephone(None, 948123456), '+34948123456')

    def test_price_range(self):
        self.assertEqual(seo.price_range(Decimal('10.00'), Decimal('15')), '€10–€15')
        self.assertEqual(seo.price_range(Decimal('12.50')), '€12.50')
        self.assertIsNone(seo.price_range(None, 0))

    def test_json_ld_cannot_close_the_script_tag(self):
        text = seo.json_ld({'name': '</script><b>&'})
        self.assertNotIn('<', text)
        self.assertEqual(json.loads(text)['name'], '</script><b>&')

    def test_stay_entry_uses_available_fields(self):
        albergue = SimpleNamespace(
            name='Albergue Test', address='Calle Mayor 1', country_code='+34', phone='948 00 00 00',
            email='info@example.com', latitude=42.8, longitude=-1.6, rate_1p_min=Decimal('10'),
            rate_1p_max=Decimal('12'), valid_website_url='https://example.com', pic1_url='https://img/a.jpg',
        )
        entry = seo.stay_entry(albergue, 'albergue', 'Pamplona', 'https://site/location/1/')
        self.assertEqual(entry['@type'], 'Hostel')
        self.assertEqual(entry['telephone'], '+34948000000')
        self.assertEqual(entry['priceRange'], '€10–€12')
        self.assertEqual(entry['address']['addressLocality'], 'Pamplona')
        self.assertEqual(entry['geo']['latitude'], 42.8)

    def test_stage_seo_mentions_distance(self):
        stage = SimpleNamespace(distance_km=24.3, display_ref='1', stage_name='Saint-Jean to Roncesvalles', time_minutes=450)
        data = seo.stage_seo(stage, 'https://site', 'https://site/stage/1/')
        self.assertIn('24.3 km', data['description'])
        self.assertIn('Stage 1', data['title'])
        self.assertLessEqual(len(data['description']), seo.MAX_DESCRIPTION)


class PwaEndpointTests(SimpleTestCase):
    def test_manifest_has_installable_icons(self):
        response = self.client.get('/manifest.webmanifest')
        self.assertEqual(response.status_code, 200)
        self.assertIn('application/manifest+json', response['Content-Type'])
        data = response.json()
        sizes = {(icon['sizes'], icon['purpose']) for icon in data['icons']}
        self.assertIn(('192x192', 'any'), sizes)
        self.assertIn(('512x512', 'any'), sizes)
        self.assertIn(('512x512', 'maskable'), sizes)
        self.assertTrue(all(icon['type'] == 'image/png' for icon in data['icons']))
        self.assertEqual(data['display'], 'standalone')

    def test_service_worker_is_versioned_and_not_cached(self):
        response = self.client.get('/sw.js')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Cache-Control'], 'no-cache')
        body = response.content.decode()
        self.assertIn(settings.APP_VERSION, body)
        self.assertNotIn('__VERSION__', body)
        self.assertNotIn('__PRECACHE__', body)
        match = re.search(r'const PRECACHE_URLS = (\[.*?\]);', body, re.S)
        self.assertIsNotNone(match)
        urls = json.loads(match.group(1))
        self.assertIn('/offline/', urls)
        self.assertIn('/', urls)

    def test_robots_points_to_sitemap(self):
        response = self.client.get('/robots.txt')
        self.assertEqual(response.status_code, 200)
        self.assertIn('Sitemap: ', response.content.decode())
        self.assertIn('Disallow: /search/', response.content.decode())

    def test_offline_page_renders_without_indexing(self):
        response = self.client.get('/offline/')
        self.assertEqual(response.status_code, 200)
        html = response.content.decode()
        self.assertIn('noindex', html)
        self.assertNotIn('rel="canonical"', html)

    def test_offline_pack_page_has_controls(self):
        html = self.client.get('/offline-pack/').content.decode()
        for element_id in ('pack-root', 'pack-start', 'pack-remove', 'pack-progress', 'pack-status'):
            self.assertIn(f'id="{element_id}"', html)
        self.assertIn(f'data-version="{settings.APP_VERSION}"', html)
        self.assertIn('rel="canonical"', html)
        self.assertIn('property="og:title"', html)


class LiveDatabaseSmokeTests(unittest.TestCase):
    """Read-only GET requests against the real camino.sqlite."""

    @classmethod
    def setUpClass(cls):
        if not (settings.BASE_DIR / 'camino.sqlite').exists():
            raise unittest.SkipTest('camino.sqlite not found')
        cls.client = Client()

    def get(self, path):
        response = self.client.get(path)
        self.assertEqual(response.status_code, 200, path)
        return response.content.decode()

    def test_home_page_has_search_title_and_schema(self):
        html = self.get('/')
        self.assertIn('id="town-search-input"', html)
        self.assertIn('id="town-index-data"', html)
        self.assertIn('rel="canonical"', html)
        self.assertNotIn(settings.APP_VERSION, html.split('<footer')[0])  # version only in the footer
        ld = re.search(r'<script type="application/ld\+json">(.*?)</script>', html, re.S)
        self.assertEqual(json.loads(ld.group(1))['@type'], 'WebSite')

    def test_towns_page_lists_towns(self):
        html = self.get('/towns/')
        self.assertIn('class="town-item"', html)

    def test_search_finds_accent_insensitively(self):
        html = self.get('/search/?q=logrono')
        self.assertIn('noindex', html)

    def test_sitemap_and_pack_list(self):
        xml = self.get('/sitemap.xml')
        self.assertIn('<urlset', xml)
        self.assertGreater(xml.count('<loc>'), 50)
        pack = json.loads(self.get('/offline-pack.json'))
        self.assertEqual(pack['version'], settings.APP_VERSION)
        self.assertGreater(len(pack['pages']), 100)
        self.assertEqual(len(pack['pages']), len(set(pack['pages'])))

    def test_every_listed_page_loads_with_unique_title(self):
        pack = json.loads(self.get('/offline-pack.json'))
        titles = {}
        for path in pack['pages']:
            if not (path.startswith('/stage/') or path.startswith('/location/')):
                continue
            html = self.get(path)
            title = re.search(r'<title>(.*?)</title>', html, re.S).group(1).strip()
            self.assertNotEqual(title, 'Camino de Santiago Accommodations', path)
            self.assertIn('name="description"', html, path)
            titles.setdefault(title, []).append(path)
        duplicates = {t: p for t, p in titles.items() if len(p) > 1}
        self.assertEqual(duplicates, {}, 'Pages share a title')
