# camino/tests.py
"""Tests for the SEO helpers, PWA endpoints and (read-only) smoke checks of the real data.

Run with:  python manage.py test camino

The Camino tables are unmanaged, so Django cannot build a test copy of them. The pure tests
and the SimpleTestCase tests never touch the database. LiveDatabaseSmokeTests is a plain
unittest case that only performs GET requests against the real camino.sqlite.
"""
import json
import os
import re
import unittest
from decimal import Decimal
from types import SimpleNamespace

from django.conf import settings
from django.http import Http404, HttpResponse
from django.test import Client, RequestFactory, SimpleTestCase, override_settings

from data_editor.security import local_only

from . import seo, views
from .models import Albergue, PrivateAccomm, clean_email, google_maps_url


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
        self.assertTrue(any(u.endswith('whatsapp-logo-green.svg') for u in urls))  # logo works offline
        self.assertTrue(any(u.endswith('google-maps-pin.png') for u in urls))  # pin works offline

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


class SecurityTests(SimpleTestCase):
    def test_not_found_page_is_friendly_and_not_indexed(self):
        response = self.client.get('/no-such-page/')
        self.assertEqual(response.status_code, 404)
        html = response.content.decode()
        self.assertIn('Page not found', html)
        self.assertIn('noindex', html)

    def test_server_error_page_is_plain(self):
        response = views.server_error(RequestFactory().get('/'))
        self.assertEqual(response.status_code, 500)
        self.assertIn('Something went wrong', response.content.decode())

    def test_wildcard_host_is_not_allowed(self):
        self.assertNotIn('*', settings.ALLOWED_HOSTS)

    @unittest.skipIf(os.environ.get('DEBUG') == 'True', 'admin and editor are routed when DEBUG=True')
    def test_admin_and_editor_are_not_routed_in_production(self):
        for path in ('/admin/', '/editor/'):
            self.assertEqual(self.client.get(path).status_code, 404, path)

    def test_local_only_guard(self):
        @local_only
        def view(request):
            return HttpResponse('ok')

        factory = RequestFactory()
        with override_settings(DEBUG=True):
            self.assertEqual(view(factory.get('/', REMOTE_ADDR='127.0.0.1')).status_code, 200)
            with self.assertRaises(Http404):
                view(factory.get('/', REMOTE_ADDR='203.0.113.5'))
        with override_settings(DEBUG=False):
            with self.assertRaises(Http404):
                view(factory.get('/', REMOTE_ADDR='127.0.0.1'))


class GoogleMapsLinkTests(SimpleTestCase):
    def test_valid_coordinates_give_a_pin_link(self):
        self.assertEqual(
            google_maps_url(42.8782, -8.5448),
            'https://www.google.com/maps/search/?api=1&query=42.878200,-8.544800',
        )

    def test_missing_or_placeholder_coordinates_give_no_link(self):
        for lat, lng in [(None, None), (42.8, None), (None, -8.5), ('', ''), ('x', 'y'),
                         (0, 0), (0.00001, 0.00001), (91, 0), (0, 181)]:
            self.assertIsNone(google_maps_url(lat, lng), (lat, lng))

    def test_albergue_and_private_accommodation_expose_the_link(self):
        for model in (Albergue, PrivateAccomm):
            place = model(latitude=42.8782, longitude=-8.5448)
            self.assertIn('query=42.878200,-8.544800', place.google_maps_url)
            self.assertIsNone(model(latitude=None, longitude=None).google_maps_url)


class EmailLinkTests(SimpleTestCase):
    def test_placeholders_and_blanks_give_no_email(self):
        for value in (None, '', '   ', 'NULL', 'null', 'None', 'n/a'):
            self.assertIsNone(clean_email(value), value)

    def test_real_addresses_are_kept(self):
        self.assertEqual(clean_email(' info@example.com '), 'info@example.com')

    def test_models_expose_valid_email(self):
        for model in (Albergue, PrivateAccomm):
            self.assertEqual(model(email='a@b.es').valid_email, 'a@b.es')
            self.assertIsNone(model(email='NULL').valid_email)
            self.assertIsNone(model(email=None).valid_email)


class AccommodationButtonAssetTests(SimpleTestCase):
    def test_icon_sprite_has_the_three_icons(self):
        from django.template.loader import render_to_string
        sprite = render_to_string('camino/_icons.html')
        for symbol in ('i-phone', 'i-email', 'i-language'):
            self.assertIn(f'<symbol id="{symbol}" viewBox="0 0 24 24"><path d="M', sprite)

    def test_google_maps_pin_is_a_png(self):
        pin = settings.BASE_DIR / 'camino' / 'static' / 'camino' / 'img' / 'google-maps-pin.png'
        self.assertEqual(pin.read_bytes()[:8], b'\x89PNG\r\n\x1a\n')


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

    def test_accommodation_cards_link_to_google_maps(self):
        pack = json.loads(self.get('/offline-pack.json'))
        link = re.compile(
            r'<a href="(https://www\.google\.com/maps/search/\?api=1&amp;query=-?\d+\.\d{6},-?\d+\.\d{6})"'
            r' target="_blank" rel="noopener" class="btn btn-map"'
        )
        found = 0
        for path in pack['pages']:
            if not path.startswith('/location/'):
                continue
            html = self.get(path)
            cards = html.count('class="accomm-card"')
            links = len(link.findall(html))
            self.assertLessEqual(links, cards, path)
            found += links
        self.assertGreater(found, 100)

    def test_whatsapp_buttons_use_the_logo(self):
        logo = settings.BASE_DIR / 'camino' / 'static' / 'camino' / 'img' / 'whatsapp-logo-green.svg'
        self.assertTrue(logo.exists())
        pack = json.loads(self.get('/offline-pack.json'))
        button = re.compile(
            r'<a href="https://wa\.me/\d+" target="_blank" rel="noopener" class="btn btn-wa"'
            r' aria-label="Message [^"]+ on WhatsApp"><img src="[^"]*whatsapp-logo-green\.svg"'
            r' alt="" width="86" height="20"></a>'
        )
        found = 0
        for path in pack['pages']:
            if not path.startswith('/location/'):
                continue
            html = self.get(path)
            self.assertEqual(html.count('https://wa.me/'), len(button.findall(html)), path)
            found += len(button.findall(html))
        self.assertGreater(found, 100)

    def test_card_buttons_sit_in_one_actions_row(self):
        pack = json.loads(self.get('/offline-pack.json'))
        checked = 0
        for path in pack['pages']:
            if not path.startswith('/location/'):
                continue
            html = self.get(path)
            for card in html.split('class="accomm-card"')[1:]:
                first_button = card.find('class="btn ')
                if first_button == -1:
                    continue
                row = card.find('class="accomm-actions"')
                self.assertNotEqual(row, -1, path)
                self.assertLess(row, first_button, path)  # no button outside the row
                self.assertEqual(card.count('class="accomm-actions"'), 1, path)
                checked += 1
        self.assertGreater(checked, 100)

    def test_no_email_button_points_at_a_placeholder(self):
        pack = json.loads(self.get('/offline-pack.json'))
        found = 0
        for path in pack['pages']:
            if not path.startswith('/location/'):
                continue
            html = self.get(path)
            self.assertNotIn('mailto:NULL', html, path)
            for address in re.findall(r'href="mailto:([^"]*)"', html):
                self.assertIn('@', address, path)
                found += 1
        self.assertGreater(found, 100)

    def test_albergues_with_private_rooms_appear_under_the_private_filter(self):
        pack = json.loads(self.get('/offline-pack.json'))
        with_rooms = 0
        for path in pack['pages']:
            if not path.startswith('/location/'):
                continue
            html = self.get(path)
            for card in html.split('class="accomm-card"')[1:]:
                if 'data-type="albergue"' not in card[:200]:
                    continue
                self.assertIn('data-private-rooms="', card, path)
                has_rooms = 'data-private-rooms="1"' in card
                self.assertEqual(has_rooms, 'Private rooms</span>' in card, path)
                with_rooms += has_rooms
        self.assertGreater(with_rooms, 50)
        template = (settings.BASE_DIR / 'camino' / 'templates' / 'camino' / 'location_detail.html').read_text(encoding='utf-8')
        self.assertIn("card.dataset.privateRooms === '1'", template)
