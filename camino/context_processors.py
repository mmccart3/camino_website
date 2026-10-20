# camino/context_processors.py
from django.conf import settings
from django.templatetags.static import static

from .seo import DEFAULT_DESCRIPTION, DEFAULT_TITLE, site_origin


def global_context(request):
    """
    Exposes global website metadata to every rendered Django template.
    """
    origin = site_origin(request)
    return {
        'APP_VERSION': getattr(settings, 'APP_VERSION', '1.0.0'),
        'SITE_NAME': 'Saint Jean to Santiago',
        'SITE_ORIGIN': origin,
        'CANONICAL_URL': origin + request.path,
        'OG_DEFAULT_IMAGE': origin + static('camino/img/og-default.jpg'),
        'DEFAULT_TITLE': DEFAULT_TITLE,
        'DEFAULT_DESCRIPTION': DEFAULT_DESCRIPTION,
        'LEAFLET_CSS_URL': settings.LEAFLET_CSS_URL,
        'LEAFLET_JS_URL': settings.LEAFLET_JS_URL,
    }
