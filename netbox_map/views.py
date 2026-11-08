from django.db.models import Count, Prefetch
from django.http import Http404, HttpResponseForbidden, JsonResponse
from django.shortcuts import get_object_or_404, render
from django.urls import reverse
from django.utils.http import urlencode
from django.utils.translation import gettext_lazy as _
from django.views.generic import View

from netbox.object_actions import AddObject, BulkDelete, BulkExport
from netbox.views import generic
from utilities.views import register_model_view

from . import cards, filtersets, forms, tables, viewer
from .models import Map, MapMarker, MapOverlay, MapShape


#
# Maps
#

@register_model_view(Map, 'list', path='', detail=False)
class MapListView(generic.ObjectListView):
    """
    All maps, as NetBox's usual table or as a grid of cards. ?view=grid or
    ?view=list switches; each user's last choice is kept in their NetBox
    preferences.
    """
    queryset = Map.objects.select_related('parent', 'scope_type')
    filterset = filtersets.MapFilterSet
    filterset_form = forms.MapFilterForm
    table = tables.MapTable
    template_name = 'netbox_map/map_list.html'

    # Where the choice is kept in the user's preferences.
    VIEW_PREFERENCE = 'plugins.netbox_map.maps_view'
    # The most maps the grid shows at once; filters narrow it down.
    GRID_LIMIT = 200

    def get_extra_context(self, request):
        user = request.user
        view = request.GET.get('view')
        if view in ('grid', 'list'):
            if user.is_authenticated and user.config.get(self.VIEW_PREFERENCE) != view:
                user.config.set(self.VIEW_PREFERENCE, view, commit=True)
        else:
            view = (user.config.get(self.VIEW_PREFERENCE) if user.is_authenticated else None) or 'list'
        if view != 'grid':
            return {'view': 'list'}
        # The filters are already applied to self.queryset.
        maps = (
            self.queryset.restrict(user, 'view')
            .annotate(marker_count=Count('markers', distinct=True), shape_count=Count('shapes', distinct=True))
            .prefetch_related(Prefetch('overlays', queryset=MapOverlay.objects.order_by('weight', 'pk')), 'scope')
        )
        maps = list(maps[:self.GRID_LIMIT + 1])
        return {
            'view': 'grid',
            'maps': maps[:self.GRID_LIMIT],
            'more_maps': len(maps) > self.GRID_LIMIT,
        }


@register_model_view(Map)
class MapView(generic.ObjectView):
    queryset = Map.objects.select_related('parent', 'scope_type')
    # Rows shown in each list under the map; the rest are a link away.
    PANEL_ROWS = 25

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
            queryset = queryset.restrict(request.user, 'view')
            count = queryset.count()
            table = table_class(queryset[:self.PANEL_ROWS], orderable=False)
            # A column naming this map says nothing on the map's own page.
            for column in ('map', 'parent'):
                if column in table.columns.names():
                    table.columns.hide(column)
            opts = model._meta
            panels.append({
                'heading': heading,
                'table': table,
                # Shapes are drawn on the map, not added from a form.
                'add_url': None if model is MapShape else f'plugins:netbox_map:{opts.model_name}_add',
                'add_permission': f'{opts.app_label}.add_{opts.model_name}',
                'add_field': field,
                'count': count,
                'more': count > self.PANEL_ROWS,
                # The full list, filtered to this map.
                'list_url': reverse(f'plugins:netbox_map:{opts.model_name}_list') + '?' + urlencode(
                    {f'{field}_id': instance.pk}
                ),
            })
        # The map itself. ?edit=1 turns on the editor, ?marker=<id> zooms to one marker.
        highlight = request.GET.get('marker')
        data = viewer.map_data(instance, request, highlight=int(highlight) if str(highlight).isdigit() else None)
        can_edit = any(data['can'].values())
        return {
            'panels': panels,
            'map_data': data,
            'can_edit': can_edit,
            'editing': can_edit and request.GET.get('edit') == '1',
            'unplaced_markers': [marker for marker in data['markers'] if marker['x'] is None],
        }


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


# Shapes are drawn on the map, so there is no add form.
@register_model_view(MapShape, 'list', path='', detail=False)
class MapShapeListView(generic.ObjectListView):
    queryset = MapShape.objects.select_related('map')
    filterset = filtersets.MapShapeFilterSet
    filterset_form = forms.MapShapeFilterForm
    table = tables.MapShapeTable
    actions = (BulkExport, BulkDelete)


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


#
# Data of one marker, as the map draws it. The editor reads it after adding
# a marker through the REST API, to draw it with its status color and icon.
#

class MarkerDataView(View):
    def get(self, request, pk):
        if not request.user.is_authenticated:
            return JsonResponse({'detail': 'Not logged in.'}, status=403)
        marker = get_object_or_404(MapMarker.objects.restrict(request.user, 'view'), pk=pk)
        data = viewer.marker_data(marker, request.user)
        if data is None:
            return JsonResponse({'detail': 'Not found.'}, status=404)
        return JsonResponse(data)


#
# The card shown when the mouse rests on a marker (see cards.py).
#

class MarkerCardView(View):
    def get(self, request, pk):
        if not request.user.is_authenticated:
            return HttpResponseForbidden()
        marker = get_object_or_404(MapMarker.objects.restrict(request.user, 'view'), pk=pk)
        # Same rule as the map itself: no card for an object the user can't see.
        if viewer.marker_data(marker, request.user) is None or marker.object is None:
            raise Http404
        return render(request, 'netbox_map/inc/hover_card.html',
                      cards.card_context(marker.object, marker.object_type, request.user))


class ShapeCardView(View):
    """The card of a line drawn as a cable's, cable bundle's or circuit's route."""

    def get(self, request, pk):
        if not request.user.is_authenticated:
            return HttpResponseForbidden()
        shape = get_object_or_404(MapShape.objects.restrict(request.user, 'view'), pk=pk)
        if viewer.route_object(shape, request.user) is None:
            raise Http404
        return render(request, 'netbox_map/inc/hover_card.html',
                      cards.card_context(shape.object, shape.object_type, request.user))
