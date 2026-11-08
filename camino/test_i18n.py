# camino/test_i18n.py
"""Tests for the Spanish version of the guide: the helpers, the catalogue, the browser files and the pages.

Run with:  python manage.py test camino

The helper and catalogue tests never touch the database. The page tests make read-only GET requests against the
real camino.sqlite and are skipped when it is not there.
"""
import ast
import importlib.util
import json
import re
import sqlite3
import unittest
from pathlib import Path
from unittest import mock

from django.conf import settings
from django.template import Context, Template
from django.test import Client, SimpleTestCase
from django.utils import translation

from . import i18n

CAMINO = Path(__file__).resolve().parent
ROOT = CAMINO.parent
JS = CAMINO / 'static' / 'camino' / 'js'
PLACEHOLDER = re.compile(r'\{(\w+)\}')


def catalogue():
    return json.loads((CAMINO / 'locale' / 'es.json').read_text(encoding='utf-8'))


def unescape(body):
    """A template string literal's text: \\" and \\' and \\\\ stand for the plain character."""
    return re.sub(r'\\(["\'\\])', r'\1', body)


def template_phrases():
    """Every phrase written in a template with {% t %}, {% t_attr %} or {% tjs %}."""
    tag = re.compile(r'''\{%\s*(?:t|t_attr|tjs)\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')''')
    found = {}
    for path in sorted((CAMINO / 'templates' / 'camino').glob('*.html')):
        for match in tag.finditer(path.read_text(encoding='utf-8')):
            found.setdefault(unescape(match.group(1)[1:-1]), path.name)
    return found


def python_phrases():
    """Every phrase passed to tr() or plural() in the site's Python, and any call whose phrase is not a plain string."""
    found, unresolved = {}, []
    paths = [p for p in sorted(CAMINO.glob('*.py')) + sorted((CAMINO / 'templatetags').glob('*.py'))
             if not p.name.startswith('test') and p.name != 'i18n.py']
    for path in paths:
        tree = ast.parse(path.read_text(encoding='utf-8'))
        constants = {node.targets[0].id: node.value.value for node in tree.body
                     if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                     and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)}
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ('tr', 'plural')):
                continue
            wanted = node.args[:1] if node.func.id == 'tr' else node.args[1:3]
            for arg in wanted:
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    found.setdefault(arg.value, path.name)
                elif isinstance(arg, ast.Name) and arg.id in constants:
                    found.setdefault(constants[arg.id], path.name)
                else:
                    unresolved.append('%s:%d' % (path.name, node.lineno))
    return found, unresolved


# The browser scripts: where each file's phrases belong in es.json ("js" is loaded on every page, "plan" on the planner).
SCRIPT_SECTIONS = {'plan.js': 'plan', 'plan-core.js': 'plan', 'plan-share.js': 'plan',
                   'offline-pack.js': 'js', 'pwa.js': 'js', 'search.js': 'js'}
SCRIPT_CALL = re.compile(r"""\b(?:tr|t|camT)\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")""")
# Phrases a script picks by key at run time, so no call names them.
CHOSEN_BY_KEY = ['{0} day', '{0} days', '{0} place', '{0} places', '{0} walking day', '{0} walking days', '{0} long day',
                 '{0} long days', '{0} rest day', '{0} rest days', '{0} travel day', '{0} travel days',
                 'Low-valley route', 'Mountain route', 'Alternative route', 'Main route', 'Valley route', 'Standard route',
                 'Albergue', 'Hotel or guesthouse', 'Your own choice', 'Flight', 'Train', 'Bus', 'Taxi', 'Ferry', 'Other',
                 'Travel', 'Considering', 'Requested', 'Booked', 'Confirmed', 'Kitchen', 'Communal meal',
                 'Washing machine', 'Dryer', 'Private rooms', 'Meal', 'Washer', '{0} night', '{0} nights', '{0} stay', '{0} stays']


def script_phrases():
    """{section: {phrase: file}} for the phrases the browser scripts write."""
    found = {'js': {}, 'plan': {}}
    for name, section in SCRIPT_SECTIONS.items():
        source = (JS / name).read_text(encoding='utf-8')
        for match in SCRIPT_CALL.finditer(source):
            body = match.group(1)[1:-1]
            body = re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1), 16)), body)
            phrase = body.replace("\\'", "'").replace('\\"', '"').replace('\\\\', '\\')
            if re.search('[A-Za-z]', PLACEHOLDER.sub('', phrase)):      # a phrase with words in it
                found[section].setdefault(phrase, name)
    # a phrase with a context of its own is written trc('context', 'phrase') and kept in es.json as "context|phrase"
    source = (JS / 'plan.js').read_text(encoding='utf-8')
    for match in re.finditer(r"\btrc\(\s*'([^']+)'\s*,\s*'((?:[^'\\]|\\.)*)'", source):
        found['plan'].setdefault(match.group(1) + '|' + match.group(2), 'plan.js')
    # plan-share.js keeps its messages in a table (MESSAGES) instead of in calls
    source = (JS / 'plan-share.js').read_text(encoding='utf-8')
    table = re.search(r'var MESSAGES = \{(.*?)\};', source, re.S).group(1)
    for match in re.finditer(r"'((?:[^'\\]|\\.)*)'", table):
        phrase = match.group(1).replace("\\'", "'")
        if ' ' in phrase:
            found['plan'].setdefault(phrase, 'plan-share.js')
    for phrase in CHOSEN_BY_KEY:
        found['plan'].setdefault(phrase, '(chosen by key)')
    return found


class HelperTests(SimpleTestCase):
    def tables(self, ui=None, js=None, plan=None):
        return mock.patch.object(i18n, '_load', return_value={'ui': ui or {}, 'js': js or {}, 'plan': plan or {}})

    def test_english_is_the_text_as_written(self):
        with translation.override('en'), self.tables(ui={'Hello {name}': 'Hola {name}'}):
            self.assertEqual(i18n.tr('Hello {name}', name='Ana'), 'Hello Ana')
            self.assertEqual(i18n.decimal(12.5), '12.5')

    def test_spanish_uses_the_catalogue_and_falls_back_to_english(self):
        with translation.override('es'), self.tables(ui={'Hello {name}': 'Hola {name}'}):
            self.assertEqual(i18n.tr('Hello {name}', name='Ana'), 'Hola Ana')
            self.assertEqual(i18n.tr('Not translated yet'), 'Not translated yet')
            self.assertEqual(i18n.decimal(12.5), '12,5')

    def test_all_three_parts_of_the_catalogue_are_searched(self):
        with translation.override('es'), self.tables(ui={'a': 'A'}, js={'b': 'B'}, plan={'c': 'C'}):
            self.assertEqual([i18n.lookup(x) for x in 'abc'], ['A', 'B', 'C'])

    def test_a_translation_with_the_wrong_placeholders_falls_back_to_the_english_text(self):
        with translation.override('es'), self.tables(ui={'Stage {n}': 'Etapa {numero}'}):
            self.assertEqual(i18n.tr('Stage {n}', n=3), 'Stage 3')

    def test_plural_picks_the_phrase_by_count(self):
        with translation.override('es'), self.tables(ui={'{n} bed': '{n} cama', '{n} beds': '{n} camas'}):
            self.assertEqual(i18n.plural(1, '{n} bed', '{n} beds'), '1 cama')
            self.assertEqual(i18n.plural(5, '{n} bed', '{n} beds'), '5 camas')

    def test_a_language_with_a_region_counts_as_spanish(self):
        with translation.override('es-mx'):
            self.assertTrue(i18n.is_spanish())
        with translation.override('en-gb'):
            self.assertFalse(i18n.is_spanish())

    def test_the_t_tag_escapes_values_but_trusts_the_phrase(self):
        page = Template('{% load camino_i18n %}{% t "Go &rarr; {name}" name=name %}')
        with translation.override('en'):
            html = page.render(Context({'name': '<b>x</b>'}))
        self.assertEqual(html, 'Go &rarr; &lt;b&gt;x&lt;/b&gt;')

    def test_the_t_attr_tag_is_safe_inside_a_quoted_attribute(self):
        page = Template('{% load camino_i18n %}<p title="{% t_attr "Say \\"hi\\"" %}">')
        with translation.override('en'):
            self.assertEqual(page.render(Context()), '<p title="Say &quot;hi&quot;">')

    def test_the_tjs_tag_is_a_script_safe_string(self):
        page = Template('{% load camino_i18n %}{% tjs "a </script> & b" %}')
        with translation.override('en'):
            text = page.render(Context())
        self.assertNotIn('</script>', text)
        self.assertEqual(json.loads(text.replace('\\u003c', '<').replace('\\u003e', '>').replace('\\u0026', '&')),
                         'a </script> & b')

    def test_the_tr_filter_leaves_english_untouched_and_translates_spanish(self):
        page = Template('{% load camino_i18n %}[{{ value|tr }}]')
        with self.tables(ui={'All year': 'Todo el año'}):
            with translation.override('en'):
                self.assertEqual(page.render(Context({'value': ' All year '})), '[ All year ]')
            with translation.override('es'):
                self.assertEqual(page.render(Context({'value': ' All year '})), '[Todo el año]')
                self.assertEqual(page.render(Context({'value': 'Unknown'})), '[Unknown]')
                self.assertEqual(page.render(Context({'value': None})), '[None]')


class CatalogueTests(SimpleTestCase):
    def test_the_catalogue_has_its_three_parts_and_no_empty_text(self):
        data = catalogue()
        self.assertEqual(sorted(data), ['js', 'plan', 'ui'])
        for section, table in data.items():
            self.assertTrue(table, section)
            for english, spanish in table.items():
                self.assertTrue(isinstance(spanish, str) and spanish.strip(), (section, english))

    def test_spanish_text_uses_the_same_placeholders_as_the_english(self):
        for section, table in catalogue().items():
            for english, spanish in table.items():
                self.assertEqual(sorted(PLACEHOLDER.findall(english)), sorted(PLACEHOLDER.findall(spanish)), (section, english))

    def test_every_phrase_written_in_a_template_or_in_python_has_spanish(self):
        ui = catalogue()['ui']
        phrases = dict(template_phrases())
        found, unresolved = python_phrases()
        self.assertEqual(unresolved, [], 'tr() was given something other than a plain phrase')
        phrases.update({k: v for k, v in found.items() if k not in phrases})
        missing = sorted('%s  (%s)' % (phrase, where) for phrase, where in phrases.items()
                         if phrase not in ui and phrase.strip() not in ui)
        self.assertEqual(missing, [], 'phrases with no Spanish in camino/locale/es.json ("ui")')

    def test_every_phrase_a_browser_script_writes_has_spanish(self):
        data = catalogue()
        missing = []
        for section, phrases in script_phrases().items():
            for phrase, where in phrases.items():
                if phrase not in data[section]:
                    missing.append('%s: %s  (%s)' % (section, phrase, where))
        self.assertEqual(sorted(missing), [], 'phrases with no Spanish in camino/locale/es.json')

    def test_the_browser_files_are_generated_from_the_catalogue(self):
        spec = importlib.util.spec_from_file_location('build_spanish_js', ROOT / 'tool' / 'build_spanish_js.py')
        tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tool)
        data = catalogue()
        for section, path in tool.OUTPUTS.items():
            written = path.read_bytes().decode('utf-8').replace('\r\n', '\n')
            self.assertEqual(written, tool.render(section, data), '%s is out of date: run python tool/build_spanish_js.py' % path.name)


@unittest.skipUnless((settings.BASE_DIR / 'camino.sqlite').exists(), 'camino.sqlite not found')
class SpanishDataTests(SimpleTestCase):
    databases = set()

    def rows(self, sql):
        con = sqlite3.connect('file:%s?mode=ro' % (settings.BASE_DIR / 'camino.sqlite'), uri=True)
        try:
            return [row[0] for row in con.execute(sql)]
        finally:
            con.close()

    def data_text(self):
        """Text that is looked up by its value, not written in a template or script: stage and place names, and the
        stays' free text (opening periods, check-in times, price notes)."""
        values = set()
        for sql in ('select stageName from stages', 'select locationName from locations',
                    'select openingPeriod from albergues', 'select checkInTimes from albergues',
                    'select rateNotes from albergues', 'select rateNotes from privateAccommDetail'):
            values.update(str(v).strip() for v in self.rows(sql) if v and str(v).strip())
        return values

    def test_the_catalogue_has_no_phrase_that_nothing_asks_for(self):
        """A leftover phrase means a script or template changed its wording and the Spanish went stale."""
        data = catalogue()
        scripts = script_phrases()
        used_ui = set(template_phrases()) | set(python_phrases()[0])
        values = self.data_text()
        stray = ['ui: ' + p for p in data['ui'] if p not in used_ui and p not in values]
        stray += ['js: ' + p for p in data['js'] if p not in scripts['js']]
        stray += ['plan: ' + p for p in data['plan'] if p not in scripts['plan'] and p not in values]
        self.assertEqual(sorted(stray), [], 'Spanish text in camino/locale/es.json that nothing asks for')

    def test_every_stage_name_has_spanish(self):
        data = catalogue()
        names = [n.strip() for n in self.rows('select stageName from stages')]
        self.assertEqual([n for n in names if n not in data['ui'] or n not in data['plan']], [])

    def test_the_english_named_places_have_spanish(self):
        """A place whose name is an English phrase ("Exit to Huarte") must be in the catalogue; place names are
        otherwise the same in both languages."""
        data = catalogue()
        names = [n.strip() for n in self.rows('select locationName from locations') if n]
        english = re.compile(r'^(Exit to|Detour to|Camino Splits|Route Splits|Rejoin|Leave|Geographic|Refreshments)|'
                             r'( Exit| Shelter| Winery| Fountain)\b|\(Wine Fountain\)')
        self.assertEqual([n for n in names if english.search(n) and n not in data['ui']], [])


@unittest.skipUnless((settings.BASE_DIR / 'camino.sqlite').exists(), 'camino.sqlite not found')
class SpanishPagesTests(unittest.TestCase):
    """Read-only GET requests against the real camino.sqlite."""

    @classmethod
    def setUpClass(cls):
        cls.client = Client()

    def get(self, path, **extra):
        response = self.client.get(path, **extra)
        self.assertEqual(response.status_code, 200, path)
        return response.content.decode()

    def a_stage_and_a_place(self):
        con = sqlite3.connect('file:%s?mode=ro' % (settings.BASE_DIR / 'camino.sqlite'), uri=True)
        try:
            stage = con.execute('select ID from stages order by ID limit 1').fetchone()[0]
            place = con.execute('select locationID from albergues where openingPeriod = ? limit 1', ('All year',)).fetchone()[0]
        finally:
            con.close()
        return stage, place

    def test_every_page_has_a_spanish_version_that_says_so(self):
        stage, place = self.a_stage_and_a_place()
        for english in ('/', '/towns/', '/plan/', f'/stage/{stage}/', f'/location/{place}/', '/offline/', '/offline-pack/'):
            spanish = '/es' + english
            html = self.get(spanish)
            self.assertIn('<html lang="es">', html, spanish)
            plain = self.get(english)
            self.assertIn('<html lang="en">', plain, english)
            if english == '/offline/':                                 # not for search engines: no canonical or alternates
                continue
            self.assertRegex(html, r'<link rel="canonical" href="https?://[^"/]+' + re.escape(spanish) + '">', spanish)
            for tag in ('hreflang="en" href="', 'hreflang="es" href="', 'hreflang="x-default" href="'):
                self.assertIn('rel="alternate" ' + tag, html, spanish)
            self.assertRegex(plain, r'<link rel="canonical" href="https?://[^"/]+' + re.escape(english) + '">', english)
            self.assertIn('rel="alternate" hreflang="es" href="', plain, english)

    def test_the_plain_address_is_english_whatever_the_browser_asks_for(self):
        html = self.get('/', HTTP_ACCEPT_LANGUAGE='es-ES,es;q=0.9')
        self.assertIn('<html lang="en">', html)
        self.assertIn('Camino Accommodation Guide', html)

    def test_the_spanish_pages_are_in_spanish(self):
        html = self.get('/es/')
        self.assertIn('Guía de alojamientos del Camino', html)
        self.assertIn('Etapa 1a', html)
        self.assertNotIn('Camino Accommodation Guide', html)
        plan = self.get('/es/plan/')
        self.assertIn('Planifica tu Camino Francés día a día', plan)
        self.assertIn('camino/js/i18n-es-plan.js', plan)
        self.assertNotIn('i18n-es-plan.js', self.get('/plan/'))
        self.assertIn('camino/js/i18n-es.js', html)
        self.assertNotIn('i18n-es.js', self.get('/'))

    def test_the_language_switch_goes_to_the_same_page_in_the_other_language(self):
        stage, _ = self.a_stage_and_a_place()
        spanish = self.get(f'/es/stage/{stage}/')
        self.assertRegex(spanish, rf'class="lang-switch"[^>]*href="/stage/{stage}/"|href="/stage/{stage}/"[^>]*class="lang-switch"')
        english = self.get(f'/stage/{stage}/')
        self.assertRegex(english, rf'class="lang-switch"[^>]*href="/es/stage/{stage}/"|href="/es/stage/{stage}/"[^>]*class="lang-switch"')

    def test_the_spanish_404_page_is_in_spanish_and_english_stays_english(self):
        response = self.client.get('/es/nothing-here/')
        self.assertEqual(response.status_code, 404)
        self.assertIn('Página no encontrada', response.content.decode())
        response = self.client.get('/nothing-here/')
        self.assertEqual(response.status_code, 404)
        self.assertIn('Page not found', response.content.decode())

    def test_numbers_in_spanish_text_use_a_comma_but_markup_and_scripts_do_not(self):
        stage, _ = self.a_stage_and_a_place()
        html = self.get(f'/es/stage/{stage}/')
        self.assertRegex(html, r'\d+,\d km')                          # a distance a visitor reads
        for attribute in re.findall(r'viewBox="([^"]*)"', html):
            self.assertRegex(attribute, r'^[\d. ]+$')                  # never "0 0 1024,0 680"
        for attribute in re.findall(r'\b(?:width|height|x|y|cx|cy|r)="([^"]*)"', html):
            self.assertNotRegex(attribute, r'^\d+,\d+$')

    def test_the_google_maps_coordinates_keep_their_decimal_point_in_spanish(self):
        # A Spanish page that printed 42,87866,-1,56610 sent Google to the wrong place.
        con = sqlite3.connect('file:%s?mode=ro' % (settings.BASE_DIR / 'camino.sqlite'), uri=True)
        try:
            place = con.execute('select ID from locations where latitude is not null and longitude is not null '
                                'and abs(latitude) > 1 and abs(longitude) > 0.1 order by ID limit 1').fetchone()[0]
        finally:
            con.close()
        coordinates = r'-?\d+\.\d+,-?\d+\.\d+'
        for path, language in ((f'/location/{place}/', 'en'), (f'/es/location/{place}/', 'es')):
            html = self.get(path)
            self.assertRegex(html, r'maps\?q=' + coordinates + '&hl=' + language + '&z=17')       # the embedded map
            self.assertRegex(html, r'api=1&query=' + coordinates + '"')                               # "Open in Google Maps"
            self.assertNotRegex(html, r'(?:q|query)=-?\d+,\d')

    def test_the_stage_page_script_carries_the_spanish_words(self):
        stage, _ = self.a_stage_and_a_place()
        html = self.get(f'/es/stage/{stage}/')
        self.assertIn('loadingMap: "Cargando el mapa…"', html)
        self.assertIn('loadingMap: "Loading the map…"', self.get(f'/stage/{stage}/'))

    def test_a_stay_page_shows_the_opening_period_in_spanish(self):
        _, place = self.a_stage_and_a_place()
        self.assertIn('Todo el año', self.get(f'/es/location/{place}/'))
        self.assertIn('All year', self.get(f'/location/{place}/'))

    def test_the_search_finds_a_marker_by_its_spanish_or_english_name(self):
        html = self.get('/es/search/?q=desv')
        self.assertIn('Desvío a', html)
        english = self.get('/es/search/?q=exit to')            # the English name still finds it
        self.assertIn('Desvío a', english)

    def test_the_sitemap_lists_both_languages_with_alternates(self):
        body = self.get('/sitemap.xml')
        self.assertIn('/es/towns/</loc>', body)
        self.assertIn('hreflang="es"', body)
        self.assertEqual(self.get('/robots.txt').count('Disallow: /es/search/'), 1)

    def test_the_spanish_manifest_starts_in_spanish(self):
        data = json.loads(self.get('/es/manifest.webmanifest'))
        self.assertEqual(data['lang'], 'es')
        self.assertEqual(data['start_url'], '/es/')
        self.assertEqual(json.loads(self.get('/manifest.webmanifest'))['start_url'], '/')

    def test_the_service_worker_saves_the_spanish_pages_and_words(self):
        body = self.get('/sw.js')
        for address in ('"/es/"', '"/es/towns/"', '"/es/plan/"', '"/es/offline/"', 'camino/js/i18n-es.js', 'camino/js/i18n-es-plan.js'):
            self.assertIn(address, body)
