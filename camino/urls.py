# camino/urls.py
from django.urls import path, include
from . import views
from django.views.generic.base import RedirectView
from django.templatetags.static import static
from django.views.generic import TemplateView

urlpatterns = [
    path('', views.stage_list, name='stage_list'),
    path('stage/<int:stage_id>/', views.stage_detail, name='stage_detail'),
    path('location/<int:location_id>/', views.location_detail, name='location_detail'),
    path('favicon.ico', RedirectView.as_view(url=static('camino/img/app_icon.jpg'), permanent=True)),
    path(
        'sw.js',
        TemplateView.as_view(
            template_name='camino/sw.js',
            content_type='application/javascript'
        ),
        name='service_worker',
    ),
 ]