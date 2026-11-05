from netbox.api.routers import NetBoxRouter

from . import views

router = NetBoxRouter()
router.register('maps', views.MapViewSet)
router.register('overlays', views.MapOverlayViewSet)
router.register('markers', views.MapMarkerViewSet)
router.register('shapes', views.MapShapeViewSet)

urlpatterns = router.urls
