# camino/urls.py
from django.urls import path, include
from . import views
from django.views.generic.base import RedirectView
from django.templatetags.static import static
from django.views.generic import TemplateView
from django.http import HttpResponse, JsonResponse
from django.conf import settings
from django.contrib import admin
import os

def service_worker(request):
    # Adjust this path if your sw.js is located in static/camino/js/sw.js
    sw_path = os.path.join(settings.BASE_DIR, 'camino', 'static', 'camino', 'js', 'sw.js')
    if not os.path.exists(sw_path):
        sw_path = os.path.join(settings.BASE_DIR, 'static', 'camino', 'js', 'sw.js')
    
    if os.path.exists(sw_path):
        with open(sw_path, 'r', encoding='utf-8') as f:
            return HttpResponse(f.read(), content_type='application/javascript')
    return HttpResponse("// sw.js missing", content_type='application/javascript', status=200)

def manifest_view(request):
  manifest_paths = [
      os.path.join(
          settings.BASE_DIR,
          'camino',
          'static',
          'camino',
          'manifest.json',
      ),
      os.path.join(
          settings.BASE_DIR, 'camino', 'static', 'manifest.json'
      ),
      os.path.join(settings.BASE_DIR, 'static', 'camino', 'manifest.json'),
  ]

  for path in manifest_paths:
    if os.path.exists(path):
      with open(path, 'r', encoding='utf-8') as f:
        return HttpResponse(
            f.read(), content_type='application/manifest+json'
        )

  # Fallback inline response so you never get a 404 error
  fallback_manifest = {
      'name': 'Saint Jean to Santiago',
      'short_name': 'Camino Guide',
      'start_url': '/',
      'display': 'standalone',
      'background_color': '#1e3a8a',
      'theme_color': '#1e3a8a',
      'icons': [{
          'src': '/static/camino/img/app_icon.jpg',
          'sizes': '192x192 512x512',
          'type': 'image/jpeg',
      }],
  }
  return JsonResponse(
      fallback_manifest, content_type='application/manifest+json'
  )


urlpatterns = [
    path('', views.stage_list, name='stage_list'),
    path('stage/<int:stage_id>/', views.stage_detail, name='stage_detail'),
    path('location/<int:location_id>/', views.location_detail, name='location_detail'),
    path('favicon.ico', RedirectView.as_view(url=static('camino/img/app_icon.jpg'), permanent=True)),
    path('sw.js', service_worker, name='service_worker'),
    # path('admin/', admin.site.urls),
    # path('', include('camino.urls')),
 ]


# The editor endpoints exist ONLY in development
if settings.DEBUG:
    urlpatterns += [
        path('editor/', include('data_editor.urls')),
    ]