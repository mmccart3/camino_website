"""
URL configuration for config project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/6.1/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
# from django.contrib import admin
# from django.urls import path
# config/urls.py
from django.conf import settings
from django.contrib import admin
from django.urls import path, include

handler404 = 'camino.views.not_found'
handler500 = 'camino.views.server_error'

urlpatterns = [
    path('', include('camino.urls')),
]

# The Django admin and the data editor exist ONLY on a developer's own computer
# (DEBUG on). They are not routed in production.
if settings.DEBUG:
    urlpatterns += [
        path('admin/', admin.site.urls),
        path('editor/', include('data_editor.urls')),
    ]
