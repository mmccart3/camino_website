# camino/context_processors.py
from django.conf import settings

def global_context(request):
    """
    Exposes global website metadata to every rendered Django template.
    """
    return {
        'APP_VERSION': getattr(settings, 'APP_VERSION', '1.0.0'),
        'SITE_NAME': 'Saint-Jean to Santiago',
    }


def version_context(request):
    return {
        'APP_VERSION': 'v1.2.11'
    }