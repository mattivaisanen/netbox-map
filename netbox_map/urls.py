from django.urls import include, path

from utilities.urls import get_model_urls

from . import assets
from . import views  # noqa: F401 (registers the views get_model_urls() finds)

urlpatterns = [
    path('assets/<str:name>', assets.asset, name='asset'),
    path('', include(get_model_urls('netbox_map', 'map', detail=False))),
    path('<int:pk>/', include(get_model_urls('netbox_map', 'map'))),
    path('markers/', include(get_model_urls('netbox_map', 'mapmarker', detail=False))),
    path('markers/<int:pk>/', include(get_model_urls('netbox_map', 'mapmarker'))),
    path('overlays/', include(get_model_urls('netbox_map', 'mapoverlay', detail=False))),
    path('overlays/<int:pk>/', include(get_model_urls('netbox_map', 'mapoverlay'))),
    path('shapes/', include(get_model_urls('netbox_map', 'mapshape', detail=False))),
    path('shapes/<int:pk>/', include(get_model_urls('netbox_map', 'mapshape'))),
]
