# camino/context_processors.py

def version_context(request):
    return {
        'APP_VERSION': 'v1.1.2'
    }