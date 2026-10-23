# data_editor/security.py
from functools import wraps

from django.conf import settings
from django.http import Http404
from django.views.decorators.http import require_http_methods

LOCAL_ADDRESSES = {'127.0.0.1', '::1', 'localhost'}


def local_only(view):
    """Second layer of protection for the data editor.

    The editor is only routed when DEBUG is on. Even then, answer 404 unless the request
    comes from the same computer, so a mistaken DEBUG=True on a server cannot expose it.
    """
    @wraps(view)
    def wrapper(request, *args, **kwargs):
        if not settings.DEBUG or request.META.get('REMOTE_ADDR') not in LOCAL_ADDRESSES:
            raise Http404()
        return view(request, *args, **kwargs)
    return require_http_methods(['GET', 'POST'])(wrapper)
