"""REST API: /api/plugins/maps/."""
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser

from netbox.api.viewsets import NetBoxModelViewSet

from .. import filtersets
from ..models import Map, MapMarker, MapOverlay, MapShape
from . import serializers


class MapViewSet(NetBoxModelViewSet):
    queryset = Map.objects.select_related('parent', 'scope_type').prefetch_related('tags')
    serializer_class = serializers.MapSerializer
    filterset_class = filtersets.MapFilterSet


class MapOverlayViewSet(NetBoxModelViewSet):
    queryset = MapOverlay.objects.select_related('map')
    serializer_class = serializers.MapOverlaySerializer
    filterset_class = filtersets.MapOverlayFilterSet
    # The image is a file upload.
    parser_classes = (JSONParser, FormParser, MultiPartParser)


class MapMarkerViewSet(NetBoxModelViewSet):
    queryset = MapMarker.objects.select_related('map', 'object_type').prefetch_related('object')
    serializer_class = serializers.MapMarkerSerializer
    filterset_class = filtersets.MapMarkerFilterSet


class MapShapeViewSet(NetBoxModelViewSet):
    queryset = MapShape.objects.select_related('map')
    serializer_class = serializers.MapShapeSerializer
    filterset_class = filtersets.MapShapeFilterSet
