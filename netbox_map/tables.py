import django_tables2 as tables
from django.utils.translation import gettext_lazy as _

from netbox.tables import NetBoxTable, columns

from .models import Map, MapMarker, MapOverlay, MapShape

PLACED = '{% load helpers %}{% checkmark record.is_placed %}'


class MapTable(NetBoxTable):
    name = tables.Column(linkify=True, verbose_name=_('Name'))
    parent = tables.Column(linkify=True, verbose_name=_('Parent'))
    base_layer = columns.ChoiceFieldColumn(verbose_name=_('Base layer'))
    scope_type = columns.ContentTypeColumn(verbose_name=_('Assigned to (type)'))
    scope = tables.Column(linkify=True, orderable=False, verbose_name=_('Assigned to'))
    markers = columns.LinkedCountColumn(
        viewname='plugins:netbox_map:mapmarker_list', url_params={'map_id': 'pk'}, verbose_name=_('Markers'),
    )
    tags = columns.TagColumn(url_name='plugins:netbox_map:map_list')

    class Meta(NetBoxTable.Meta):
        model = Map
        fields = (
            'pk', 'id', 'name', 'parent', 'base_layer', 'scope_type', 'scope', 'markers', 'description', 'comments',
            'tags', 'created', 'last_updated',
        )
        default_columns = ('pk', 'name', 'parent', 'base_layer', 'scope', 'markers', 'description')


class MapOverlayTable(NetBoxTable):
    name = tables.Column(linkify=True, verbose_name=_('Name'))
    map = tables.Column(linkify=True, verbose_name=_('Map'))
    image = tables.TemplateColumn(
        template_code='<a href="{{ record.image.url }}">{{ record.image.name }}</a>', orderable=False,
        verbose_name=_('File'),
    )
    size = tables.TemplateColumn(
        template_code='{{ record.image_width }}×{{ record.image_height }}', orderable=False, verbose_name=_('Size'),
    )
    placed = tables.TemplateColumn(template_code=PLACED, orderable=False, verbose_name=_('Placed'))
    actions = columns.ActionsColumn(actions=('edit', 'delete'))

    class Meta(NetBoxTable.Meta):
        model = MapOverlay
        fields = ('pk', 'id', 'name', 'map', 'image', 'size', 'opacity', 'weight', 'placed', 'created',
                  'last_updated')
        default_columns = ('pk', 'name', 'map', 'size', 'opacity', 'weight', 'placed')


class MapMarkerTable(NetBoxTable):
    marker = tables.Column(accessor='pk', linkify=False, orderable=False, verbose_name=_('Marker'))
    map = tables.Column(linkify=True, verbose_name=_('Map'))
    object_type = columns.ContentTypeColumn(verbose_name=_('Type'))
    object = tables.Column(linkify=True, orderable=False, verbose_name=_('Object'))
    color = columns.ColorColumn(verbose_name=_('Color'))
    placed = tables.TemplateColumn(template_code=PLACED, orderable=False, verbose_name=_('Placed'))
    actions = columns.ActionsColumn(actions=('edit', 'delete'))

    class Meta(NetBoxTable.Meta):
        model = MapMarker
        fields = ('pk', 'id', 'marker', 'map', 'object_type', 'object', 'label', 'icon', 'color', 'x', 'y',
                  'placed', 'created', 'last_updated')
        default_columns = ('pk', 'marker', 'map', 'object_type', 'object', 'placed')

    def render_marker(self, record):
        return str(record)


class MapShapeTable(NetBoxTable):
    shape = tables.Column(accessor='pk', linkify=False, orderable=False, verbose_name=_('Shape'))
    map = tables.Column(linkify=True, verbose_name=_('Map'))
    kind = columns.ChoiceFieldColumn(verbose_name=_('Kind'))
    color = columns.ColorColumn(verbose_name=_('Color'))
    actions = columns.ActionsColumn(actions=('edit', 'delete'))

    class Meta(NetBoxTable.Meta):
        model = MapShape
        fields = ('pk', 'id', 'shape', 'map', 'kind', 'label', 'color', 'radius', 'created', 'last_updated')
        default_columns = ('pk', 'shape', 'map', 'kind', 'color')

    def render_shape(self, record):
        return str(record)
