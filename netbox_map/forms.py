from django import forms
from django.contrib.contenttypes.models import ContentType
from django.utils.translation import gettext_lazy as _

from core.models import ObjectType
from dcim.forms.mixins import ScopedImportForm
from netbox.forms import (
    NetBoxModelBulkEditForm, NetBoxModelFilterSetForm, NetBoxModelForm, NetBoxModelImportForm,
)
from utilities.forms import add_blank_choice
from utilities.forms.fields import (
    ColorField, CommentField, CSVChoiceField, CSVModelChoiceField, DynamicModelChoiceField,
    DynamicModelMultipleChoiceField, GenericObjectChoiceField, TagFilterField,
)
from utilities.forms.mixins import GenericObjectFormMixin
from utilities.forms.rendering import FieldSet

from . import images
from .choices import BaseLayerChoices, ShapeKindChoices
from .models import MAP_SCOPE_TYPES, Map, MapMarker, MapOverlay, MapShape


def scope_types():
    return ContentType.objects.filter(app_label='dcim', model__in=MAP_SCOPE_TYPES)


def marker_types():
    """Every NetBox object type that can be pointed at, minus the parts of a map."""
    return ObjectType.objects.public().exclude(
        app_label='netbox_map', model__in=('mapmarker', 'mapoverlay', 'mapshape'),
    )


#
# Maps
#

class MapForm(GenericObjectFormMixin, NetBoxModelForm):
    parent = DynamicModelChoiceField(queryset=Map.objects.all(), required=False, label=_('Parent'))
    scope = GenericObjectChoiceField(
        label=_('Assigned to'), content_type_queryset=scope_types(), required=False, selector=True,
        hx_target_id='scope',
        help_text=_("The map shows on this region's, site's or location's page."),
    )
    comments = CommentField()

    fieldsets = (
        FieldSet('name', 'parent', 'base_layer', 'description', 'tags', name=_('Map')),
        FieldSet('scope', name=_('Assignment'), html_id='scope'),
    )

    class Meta:
        model = Map
        fields = ('name', 'parent', 'base_layer', 'description', 'comments', 'tags')


class MapImportForm(ScopedImportForm, NetBoxModelImportForm):
    parent = CSVModelChoiceField(
        queryset=Map.objects.all(), to_field_name='name', required=False, label=_('Parent'),
        help_text=_('Name of the parent map'),
    )
    base_layer = CSVChoiceField(choices=BaseLayerChoices, required=False, label=_('Base layer'))

    class Meta:
        model = Map
        fields = ('name', 'parent', 'base_layer', 'scope_type', 'scope_id', 'description', 'comments', 'tags')


class MapBulkEditForm(NetBoxModelBulkEditForm):
    parent = DynamicModelChoiceField(queryset=Map.objects.all(), required=False, label=_('Parent'))
    base_layer = forms.ChoiceField(choices=add_blank_choice(BaseLayerChoices), required=False, label=_('Base layer'))
    description = forms.CharField(max_length=200, required=False, label=_('Description'))
    comments = CommentField()

    model = Map
    fieldsets = (FieldSet('parent', 'base_layer', 'description'),)
    nullable_fields = ('parent', 'description', 'comments')


class MapFilterForm(NetBoxModelFilterSetForm):
    model = Map
    parent_id = DynamicModelMultipleChoiceField(queryset=Map.objects.all(), required=False, label=_('Parent'))
    base_layer = forms.MultipleChoiceField(choices=BaseLayerChoices, required=False, label=_('Base layer'))
    tag = TagFilterField(model)

    fieldsets = (
        FieldSet('q', 'filter_id', 'tag'),
        FieldSet('parent_id', 'base_layer', name=_('Map')),
    )


#
# Parts of a map. The add pages take ?map=<id> to start on that map.
#

class MapOverlayForm(forms.ModelForm):
    map = DynamicModelChoiceField(queryset=Map.objects.all(), label=_('Map'))

    fieldsets = (
        FieldSet('map', 'name', 'image', 'opacity', 'weight', name=_('Overlay')),
        FieldSet('x_min', 'y_min', 'x_max', 'y_max', name=_('Corners (empty: place it on the map later)')),
    )

    class Meta:
        model = MapOverlay
        fields = ('map', 'name', 'image', 'opacity', 'weight', 'x_min', 'y_min', 'x_max', 'y_max')
        widgets = {'image': forms.ClearableFileInput(attrs={'accept': images.ACCEPT})}


class MapMarkerForm(GenericObjectFormMixin, forms.ModelForm):
    map = DynamicModelChoiceField(queryset=Map.objects.all(), label=_('Map'))
    object = GenericObjectChoiceField(
        label=_('Object'), content_type_queryset=marker_types(), required=False, selector=True,
        hx_target_id='marker-object',
        help_text=_('A device, rack, site, another map, ... Leave empty for a text label.'),
    )
    color = ColorField(required=False, label=_('Color'))

    fieldsets = (
        FieldSet('map', name=_('Map')),
        FieldSet('object', name=_('Object'), html_id='marker-object'),
        FieldSet('label', 'icon', 'color', name=_('Look')),
        FieldSet('x', 'y', name=_('Position (empty: place it on the map later)')),
    )

    class Meta:
        model = MapMarker
        fields = ('map', 'label', 'icon', 'color', 'x', 'y')


class MapShapeForm(forms.ModelForm):
    map = DynamicModelChoiceField(queryset=Map.objects.all(), label=_('Map'))
    color = ColorField(label=_('Color'))

    fieldsets = (
        FieldSet('map', 'kind', 'label', 'color', name=_('Shape')),
        FieldSet('points', 'radius', name=_('Geometry')),
    )

    class Meta:
        model = MapShape
        fields = ('map', 'kind', 'label', 'color', 'points', 'radius')
        help_texts = {
            'points': _('A list of [x, y] pairs, such as [[10, 20], [30, 40]]. A circle has one, its center.'),
            'radius': _('Circles only: meters on a world map, pixels on an image-only map.'),
        }


class MapPartFilterForm(NetBoxModelFilterSetForm):
    """Shared filters of the overlay, marker and shape lists."""
    map_id = DynamicModelMultipleChoiceField(queryset=Map.objects.all(), required=False, label=_('Map'))

    fieldsets = (FieldSet('q', 'map_id'),)


class MapOverlayFilterForm(MapPartFilterForm):
    model = MapOverlay


class MapMarkerFilterForm(MapPartFilterForm):
    model = MapMarker


class MapShapeFilterForm(MapPartFilterForm):
    model = MapShape
    kind = forms.MultipleChoiceField(choices=ShapeKindChoices, required=False, label=_('Kind'))

    fieldsets = (FieldSet('q', 'map_id', 'kind'),)
