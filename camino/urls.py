# camino/urls.py
from django.templatetags.static import static
from django.urls import path
from django.views.generic.base import RedirectView

from . import views

urlpatterns = [
    path('', views.stage_list, name='stage_list'),
    path('stage/<int:stage_id>/', views.stage_detail, name='stage_detail'),
    path('location/<int:location_id>/', views.location_detail, name='location_detail'),
    path('towns/', views.towns, name='towns'),
    path('search/', views.search, name='search'),
    path('offline/', views.offline, name='offline'),
    path('offline-pack/', views.offline_pack, name='offline_pack'),
    path('offline-pack.json', views.offline_pack_json, name='offline_pack_json'),
    path('manifest.webmanifest', views.manifest, name='manifest'),
    path('sw.js', views.service_worker, name='service_worker'),
    path('robots.txt', views.robots_txt, name='robots'),
    path('sitemap.xml', views.sitemap_xml, name='sitemap'),
    path('favicon.ico', RedirectView.as_view(url=static('camino/img/favicon-48.png'), permanent=True)),
]
