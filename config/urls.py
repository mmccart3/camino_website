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
from django.conf.urls.i18n import i18n_patterns
from django.urls import path, include

from camino.urls import localized_urlpatterns

handler404 = 'camino.views.not_found'
handler500 = 'camino.views.server_error'

# The site is read-only: there is no login, admin or editing page. The data is
# changed by editing the SQLite database directly (DBeaver), see the README.
urlpatterns = [
    path('', include('camino.urls')),
] + i18n_patterns(
    path('', include(localized_urlpatterns)),
    prefix_default_language=False,   # English keeps its plain addresses; Spanish is under /es/
)
