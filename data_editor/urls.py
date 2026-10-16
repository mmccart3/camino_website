# data_editor/urls.py
from django.urls import path
from . import views

urlpatterns = [
    path('', views.editor_dashboard, name='editor_dashboard'),
    path('new/<str:model_name>/', views.create_item, name='editor_create_item'),
    path('edit/<str:model_name>/<int:pk>/', views.edit_item, name='editor_edit_item'),
]