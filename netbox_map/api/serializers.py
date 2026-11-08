from rest_framework import serializers

from core.models import ObjectType
from netbox.api.fields import ChoiceField, ContentTypeField
from netbox.api.gfk_fields import GFKSerializerField
from netbox.api.serializers import ChangeLogMessageSerializer, NetBoxModelSerializer, ValidatedModelSerializer

from ..choices import BaseLayerChoices, ShapeKindChoices, ShapeLevelChoices
from ..models import MAP_SCOPE_TYPES, ROUTE_TYPES, Map, MapMarker, MapOverlay, MapShape


class MapSerializer(NetBoxModelSerializer):
    parent = serializers.PrimaryKeyRelatedField(queryset=Map.objects.all(), required=False, allow_null=True)
    base_layer = ChoiceField(choices=BaseLayerChoices, required=False)
    scope_type = ContentTypeField(
        queryset=ObjectType.objects.filter(app_label='dcim', model__in=MAP_SCOPE_TYPES),
        required=False, allow_null=True, default=None,
    )
    scope_id = serializers.IntegerField(required=False, allow_null=True, default=None)
    scope = GFKSerializerField(read_only=True)

    class Meta:
        model = Map
        fields = (
            'id', 'url', 'display_url', 'display', 'name', 'parent', 'base_layer', 'scope_type', 'scope_id', 'scope',
            'default_x', 'default_y', 'default_zoom', 'rotation', 'layer_offsets', 'description', 'comments', 'tags', 'custom_fields', 'created',
            'last_updated',
        )
        brief_fields = ('id', 'url', 'display', 'name', 'description')


class MapOverlaySerializer(ChangeLogMessageSerializer, ValidatedModelSerializer):
    """An image on a map. Upload the image as multipart/form-data."""
    map = MapSerializer(nested=True)
    image_width = serializers.IntegerField(read_only=True)
    image_height = serializers.IntegerField(read_only=True)

    class Meta:
        model = MapOverlay
        fields = (
            'id', 'url', 'display', 'map', 'name', 'image', 'image_width', 'image_height', 'opacity', 'weight',
            'x_min', 'y_min', 'x_max', 'y_max', 'created', 'last_updated',
        )
        brief_fields = ('id', 'url', 'display', 'map', 'name')


class MapMarkerSerializer(ChangeLogMessageSerializer, ValidatedModelSerializer):
    """A NetBox object or a text label at a point on a map."""
    map = MapSerializer(nested=True)
    object_type = ContentTypeField(queryset=ObjectType.objects.all(), required=False, allow_null=True, default=None)
    object_id = serializers.IntegerField(required=False, allow_null=True, default=None)
    object = GFKSerializerField(read_only=True)

    class Meta:
        model = MapMarker
        fields = (
            'id', 'url', 'display', 'map', 'object_type', 'object_id', 'object', 'label', 'icon', 'color', 'x', 'y',
            'label_offset', 'created', 'last_updated',
        )
        brief_fields = ('id', 'url', 'display', 'map', 'object_type', 'object_id')


class MapShapeSerializer(ChangeLogMessageSerializer, ValidatedModelSerializer):
    """A line, area or circle drawn on a map."""
    map = MapSerializer(nested=True)
    kind = ChoiceField(choices=ShapeKindChoices)
    level = ChoiceField(choices=ShapeLevelChoices, required=False)
    link = serializers.PrimaryKeyRelatedField(queryset=Map.objects.all(), required=False, allow_null=True)
    # The cable, cable bundle or circuit a line is the route of.
    object_type = ContentTypeField(queryset=ObjectType.objects.filter(ROUTE_TYPES), required=False, allow_null=True,
                                   default=None)
    object_id = serializers.IntegerField(required=False, allow_null=True, default=None)
    object = GFKSerializerField(read_only=True)

    class Meta:
        model = MapShape
        fields = ('id', 'url', 'display', 'map', 'kind', 'label', 'color', 'points', 'radius', 'link', 'object_type',
                  'object_id', 'object', 'level', 'ends', 'smooth', 'label_position', 'created', 'last_updated')
        brief_fields = ('id', 'url', 'display', 'map', 'kind', 'label')
