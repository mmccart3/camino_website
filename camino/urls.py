# camino/urls.py
from django.templatetags.static import static
from django.urls import path
from django.views.generic.base import RedirectView

from . import views

# The pages that exist in both languages: English at the plain address, Spanish under /es/
# (config/urls.py adds the prefix). Names stay the same, so {% url 'towns' %} gives the address in the
# language of the page being built.
localized_urlpatterns = [
    path('', views.stage_list, name='stage_list'),
    path('stage/<int:stage_id>/', views.stage_detail, name='stage_detail'),
    path('stage/<int:stage_id>/route.gpx', views.stage_gpx, name='stage_gpx'),   # the stage's route as a GPX download
    path('location/<int:location_id>/', views.location_detail, name='location_detail'),
    path('towns/', views.towns, name='towns'),
    path('plan/', views.plan, name='plan'),
    path('search/', views.search, name='search'),
    path('offline/', views.offline, name='offline'),
    path('offline-pack/', views.offline_pack, name='offline_pack'),
    path('manifest.webmanifest', views.manifest, name='manifest'),
]

# Files and data that are the same whatever the language.
urlpatterns = [
    path('plan/stays.json', views.plan_stays, name='plan_stays'),
    path('offline-pack.json', views.offline_pack_json, name='offline_pack_json'),
    path('sw.js', views.service_worker, name='service_worker'),
    path('robots.txt', views.robots_txt, name='robots'),
    path('sitemap.xml', views.sitemap_xml, name='sitemap'),
    path('favicon.ico', RedirectView.as_view(url=static('camino/img/favicon-48.png'), permanent=True)),
]
