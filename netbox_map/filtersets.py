import django_filters
from django.db.models import Q
from django.utils.translation import gettext_lazy as _

from netbox.filtersets import ChangeLoggedModelFilterSet, NetBoxModelFilterSet
from utilities.filters import ContentTypeFilter

from .choices import BaseLayerChoices, ShapeKindChoices
from .models import Map, MapMarker, MapOverlay, MapShape


class MapFilterSet(NetBoxModelFilterSet):
    parent_id = django_filters.ModelMultipleChoiceFilter(queryset=Map.objects.all(), label=_('Parent (ID)'))
    base_layer = django_filters.MultipleChoiceFilter(choices=BaseLayerChoices)
    scope_type = ContentTypeFilter()

    class Meta:
        model = Map
        fields = ('id', 'name', 'base_layer', 'scope_id', 'description')

    def search(self, queryset, name, value):
        if not value.strip():
            return queryset
        return queryset.filter(Q(name__icontains=value) | Q(description__icontains=value))


class MapPartFilterSet(ChangeLoggedModelFilterSet):
    """Shared filters of overlays, markers and shapes: the map they are on, and a search."""
    q = django_filters.CharFilter(method='search', label=_('Search'))
    map_id = django_filters.ModelMultipleChoiceFilter(queryset=Map.objects.all(), label=_('Map (ID)'))

    search_fields = ()

    def search(self, queryset, name, value):
        if not value.strip():
            return queryset
        query = Q()
        for field in self.search_fields:
            query |= Q(**{f'{field}__icontains': value})
        return queryset.filter(query)


class MapOverlayFilterSet(MapPartFilterSet):
    search_fields = ('name',)

    class Meta:
        model = MapOverlay
        fields = ('id', 'name', 'opacity', 'weight')


class MapMarkerFilterSet(MapPartFilterSet):
    object_type = ContentTypeFilter()
    search_fields = ('label',)

    class Meta:
        model = MapMarker
        fields = ('id', 'object_type_id', 'object_id', 'label', 'icon', 'color')


class MapShapeFilterSet(MapPartFilterSet):
    kind = django_filters.MultipleChoiceFilter(choices=ShapeKindChoices)
    search_fields = ('label',)

    class Meta:
        model = MapShape
        fields = ('id', 'kind', 'label', 'color')
