# camino/i18n.py
"""Spanish for the guide, without gettext.

English is the language the pages are written in. Every English phrase that a visitor can read goes through
tr() (in Python) or {% t %} (in templates). In Spanish the phrase is looked up in camino/locale/es.json, a
plain list of "English text": "Texto en español" pairs that anyone can edit with a text editor; in English,
or when a phrase has no Spanish yet, the English text is shown. Nothing needs compiling.

Placeholders are written {name} (or {0}). The Spanish text must use the same placeholders as the English.

The file has three parts: "ui" for text built on the server, "js" for text built in the browser on every page
(the offline pack, the update banner, search) and "plan" for the planner page (its text, the stage names and the
Spanish for the stays' free-text opening periods, check-in times and price notes, which pages also use on the
server). "js" and "plan" are copied into static/camino/js/i18n-es.js and i18n-es-plan.js by
tool/build_spanish_js.py, which a test keeps up to date.
"""
import json
from functools import lru_cache
from pathlib import Path

from django.utils import translation

LOCALE_DIR = Path(__file__).resolve().parent / 'locale'
DEFAULT_LANGUAGE = 'en'
SPANISH = 'es'


@lru_cache(maxsize=None)
def _load(language):
    """The {"ui": {...}, "js": {...}, "plan": {...}} tables for a language (empty for English or an unknown language)."""
    path = LOCALE_DIR / f'{language}.json'
    if language == DEFAULT_LANGUAGE or not path.exists():
        return {'ui': {}, 'js': {}, 'plan': {}}
    data = json.loads(path.read_text(encoding='utf-8'))
    return {'ui': data.get('ui', {}), 'js': data.get('js', {}), 'plan': data.get('plan', {})}


def reload_catalogs():
    """Forget the loaded files (used by tests that change them)."""
    _load.cache_clear()


def current_language():
    """'es' while a Spanish page is being built, otherwise 'en'."""
    code = (translation.get_language() or DEFAULT_LANGUAGE).lower()
    return SPANISH if code == SPANISH or code.startswith(SPANISH + '-') else DEFAULT_LANGUAGE


def is_spanish():
    return current_language() == SPANISH


def lookup(message, language=None):
    """The text for a phrase in a language (default: the one in use), or the phrase itself."""
    language = language or current_language()
    if language == DEFAULT_LANGUAGE:
        return message
    tables = _load(language)
    for key in (message, message.strip()):
        found = tables['ui'].get(key) or tables['js'].get(key) or tables['plan'].get(key)
        if found:
            return found
    return message


def fill(template, english, values, args=()):
    """Puts values into {placeholders}. A broken Spanish text falls back to the English one rather than failing."""
    if not values and not args:
        return template
    try:
        return template.format(*args, **values)
    except (KeyError, IndexError, ValueError):
        return english.format(*args, **values)


def tr(message, *args, **values):
    """Translate a phrase built in Python: tr('Stage {ref}', ref=3)."""
    return fill(lookup(message), message, values, args)


def decimal(value):
    """A number for text built in Python: 12.5 is '12.5' in English and '12,5' in Spanish."""
    text = str(value)
    return text.replace('.', ',') if is_spanish() else text


def plural(count, one, many):
    """'1 bed' / '5 beds' style text: both forms are phrases with {n}."""
    return tr(one if count == 1 else many, n=count)
