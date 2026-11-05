from django.utils.translation import gettext_lazy as _

from netbox.object_actions import AddObject, BulkDelete, BulkExport
from netbox.views import generic
from utilities.views import register_model_view

from . import filtersets, forms, tables
from .models import Map, MapMarker, MapOverlay, MapShape


#
# Maps
#

@register_model_view(Map, 'list', path='', detail=False)
class MapListView(generic.ObjectListView):
    queryset = Map.objects.select_related('parent', 'scope_type')
    filterset = filtersets.MapFilterSet
    filterset_form = forms.MapFilterForm
    table = tables.MapTable


@register_model_view(Map)
class MapView(generic.ObjectView):
    queryset = Map.objects.select_related('parent', 'scope_type')

    def get_extra_context(self, request, instance):
        """The map's submaps and parts, each as a table with its own add button."""
        sections = (
            (_('Submaps'), Map, tables.MapTable, instance.children.all(), 'parent'),
            (_('Markers'), MapMarker, tables.MapMarkerTable,
             instance.markers.select_related('object_type').prefetch_related('object'), 'map'),
            (_('Overlays'), MapOverlay, tables.MapOverlayTable, instance.overlays.all(), 'map'),
            (_('Shapes'), MapShape, tables.MapShapeTable, instance.shapes.all(), 'map'),
        )
        panels = []
        for heading, model, table_class, queryset, field in sections:
            table = table_class(queryset.restrict(request.user, 'view'), orderable=False)
            # A column naming this map says nothing on the map's own page.
            for column in ('map', 'parent'):
                if column in table.columns.names():
                    table.columns.hide(column)
            opts = model._meta
            panels.append({
                'heading': heading,
                'table': table,
                'add_url': f'plugins:netbox_map:{opts.model_name}_add',
                'add_permission': f'{opts.app_label}.add_{opts.model_name}',
                'add_field': field,
            })
        return {'panels': panels}


@register_model_view(Map, 'add', detail=False)
@register_model_view(Map, 'edit')
class MapEditView(generic.ObjectEditView):
    queryset = Map.objects.all()
    form = forms.MapForm


@register_model_view(Map, 'delete')
class MapDeleteView(generic.ObjectDeleteView):
    queryset = Map.objects.all()


@register_model_view(Map, 'bulk_import', path='import', detail=False)
class MapBulkImportView(generic.BulkImportView):
    queryset = Map.objects.all()
    model_form = forms.MapImportForm


@register_model_view(Map, 'bulk_edit', path='edit', detail=False)
class MapBulkEditView(generic.BulkEditView):
    queryset = Map.objects.all()
    filterset = filtersets.MapFilterSet
    table = tables.MapTable
    form = forms.MapBulkEditForm


@register_model_view(Map, 'bulk_delete', path='delete', detail=False)
class MapBulkDeleteView(generic.BulkDeleteView):
    queryset = Map.objects.all()
    filterset = filtersets.MapFilterSet
    table = tables.MapTable


#
# Parts of a map: overlays, markers and shapes. They have no page of their
# own; each links to its map. Lists, add, edit and delete only.
#

PART_ACTIONS = (AddObject, BulkExport, BulkDelete)


@register_model_view(MapOverlay, 'list', path='', detail=False)
class MapOverlayListView(generic.ObjectListView):
    queryset = MapOverlay.objects.select_related('map')
    filterset = filtersets.MapOverlayFilterSet
    filterset_form = forms.MapOverlayFilterForm
    table = tables.MapOverlayTable
    actions = PART_ACTIONS


@register_model_view(MapOverlay, 'add', detail=False)
@register_model_view(MapOverlay, 'edit')
class MapOverlayEditView(generic.ObjectEditView):
    queryset = MapOverlay.objects.all()
    form = forms.MapOverlayForm


@register_model_view(MapOverlay, 'delete')
class MapOverlayDeleteView(generic.ObjectDeleteView):
    queryset = MapOverlay.objects.all()


@register_model_view(MapOverlay, 'bulk_delete', path='delete', detail=False)
class MapOverlayBulkDeleteView(generic.BulkDeleteView):
    queryset = MapOverlay.objects.all()
    filterset = filtersets.MapOverlayFilterSet
    table = tables.MapOverlayTable


@register_model_view(MapMarker, 'list', path='', detail=False)
class MapMarkerListView(generic.ObjectListView):
    queryset = MapMarker.objects.select_related('map', 'object_type').prefetch_related('object')
    filterset = filtersets.MapMarkerFilterSet
    filterset_form = forms.MapMarkerFilterForm
    table = tables.MapMarkerTable
    actions = PART_ACTIONS


@register_model_view(MapMarker, 'add', detail=False)
@register_model_view(MapMarker, 'edit')
class MapMarkerEditView(generic.ObjectEditView):
    queryset = MapMarker.objects.all()
    form = forms.MapMarkerForm


@register_model_view(MapMarker, 'delete')
class MapMarkerDeleteView(generic.ObjectDeleteView):
    queryset = MapMarker.objects.all()


@register_model_view(MapMarker, 'bulk_delete', path='delete', detail=False)
class MapMarkerBulkDeleteView(generic.BulkDeleteView):
    queryset = MapMarker.objects.all()
    filterset = filtersets.MapMarkerFilterSet
    table = tables.MapMarkerTable


@register_model_view(MapShape, 'list', path='', detail=False)
class MapShapeListView(generic.ObjectListView):
    queryset = MapShape.objects.select_related('map')
    filterset = filtersets.MapShapeFilterSet
    filterset_form = forms.MapShapeFilterForm
    table = tables.MapShapeTable
    actions = PART_ACTIONS


@register_model_view(MapShape, 'add', detail=False)
@register_model_view(MapShape, 'edit')
class MapShapeEditView(generic.ObjectEditView):
    queryset = MapShape.objects.all()
    form = forms.MapShapeForm


@register_model_view(MapShape, 'delete')
class MapShapeDeleteView(generic.ObjectDeleteView):
    queryset = MapShape.objects.all()


@register_model_view(MapShape, 'bulk_delete', path='delete', detail=False)
class MapShapeBulkDeleteView(generic.BulkDeleteView):
    queryset = MapShape.objects.all()
    filterset = filtersets.MapShapeFilterSet
    table = tables.MapShapeTable
