# camino/context_processors.py
from django.conf import settings
from django.templatetags.static import static
from django.urls import reverse
from django.utils import translation

from . import i18n
from .seo import default_description, default_title, site_origin

# Pages that exist in both languages (see camino/urls.py). Any other address, such as a 404, links to the home pages.
LOCALIZED_PAGES = {
    'stage_list', 'stage_detail', 'location_detail', 'towns', 'plan', 'search', 'offline', 'offline_pack',
}
LANGUAGE_NAMES = {'en': 'English', 'es': 'Español'}
OG_LOCALES = {'en': 'en_GB', 'es': 'es_ES'}


def language_urls(request):
    """The address of the page being shown in each language: {'en': '/stage/3/', 'es': '/es/stage/3/'}."""
    match = getattr(request, 'resolver_match', None)
    name = getattr(match, 'url_name', None)
    urls = {}
    for code in LANGUAGE_NAMES:
        with translation.override(code):
            if name in LOCALIZED_PAGES:
                url = reverse(name, args=match.args, kwargs=match.kwargs)
                query = request.META.get('QUERY_STRING', '')
                if name == 'search' and query:
                    url += '?' + query
            else:
                url = reverse('stage_list')
        urls[code] = url
    return urls


def global_context(request):
    """
    Exposes global website metadata to every rendered Django template.
    """
    origin = site_origin(request)
    language = i18n.current_language()
    other = 'en' if language == 'es' else 'es'
    urls = language_urls(request)
    return {
        'LANGUAGE': language,
        'OG_LOCALE': OG_LOCALES[language],
        'LANGUAGE_URLS': {code: origin + url for code, url in urls.items()},
        'LANGUAGE_SWITCH': {'code': other, 'label': LANGUAGE_NAMES[other], 'url': urls[other]},
        'HOME_URL': reverse('stage_list'),
        'APP_VERSION': getattr(settings, 'APP_VERSION', '1.0.0'),
        'SITE_NAME': 'Saint Jean to Santiago',
        'SITE_ORIGIN': origin,
        'CANONICAL_URL': origin + request.path,
        'OG_DEFAULT_IMAGE': origin + static('camino/img/og-default.jpg'),
        'DEFAULT_TITLE': default_title(),
        'DEFAULT_DESCRIPTION': default_description(),
        'LEAFLET_CSS_URL': settings.LEAFLET_CSS_URL,
        'LEAFLET_JS_URL': settings.LEAFLET_JS_URL,
        'LEAFLET_CSS_INTEGRITY': settings.LEAFLET_CSS_INTEGRITY,
        'LEAFLET_JS_INTEGRITY': settings.LEAFLET_JS_INTEGRITY,
    }
