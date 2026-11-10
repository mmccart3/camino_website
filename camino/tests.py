# camino/tests.py
"""Tests for the SEO helpers, PWA endpoints and (read-only) smoke checks of the real data.

Run with:  python manage.py test camino

The Camino tables are unmanaged, so Django cannot build a test copy of them. The pure tests
and the SimpleTestCase tests never touch the database. LiveDatabaseSmokeTests is a plain
unittest case that only performs GET requests against the real camino.sqlite.
"""
import gzip
import json
import math
import re
import struct
import unittest
import xml.etree.ElementTree as ET
from decimal import Decimal
from html import unescape
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

from django.conf import settings
from django.test import Client, RequestFactory, SimpleTestCase, override_settings
from django.urls import reverse
from django.utils import translation

from . import planner, seo, stage_maps, views
from .models import (BOOKING_AFFILIATE_PARAMS, Albergue, Location, MapLocationCoord, PrivateAccomm, Stage, clean_email,
                     google_maps_url, my_maps_embed_url)


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

    def test_the_planner_works_offline(self):
        body = self.client.get('/sw.js').content.decode()
        urls = json.loads(re.search(r'const PRECACHE_URLS = (\[.*?\]);', body, re.S).group(1))
        self.assertIn('/plan/', urls)
        for name in ('plan-core.js', 'qr.js', 'plan-share.js', 'plan-message.js', 'plan.js', 'plan.css'):
            self.assertTrue(any(u.endswith('/' + name) for u in urls), name)

    def test_the_stage_page_pace_script_works_offline(self):
        body = self.client.get('/sw.js').content.decode()
        urls = json.loads(re.search(r'const PRECACHE_URLS = (\[.*?\]);', body, re.S).group(1))
        self.assertTrue(any(u.endswith('/stage-pace.js') for u in urls))

    def test_the_stay_details_are_saved_for_offline_use(self):
        body = self.client.get('/sw.js').content.decode()
        urls = json.loads(re.search(r'const PRECACHE_URLS = (\[.*?\]);', body, re.S).group(1))
        self.assertIn('/plan/stays.json', urls)
        self.assertIn("path === '/plan/stays.json'", body)   # and the worker answers it from the saved copy when offline

    def test_robots_points_to_sitemap(self):
        response = self.client.get('/robots.txt')
        self.assertEqual(response.status_code, 200)
        self.assertIn('Sitemap: ', response.content.decode())
        self.assertIn('Disallow: /search/', response.content.decode())
        self.assertIn('Disallow: /plan/stays.json', response.content.decode())

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

    def test_there_is_no_login_admin_or_editing_page(self):
        # The site is read-only, so these never exist, with DEBUG on or off.
        for path in ('/admin/', '/editor/', '/accounts/login/', '/login/'):
            self.assertEqual(self.client.get(path).status_code, 404, path)

    def test_only_read_apps_are_installed(self):
        for name in ('django.contrib.admin', 'django.contrib.auth', 'django.contrib.sessions', 'data_editor'):
            self.assertNotIn(name, settings.INSTALLED_APPS, name)


class PlannerPageContractTests(SimpleTestCase):
    """plan.js finds its elements by id; this keeps the template and the script in step."""

    def read(self, *parts):
        return (settings.BASE_DIR / 'camino' / Path(*parts)).read_text(encoding='utf-8')

    def test_every_id_the_script_uses_is_in_the_template(self):
        script = self.read('static', 'camino', 'js', 'plan.js')
        template = self.read('templates', 'camino', 'plan.html')
        used = set(re.findall(r"\$\('([a-z-]+)'\)", script))
        self.assertGreater(len(used), 20)
        for element_id in sorted(used):
            self.assertIn(f'id="{element_id}"', template, element_id)

    def test_the_page_loads_the_core_before_the_script(self):
        template = self.read('templates', 'camino', 'plan.html')
        self.assertLess(template.index('plan-core.js'), template.index('camino/js/plan.js'))
        # the code that makes and reads plan codes is loaded before the page script uses it
        self.assertLess(template.index('plan-core.js'), template.index('camino/js/plan-share.js'))
        self.assertLess(template.index('camino/js/qr.js'), template.index('camino/js/plan.js'))
        self.assertLess(template.index('camino/js/plan-share.js'), template.index('camino/js/plan.js'))
        self.assertLess(template.index('camino/js/plan-message.js'), template.index('camino/js/plan.js'))   # the "Ask for a bed" message
        self.assertIn('id="plan-data" type="application/json"', template)

    def test_the_stay_picker_knows_where_to_load_the_details_from(self):
        template = self.read('templates', 'camino', 'plan.html')
        self.assertIn('data-details-url="{% url \'plan_stays\' %}"', template)
        self.assertIn('id="plan-stay-note"', template)

    def test_the_stay_buttons_have_what_they_are_drawn_with(self):
        """The ways to reach a place are the guide's own buttons, so the page carries the icon sprite and the WhatsApp logo."""
        template = self.read('templates', 'camino', 'plan.html')
        script = self.read('static', 'camino', 'js', 'plan.js')
        sprite = self.read('templates', 'camino', '_icons.html')
        base = self.read('templates', 'camino', 'base.html')
        self.assertIn("{% include 'camino/_icons.html' %}", template)
        self.assertIn("data-wa-logo=\"{% static 'camino/img/whatsapp-logo-green.svg' %}\"", template)
        used = set(re.findall(r"icon\('(i-[a-z]+)'\)", script))
        self.assertGreaterEqual(len(used), 3)
        for symbol in sorted(used):
            self.assertIn(f'id="{symbol}"', sprite, symbol)
        for rule in ('.plan-links .btn {', '.plan-links .btn-wa'):   # the look is shared with the place pages
            self.assertIn(rule, base, rule)

    def test_a_journey_in_several_legs_is_explained_and_a_night_journey_says_so(self):
        """A bus then two flights is three journeys on one day, and an arrival before the departure is the next day."""
        script = self.read('static', 'camino', 'js', 'plan.js')
        core = self.read('static', 'camino', 'js', 'plan-core.js')
        template = self.read('templates', 'camino', 'plan.html')
        self.assertIn('plan-add-travel-same', template)               # the button the hint points to
        self.assertIn('Travel on the same day', template)
        self.assertIn('plan-leg-hint', script)
        self.assertIn('such as a bus then two flights?', script)
        self.assertIn('function arrivesNextDay', core)
        self.assertIn("Plan.arrivesNextDay(day) ? tr('Arrives (next day)') : tr('Arrives')", script)
        self.assertIn("tr('arrives {0} (next day)'", script)             # the printed sheet says it too

    def test_the_menu_links_to_the_planner(self):
        base = self.read('templates', 'camino', 'base.html')
        self.assertEqual(base.count("{% url 'plan' %}"), 2)  # menu and footer


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


class RouteMapTests(SimpleTestCase):
    """The town pages show the published Google My Maps map (v1.3.6), centred on the town."""

    def read(self, *parts):
        return (settings.BASE_DIR / 'camino' / Path(*parts)).read_text(encoding='utf-8')

    @override_settings(MY_MAPS_ID='abc123', MY_MAPS_ZOOM=15)
    def test_the_address_names_the_map_the_centre_the_zoom_and_the_language(self):
        url = my_maps_embed_url(Decimal('42.88060'), Decimal('-8.54490'), 'es')
        parts = urlparse(url)
        self.assertEqual((parts.scheme, parts.netloc, parts.path), ('https', 'www.google.com', '/maps/d/embed'))
        query = parse_qs(parts.query)
        self.assertEqual(query['mid'], ['abc123'])
        self.assertEqual(query['ll'], ['42.880600,-8.544900'])
        self.assertEqual(query['z'], ['15'])
        self.assertEqual(query['hl'], ['es'])
        self.assertEqual(parse_qs(urlparse(my_maps_embed_url(42.9, -8.5)).query)['hl'], ['en'])   # English unless Spanish is asked for
        self.assertNotIn('/u/', parts.path)   # "/u/0/" would tie the address to the visitor's own Google account

    @override_settings(MY_MAPS_ID='abc123')
    def test_no_address_for_a_position_that_is_missing_or_a_placeholder(self):
        for lat, lng in ((None, None), ('', ''), ('x', 'y'), (0, 0), (0.0001, -0.0002), (91, 0), (42, 181)):
            self.assertIsNone(my_maps_embed_url(lat, lng), (lat, lng))

    def test_no_address_without_a_map_id(self):
        for value in ('', None, '   '):
            with override_settings(MY_MAPS_ID=value):
                self.assertIsNone(my_maps_embed_url(42.9, -8.5), repr(value))

    def test_the_town_page_uses_the_route_map_and_keeps_the_plain_pin_as_a_fallback(self):
        template = self.read('templates', 'camino', 'location_detail.html')
        self.assertIn('{% if location.route_map_url %}{{ location.route_map_url }}{% else %}https://maps.google.com/maps?q=', template)
        self.assertIn('title="{% t_attr "Map of the route through {name}" name=location.display_name %}"', template)
        self.assertIn('loading="lazy"', template)   # the map is only fetched when the visitor scrolls to it

    def test_the_site_is_set_up_with_a_map(self):
        self.assertRegex(settings.MY_MAPS_ID, r'^[A-Za-z0-9_-]{20,}$')
        self.assertTrue(10 <= settings.MY_MAPS_ZOOM <= 18)


class MyMapsFilesToolTests(SimpleTestCase):
    """tool/make_my_maps_files.py makes the files that are imported into Google My Maps."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        import importlib.util
        spec = importlib.util.spec_from_file_location('make_my_maps_files', settings.BASE_DIR / 'tool' / 'make_my_maps_files.py')
        cls.tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.tool)

    def test_thinning_keeps_a_turn_but_drops_wobble_inside_the_tolerance(self):
        degree = 1 / 110540   # one metre of latitude
        straight = [(42.0 + i * 0.0001, -8.0) for i in range(11)]
        self.assertEqual(self.tool.thin(straight), [straight[0], straight[-1]])
        wobble = [(lat, lon + (2 * degree if i % 2 else 0)) for i, (lat, lon) in enumerate(straight)]
        self.assertEqual(len(self.tool.thin(wobble)), 2)   # 2 m off the line is inside 5 m
        corner = straight[:6] + [(42.0005, -8.0 + 0.0005 * (i + 1)) for i in range(5)]
        thinned = self.tool.thin(corner)
        self.assertIn(straight[5], thinned)   # the corner, where the line turns east, is kept
        self.assertEqual(len(thinned), 3)
        self.assertLess(len(thinned), len(corner))
        self.assertEqual((thinned[0], thinned[-1]), (corner[0], corner[-1]))

    def test_stage_names_lose_their_own_number(self):
        self.assertEqual(self.tool.clean_name('16b: Fromista to Carrion', '16b'), 'Fromista to Carrion')
        self.assertEqual(self.tool.clean_name('Roncesvalles to Zubiri', '2'), 'Roncesvalles to Zubiri')


class StagePaceContractTests(SimpleTestCase):
    """The walking-pace slider on a stage page (v1.3.5): stage-pace.js finds its elements by id; this keeps the template and the script in step."""

    def read(self, *parts):
        return (settings.BASE_DIR / 'camino' / Path(*parts)).read_text(encoding='utf-8')

    def test_every_id_the_script_uses_is_in_the_template(self):
        script = self.read('static', 'camino', 'js', 'stage-pace.js')
        template = self.read('templates', 'camino', 'stage_detail.html')
        used = set(re.findall(r"getElementById\('([a-z-]+)'\)", script))
        self.assertGreaterEqual(len(used), 7)
        for element_id in sorted(used):
            self.assertIn(f'id="{element_id}"', template, element_id)

    def test_the_page_says_the_words_before_it_loads_the_script(self):
        template = self.read('templates', 'camino', 'stage_detail.html')
        self.assertLess(template.index('window.STAGE_PACE_TXT'), template.index("camino/js/stage-pace.js"))
        self.assertIn('<script src="{% static \'camino/js/stage-pace.js\' %}" defer></script>', template)
        words = set(re.findall(r'txt\.(\w+)', self.read('static', 'camino', 'js', 'stage-pace.js')))
        for word in sorted(words):
            self.assertRegex(template, rf'\b{word}:\s*\{{% tjs ', word)

    def test_the_slider_offers_the_planners_paces_and_is_hidden_until_the_script_runs(self):
        template = self.read('templates', 'camino', 'stage_detail.html')
        box = re.search(r'<div class="stage-pace" id="stage-pace-box"[^>]*>', template).group(0)
        self.assertRegex(box, r'\bhidden>$')   # without the script the page keeps the guide's figures
        for name in ('default', 'min', 'max'):
            self.assertIn(f'data-{name}="{{{{ pace.{name}|unlocalize }}}}"', box)
        self.assertIn('step="{{ pace.step|unlocalize }}"', template)   # |unlocalize: Spanish must not write 4,2 into an attribute
        self.assertEqual((planner.PACE_MIN, planner.PACE_MAX, planner.PACE_STEP), (1.0, 8.5, 0.1))   # all the app accepts and saves
        self.assertTrue(planner.PACE_MIN <= planner.DEFAULT_PACE <= planner.PACE_MAX)

    def test_the_stage_time_carries_the_weighted_distance_the_app_works_it_out_from(self):
        template = self.read('templates', 'camino', 'stage_detail.html')
        self.assertIn('{% if stage_weighted %} data-weighted="{{ stage_weighted|unlocalize }}"{% endif %}', template)
        self.assertIn('data-flat="{{ pace.flat|unlocalize }}"', template)
        self.assertAlmostEqual(planner.FLAT_SLOPE_EFFECT, math.exp(-2.25 * 0.07))   # the app's flat-ground factor

    def test_the_planner_page_slider_offers_the_same_range(self):
        template = self.read('templates', 'camino', 'plan.html')
        self.assertIn(f'id="plan-pace" step="0.1" min="{planner.PACE_MIN:g}" max="{planner.PACE_MAX:g}"', template)

    def test_each_place_carries_its_seconds_and_the_stage_time_its_minutes(self):
        template = self.read('templates', 'camino', 'stage_detail.html')
        self.assertIn('<span id="stage-time" data-minutes="{{ stage.time_minutes|default_if_none:\'\' }}"', template)
        self.assertIn('<span class="waypoint-time" data-seconds="{{ loc.seconds }}">{{ loc.time_formatted }}</span>', template)

    def test_the_slider_is_left_out_of_the_printed_page(self):
        base = self.read('templates', 'camino', 'base.html')
        self.assertIn('#debug-info, .stage-pace, .route-download {', base)   # in the list of things @media print hides
        self.assertLess(base.index('@media print'), base.index('#debug-info, .stage-pace, .route-download {'))


class StageGpxContractTests(SimpleTestCase):
    """The GPX download of a stage's route (v1.3.8): the address, the button, and the places that must leave it alone."""

    def read(self, *parts):
        return (settings.BASE_DIR / 'camino' / Path(*parts)).read_text(encoding='utf-8')

    def test_the_download_has_an_address_in_each_language(self):
        self.assertEqual(reverse('stage_gpx', args=[5]), '/stage/5/route.gpx')
        with translation.override('es'):
            self.assertEqual(reverse('stage_gpx', args=[5]), '/es/stage/5/route.gpx')

    def test_the_stage_page_has_the_button_only_when_there_is_a_route(self):
        template = self.read('templates', 'camino', 'stage_detail.html')
        block = re.search(r'\{% if has_elevation_data %\}\s*<div class="route-download" id="route-download">(.*?)\{% endif %\}', template, re.S)
        self.assertIsNotNone(block)
        self.assertIn('<a class="route-download-btn" href="{% url \'stage_gpx\' stage.id %}" download rel="nofollow">', block.group(1))
        self.assertIn('{% t "\u2b07\ufe0f Download GPX" %}', block.group(1))

    def test_the_worker_leaves_a_gpx_download_alone(self):
        """A download is not a page: the worker must never answer it with the "you're offline" page or keep a copy of it among the pages."""
        body = Client().get('/sw.js').content.decode()
        self.assertIn("if (path.endsWith('.gpx')) return;", body)
        self.assertLess(body.index("path.endsWith('.gpx')"), body.index("request.mode === 'navigate'"))

    def test_search_engines_are_asked_to_skip_the_downloads(self):
        self.assertIn('Disallow: /*.gpx$', Client().get('/robots.txt').content.decode())

    def test_the_button_is_left_out_of_the_printed_page(self):
        base = self.read('templates', 'camino', 'base.html')
        self.assertLess(base.index('@media print'), base.index('#debug-info, .stage-pace, .route-download {'))


class StageChartLabelTests(SimpleTestCase):
    def test_place_names_on_the_elevation_chart_are_laid_out_in_rows(self):
        """The names go in rows above the plot so that none can be drawn over another (the phone layout depends on it)."""
        template = (settings.BASE_DIR / 'camino' / 'templates' / 'camino' / 'stage_detail.html').read_text(encoding='utf-8')
        for piece in ('function layOutLabels', 'chart.options.layout.padding.top', 'id="chartNamesNote"'):
            self.assertIn(piece, template, piece)
        self.assertEqual(template.count('layout: { padding: { top: 0 } }'), 2)   # the page's chart and the drawer's


class PagePerformanceTests(SimpleTestCase):
    """Keeps the page-speed work (v1.2.53) from being undone by accident."""

    def read(self, *parts):
        return (settings.BASE_DIR / 'camino' / Path(*parts)).read_text(encoding='utf-8')

    def test_pages_are_compressed_for_browsers_that_accept_it(self):
        response = self.client.get('/offline/', HTTP_ACCEPT_ENCODING='gzip, deflate')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Content-Encoding'], 'gzip')
        self.assertIn('Accept-Encoding', response['Vary'])
        self.assertIn('<html', gzip.decompress(response.content).decode())
        self.assertNotIn('Content-Encoding', self.client.get('/offline/'))   # and left alone when the browser does not ask

    def test_only_the_stage_pages_use_leaflet(self):
        html = self.client.get('/offline/').content.decode()
        self.assertNotIn('unpkg.com', html)
        self.assertNotIn('leaflet.js', html)
        base = self.read('templates', 'camino', 'base.html')
        self.assertNotIn('LEAFLET_JS_URL', base)
        self.assertNotIn('LEAFLET_CSS_URL', base)
        town = self.read('templates', 'camino', 'location_detail.html')
        self.assertNotIn('L.map', town)   # the town page once had map code for a map that is not on the page
        self.assertNotIn('openstreetmap', town)

    def test_the_stage_page_loads_leaflet_after_the_page_has_loaded(self):
        stage = self.read('templates', 'camino', 'stage_detail.html')
        self.assertIn('function loadLeaflet', stage)
        self.assertIn("window.addEventListener('load'", stage)
        self.assertIn('{{ LEAFLET_JS_INTEGRITY }}', stage)
        self.assertIn('{{ LEAFLET_CSS_INTEGRITY }}', stage)
        self.assertNotIn('<script src="{{ LEAFLET_JS_URL }}"', stage)   # not a script that holds up the page
        self.assertIn("chart.umd.min.js' %}\" defer>", stage)
        for name in ('LEAFLET_CSS_INTEGRITY', 'LEAFLET_JS_INTEGRITY'):
            self.assertRegex(getattr(settings, name), r'^sha256-[A-Za-z0-9+/]{43}=$')

    def test_the_header_uses_the_small_icon(self):
        html = self.client.get('/offline/').content.decode()
        self.assertIn('camino/img/icon-96.png', html)
        self.assertNotIn('icon-192', html)   # the 192 pixel icon is for the manifest only
        header = (settings.BASE_DIR / 'camino' / 'static' / 'camino' / 'img' / 'icon-96.png').read_bytes()[:24]
        self.assertEqual(struct.unpack('>II', header[16:24]), (96, 96))
        urls = json.loads(re.search(r'const PRECACHE_URLS = (\[.*?\]);', self.client.get('/sw.js').content.decode(), re.S).group(1))
        self.assertTrue(any(u.endswith('/icon-96.png') for u in urls))

    def test_the_planner_keeps_its_empty_cards_out_of_sight_until_the_script_has_built_them(self):
        css = self.read('static', 'camino', 'css', 'plan.css')
        self.assertIn('.plan:not(.plan-ready) > .plan-card', css)
        self.assertIn("classList.add('plan-ready')", self.read('static', 'camino', 'js', 'plan.js'))
        self.assertIn('id="plan-loading"', self.read('templates', 'camino', 'plan.html'))


class StageMapTests(SimpleTestCase):
    """Phones are sent smaller pictures of the illustrated stage maps (v1.2.54)."""

    BASE = 'https://res.cloudinary.com/demo/image/upload/'

    def stage(self, **changes):
        full = self.BASE + 'v1/caminoAppImages/maps/1024maps/a_x.jpg'
        values = dict(
            stage_map_url=full, map_url_1024=full, map_url_1920=self.BASE + 'v1/caminoAppImages/maps/1920maps/a_x.jpg',
            map_url_640=self.BASE + 'v1/caminoAppImages/maps/640maps/a_x.jpg',
            map_url_360=self.BASE + 'v1/caminoAppImages/maps/360maps/a_x.jpg')
        values.update(changes)
        return SimpleNamespace(**values)

    def browser_picks(self, info, viewport, density):
        """The width of file a browser chooses from srcset and sizes (the rule in the HTML standard, simplified)."""
        slot = None
        for part in info['sizes'].split(','):
            part = part.strip()
            match = re.match(r'\(max-width: (\d+)px\) (\d+)px$', part)
            if match and viewport <= int(match.group(1)):
                slot = int(match.group(2))
                break
            if not match:
                slot = int(part.replace('px', ''))
                break
        widths = sorted(int(w) for w in re.findall(r' (\d+)w', info['srcset']))
        wanted = slot * density
        return next((w for w in widths if w >= wanted), widths[-1])

    def test_three_widths_of_the_same_map_are_offered_smallest_first(self):
        info = stage_maps.describe(self.stage())
        parts = [p.strip() for p in info['srcset'].split(', ')]
        self.assertEqual([p.rsplit(' ', 1)[1] for p in parts], ['360w', '640w', '1024w'])
        self.assertIn('360maps/a_x.jpg', parts[0])
        self.assertIn('640maps/a_x.jpg', parts[1])
        self.assertIn('1024maps/a_x.jpg', parts[2])
        self.assertEqual(info['src'], self.BASE + 'v1/caminoAppImages/maps/1024maps/a_x.jpg')   # the plain address is unchanged

    def test_a_phone_is_sent_a_smaller_picture_than_a_desktop(self):
        info = stage_maps.describe(self.stage())
        self.assertEqual(self.browser_picks(info, 390, 1), 360)
        self.assertEqual(self.browser_picks(info, 390, 2), 640)    # an ordinary phone screen
        self.assertEqual(self.browser_picks(info, 390, 3), 1024)   # a very sharp one
        self.assertEqual(self.browser_picks(info, 768, 1), 640)
        self.assertEqual(self.browser_picks(info, 768, 2), 1024)
        self.assertEqual(self.browser_picks(info, 1280, 1), 1024)
        self.assertEqual(self.browser_picks(info, 1280, 2), 1024)

    def test_only_widths_that_share_one_drawing_are_mixed(self):
        # The main picture is not the 1024 file (the data says so): send it alone, as before.
        other = self.stage(stage_map_url=self.BASE + 'v9/caminoAppImages/maps/1920maps/b_y.jpg')
        info = stage_maps.describe(other)
        self.assertEqual((info['srcset'], info['sizes']), ('', ''))
        self.assertEqual(info['src'], other.stage_map_url)
        # A missing small picture: the same.
        self.assertEqual(stage_maps.describe(self.stage(map_url_360=None))['srcset'], '')
        self.assertEqual(stage_maps.describe(self.stage(map_url_640='not an address'))['srcset'], '')
        # No 1024 file at all: the old fallback chain still gives a picture.
        info = stage_maps.describe(self.stage(stage_map_url=None, map_url_1024=None))
        self.assertEqual(info['src'], self.stage().map_url_1920)
        self.assertEqual(info['srcset'], '')

    def test_the_shape_is_known_only_for_a_measured_picture(self):
        measured = next(iter(stage_maps.HEIGHT_AT_1024))
        full = self.BASE + measured
        info = stage_maps.describe(self.stage(stage_map_url=full, map_url_1024=full))
        self.assertEqual((info['width'], info['height']), (1024, stage_maps.HEIGHT_AT_1024[measured]))
        unknown = stage_maps.describe(self.stage())
        self.assertEqual((unknown['width'], unknown['height'], unknown['grid_height']), (None, None, None))

    def test_the_measured_heights_are_sensible(self):
        self.assertEqual(len(stage_maps.HEIGHT_AT_1024), 34)
        for key, height in stage_maps.HEIGHT_AT_1024.items():
            self.assertRegex(key, r'^v\d+/caminoAppImages/maps/1024maps/[\w-]+\.jpg$')
            self.assertTrue(150 < height < 2500, key)

    def test_the_hotspots_are_drawn_on_a_fixed_grid_not_the_size_of_the_file(self):
        template = (settings.BASE_DIR / 'camino' / 'templates' / 'camino' / 'stage_detail.html').read_text(encoding='utf-8')
        self.assertIn('data-grid-width', template)
        self.assertNotIn("`0 0 ${img.naturalWidth} ${img.naturalHeight}`", template)   # the old, file-sized grid
        self.assertIn("mapImg.addEventListener('load', syncOverlay);", template)
        self.assertIn('this.src=this.getAttribute(\'data-full-src\')', template)       # offline: back to the saved picture


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

    def test_location_paragraphs_are_in_id_order(self):
        response = self.client.get('/location/9/')
        self.assertEqual(response.status_code, 200)
        ids = [paragraph.id for paragraph in response.context['paragraphs']]
        self.assertGreater(len(ids), 1)
        self.assertEqual(ids, sorted(ids))

    def test_home_page_has_search_title_and_schema(self):
        html = self.get('/')
        self.assertIn('id="town-search-input"', html)
        self.assertIn('id="town-index-data"', html)
        self.assertIn('rel="canonical"', html)
        self.assertNotIn(settings.APP_VERSION, html.split('<footer')[0])  # version only in the footer
        ld = re.search(r'<script type="application/ld\+json">(.*?)</script>', html, re.S)
        self.assertEqual(json.loads(ld.group(1))['@type'], 'WebSite')

    def test_the_three_routes_from_saint_jean_share_one_map_and_its_hotspots(self):
        """1a, 1b and 1c are drawn on the same map picture, so the same places must be clickable on all three."""
        spots, links = {}, {}
        for ref in ('1a', '1b', '1c'):
            stage = Stage.objects.get(stage_display_reference=ref)
            spots[ref] = set(MapLocationCoord.objects.filter(stage_id=stage.id).values_list(
                'location_id', 'top_left_x', 'top_left_y', 'bottom_right_x', 'bottom_right_y'))
            links[ref] = self.get(f'/stage/{stage.id}/').count('class="hotspot"')
        self.assertGreaterEqual(len(spots['1a']), 13)
        self.assertEqual(spots['1b'], spots['1a'])
        self.assertEqual(spots['1c'], spots['1a'])   # 1c once had only the five on the Valcarlos side
        self.assertEqual(links['1c'], len(spots['1c']))   # and every one of them is drawn on the page
        self.assertEqual(links['1b'], links['1a'])

    def test_plan_page_embeds_the_whole_guide(self):
        html = self.get('/plan/')
        self.assertIn('rel="canonical"', html)
        self.assertIn('<title>Plan your Camino', html)
        match = re.search(r'<script id="plan-data" type="application/json">(.*?)</script>', html, re.S)
        data = json.loads(match.group(1))
        self.assertEqual(data['skipped'], [])
        self.assertEqual(len(data['stages']), Stage.objects.count())
        self.assertRegex(data['guide'], r'^[0-9a-f]{16}$')
        self.assertGreater(len(data['stays']), 100)
        self.assertGreater(len(data['routes']['paths']), 200)  # the walking routes between towns
        self.assertTrue(all(str(row[1]) in data['places'] and str(row[2]) in data['places'] for row in data['routes']['paths']))
        self.assertTrue(any(len(row) == 13 for row in data['routes']['paths']))  # climb, descent and heights are there
        self.assertNotIn('<', match.group(1))  # nothing in the data can end the script tag

    def test_plan_stays_json_describes_the_places_to_stay(self):
        response = self.client.get('/plan/stays.json')
        self.assertEqual(response.status_code, 200)
        self.assertIn('application/json', response['Content-Type'])
        self.assertEqual(response['Cache-Control'], 'public, max-age=3600')
        self.assertLess(len(response.content), 350_000)
        data = json.loads(response.content)
        self.assertEqual(data['v'], 1)
        self.assertEqual(data['aff'], BOOKING_AFFILIATE_PARAMS)
        self.assertGreater(len(data['a']), 400)
        self.assertGreater(len(data['p']), 500)
        # the places the planner lists are the ones it has details for
        html = self.get('/plan/')
        plan = json.loads(re.search(r'<script id="plan-data" type="application/json">(.*?)</script>', html, re.S).group(1))
        listed = {('a' if kind == 0 else 'p', str(ident)) for kind, ident, _, _ in plan['stays']}
        have = {(k, i) for k in ('a', 'p') for i in data[k]}
        self.assertGreater(len(listed & have), 0.95 * len(listed))

    def test_plan_stays_json_matches_the_database(self):
        data = json.loads(self.client.get('/plan/stays.json').content)
        albergue = Albergue.objects.filter(rate_1p_min__gt=0, beds__gt=0).order_by('id').first()
        detail = data['a'][str(albergue.id)]
        self.assertEqual(detail['p'], float(albergue.rate_1p_min))
        self.assertEqual(detail['n'], albergue.beds)
        private = PrivateAccomm.objects.filter(rate_1p_min__gt=0).order_by('id').first()
        self.assertEqual(data['p'][str(private.id)]['p'], float(private.rate_1p_min))

    def test_the_booking_links_the_page_makes_match_the_town_pages(self):
        """The page adds the affiliate details to the plain address in the file; the town pages add them in Python."""
        data = json.loads(self.client.get('/plan/stays.json').content)
        checked = 0
        for model, kind in ((Albergue, 'a'), (PrivateAccomm, 'p')):
            for place in model.objects.exclude(booking_url__isnull=True).order_by('id')[:400]:
                detail = data[kind].get(str(place.id), {})
                if 'bk' not in detail or not place.valid_booking_url:
                    continue
                page = parse_qs(urlparse(detail['bk']).query)
                page.update({key: [value] for key, value in data['aff'].items()})
                self.assertEqual(page, parse_qs(urlparse(place.valid_booking_url).query), place.id)
                self.assertEqual(urlparse(detail['bk']).path, urlparse(place.valid_booking_url).path)
                checked += 1
        self.assertGreater(checked, 50)

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


    def test_every_stage_map_is_offered_in_three_widths_with_a_known_shape(self):
        for stage in Stage.objects.order_by('id'):
            info = stage_maps.describe(stage)
            self.assertTrue(info['srcset'], f'stage {stage.id}')
            self.assertIsNotNone(info['height'], f'stage {stage.id}: add its map to HEIGHT_AT_1024 in camino/stage_maps.py')

    def test_a_stage_page_has_the_responsive_map_and_its_grid(self):
        stage = Stage.objects.order_by('id').first()
        html = self.get(f'/stage/{stage.id}/')
        info = stage_maps.describe(stage)
        self.assertIn(f'srcset="{info["srcset"]}"', html)
        self.assertIn(f'sizes="{info["sizes"]}"', html)
        self.assertIn(f'width="1024" height="{info["height"]}"', html)
        self.assertIn(f'viewBox="0 0 1024 {info["height"]}"', html)
        self.assertIn(f'src="{info["src"]}"', html)

    def test_a_stage_page_has_the_pace_slider_with_the_guides_times(self):
        stage = Stage.objects.exclude(time_minutes__isnull=True).exclude(time_minutes=0).order_by('id').first()
        html = self.get(f'/stage/{stage.id}/')
        self.assertIn('id="stage-pace-box"', html)
        low, high = re.escape(str(planner.PACE_MIN)), re.escape(str(planner.PACE_MAX))   # 1.0 and 8.5: all the app accepts
        self.assertRegex(html, rf'<input type="range" id="stage-pace"[^>]*\bmin="{low}"[^>]*\bmax="{high}"[^>]*\bstep="0\.1"[^>]*\bvalue="4\.2"')
        self.assertIn(f'data-minutes="{stage.time_minutes}"', html)
        self.assertIn('Walking pace:', html)
        seconds = [int(n) for n in re.findall(r'class="waypoint-time" data-seconds="(\d+)"', html)]
        self.assertGreater(len(seconds), 1)
        self.assertGreater(max(seconds), 0)   # the places further along are some time away
        weighted = re.search(r'id="stage-time" data-minutes="(\d+)" data-weighted="([\d.]+)"', html)
        self.assertIsNotNone(weighted)   # the weighted distance the app's rule needs
        self.assertEqual(planner.walking_minutes(float(weighted.group(2)), planner.DEFAULT_PACE), int(weighted.group(1)))
        self.assertIn('data-flat="', html)
        self.assertIn('window.STAGE_PACE_TXT', html)
        self.assertIn('stage-pace.js', html)

    def test_the_spanish_stage_page_has_the_pace_slider_in_spanish(self):
        stage = Stage.objects.exclude(time_minutes__isnull=True).exclude(time_minutes=0).order_by('id').first()
        html = self.get(f'/es/stage/{stage.id}/')
        self.assertIn('Ritmo de marcha:', html)
        self.assertRegex(html, r'<input type="range" id="stage-pace"[^>]*\bstep="0\.1"[^>]*\bvalue="4\.2"')   # a point, never a comma, in the attribute
        self.assertIn('a {pace} km/h', html)
        self.assertIn('Volver a {pace} km/h', html)

    def test_every_stage_with_a_time_has_the_pace_slider(self):
        for stage in Stage.objects.order_by('id'):
            html = self.get(f'/stage/{stage.id}/')
            has_time = bool(stage.time_minutes)
            self.assertEqual('id="stage-pace-box"' in html, has_time, f'stage {stage.id}')

    def test_a_town_page_shows_the_route_map_centred_on_the_town(self):
        location = Location.objects.get(pk=9)
        for path, language in (('/location/9/', 'en'), ('/es/location/9/', 'es')):
            html = self.get(path)
            src = re.search(r'<iframe[^>]*\ssrc="([^"]+)"', html).group(1).replace('&amp;', '&')
            query = parse_qs(urlparse(src).query)
            self.assertEqual(urlparse(src).path, '/maps/d/embed', path)
            self.assertEqual(query['mid'], [settings.MY_MAPS_ID], path)
            self.assertEqual(query['hl'], [language], path)
            lat, lng = (float(n) for n in query['ll'][0].split(','))
            self.assertAlmostEqual(lat, float(location.latitude), places=4)
            self.assertAlmostEqual(lng, float(location.longitude), places=4)

    def test_every_town_with_a_position_gets_a_route_map(self):
        for location in Location.objects.order_by('id'):
            if location.is_placeholder or not location.latitude:
                continue
            self.assertIsNotNone(location.route_map_url, f'location {location.id}')

    def gpx_of(self, path):
        response = self.client.get(path)
        self.assertEqual(response.status_code, 200, path)
        return response, ET.fromstring(response.content)

    def test_every_stage_page_offers_a_gpx_download_that_works(self):
        ns = '{http://www.topografix.com/GPX/1/1}'
        for stage in Stage.objects.order_by('id'):
            html = self.get(f'/stage/{stage.id}/')
            self.assertIn(f'<a class="route-download-btn" href="/stage/{stage.id}/route.gpx" download rel="nofollow">', html, stage.id)
            response, root = self.gpx_of(f'/stage/{stage.id}/route.gpx')
            self.assertEqual(response['Content-Type'], 'application/gpx+xml; charset=utf-8')
            ref = re.sub(r'[^a-z0-9]+', '-', stage.display_ref.lower()).strip('-')
            self.assertEqual(response['Content-Disposition'], f'attachment; filename="saint-jean-to-santiago-stage-{ref}.gpx"')
            self.assertEqual(root.find(f'{ns}trk/{ns}name').text, root.find(f'{ns}metadata/{ns}name').text)
            self.assertTrue(root.find(f'{ns}trk/{ns}name').text.startswith(f'Stage {stage.display_ref}: '), stage.id)
            self.assertEqual(root.find(f'{ns}metadata/{ns}link').get('href'), f'http://testserver/stage/{stage.id}/')
            self.assertGreater(len(root.findall(f'{ns}trk/{ns}trkseg/{ns}trkpt')), 1000, stage.id)
            self.assertGreaterEqual(len(root.findall(f'{ns}wpt')), 2, stage.id)
            page_places = [unescape(name) for name in re.findall(r'class="waypoint-link">\s*<strong>(.*?)</strong>', html, re.S)]
            self.assertEqual([w.find(f'{ns}name').text for w in root.findall(f'{ns}wpt')], page_places, stage.id)   # the page's places, in its order

    def test_the_spanish_download_has_spanish_names_and_links_back_to_the_spanish_page(self):
        ns = '{http://www.topografix.com/GPX/1/1}'
        stage = Stage.objects.order_by('id').first()
        html = self.get(f'/es/stage/{stage.id}/')
        self.assertIn(f'href="/es/stage/{stage.id}/route.gpx"', html)
        self.assertIn('\u2b07\ufe0f Descargar GPX', html)
        response, root = self.gpx_of(f'/es/stage/{stage.id}/route.gpx')
        self.assertTrue(root.find(f'{ns}trk/{ns}name').text.startswith(f'Etapa {stage.display_ref}: '))
        self.assertEqual(root.find(f'{ns}metadata/{ns}link').get('href'), f'http://testserver/es/stage/{stage.id}/')
        page_places = [unescape(name) for name in re.findall(r'class="waypoint-link">\s*<strong>(.*?)</strong>', html, re.S)]
        self.assertEqual([w.find(f'{ns}name').text for w in root.findall(f'{ns}wpt')], page_places)
        self.assertIn('filename="saint-jean-to-santiago-stage-', response['Content-Disposition'])   # the file name is the same in both languages

    def test_a_stage_that_does_not_exist_has_no_download(self):
        self.assertEqual(self.client.get('/stage/999999/route.gpx').status_code, 404)

    def test_every_hotspot_lies_inside_the_grid_of_its_map(self):
        stages = {s.id: s for s in Stage.objects.all()}
        for spot in MapLocationCoord.objects.all():
            if spot.top_left_x is None:
                continue
            height = stage_maps.describe(stages[spot.stage_id])['height']
            self.assertTrue(0 <= spot.top_left_x < spot.bottom_right_x <= 1026, spot.id)
            self.assertTrue(0 <= spot.top_left_y < spot.bottom_right_y <= height + 2, spot.id)
