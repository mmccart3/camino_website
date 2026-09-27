# camino/urls.py
from django.urls import path, include
from . import views
from django.views.generic.base import RedirectView
from django.templatetags.static import static

urlpatterns = [
    path('', views.stage_list, name='stage_list'),
    path('stage/<int:stage_id>/', views.stage_detail, name='stage_detail'),
    path('location/<int:location_id>/', views.location_detail, name='location_detail'),
    path('favicon.ico', RedirectView.as_view(url=static('camino/img/app_icon.jpg'), permanent=True)),
    
 ]