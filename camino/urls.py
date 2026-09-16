# camino/urls.py
from django.urls import path
from . import views

urlpatterns = [
    path('', views.stage_list, name='stage_list'),
    path('stage/<int:stage_id>/', views.stage_detail, name='stage_detail'),
    path('location/<int:location_id>/', views.location_detail, name='location_detail'),
]