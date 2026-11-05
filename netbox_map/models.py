"""
Maps and what is on them.

Map is a NetBoxModel: change log, tags, custom fields, journal, REST API and
Event Rules come with that. MapOverlay (an image laid over the map),
MapMarker (a NetBox object or a text label at a point) and MapShape (a line,
area or circle drawn on the map) are change-logged parts of a map, their
entries shown under the map.

Positions are plain x/y numbers. On a world map x is the longitude and y
the latitude, in degrees. On an image-only map they are pixels of the
background image, measured from its bottom-left corner (Leaflet's "simple"
coordinates).

The plugin never changes NetBox's own tables. Objects on a map are referred
to by type and ID (a generic relation), so removing the plugin leaves NetBox
as it was; see signals.py for what happens when such an object is deleted.
"""
import os

from django.contrib.contenttypes.fields import GenericForeignKey
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.urls import reverse
from django.utils.translation import gettext_lazy as _

from dcim.constants import LOCATION_SCOPE_TYPES
from netbox.models import ChangeLoggedModel, NetBoxModel
from utilities.fields import ColorField

from . import images
from .choices import BaseLayerChoices, ShapeKindChoices

# Models a map can be assigned to. Its page then shows the map.
MAP_SCOPE_TYPES = LOCATION_SCOPE_TYPES  # region, site group, site, location


def overlay_upload_to(instance, filename):
    """Overlay images go to MEDIA_ROOT/netbox-map/, under the map's ID."""
    return f'netbox-map/{instance.map_id}/{os.path.basename(filename)}'


class Map(NetBoxModel):
    """
    One map: a world map or a plain background, with overlays, shapes and
    markers on it. A map can sit under another map (a submap), and can be
    assigned to a region, site group, site or location.
    """
    name = models.CharField(verbose_name=_('name'), max_length=100, unique=True)
    parent = models.ForeignKey(
        to='self', verbose_name=_('parent'), on_delete=models.SET_NULL, related_name='children',
        blank=True, null=True,
        help_text=_('The map this one is part of, such as the building of a floor plan.'),
    )
    base_layer = models.CharField(
        verbose_name=_('base layer'), max_length=20, choices=BaseLayerChoices, default=BaseLayerChoices.WORLD,
        help_text=_('World map: overlays sit on a real map. Image only: the first overlay is the whole map.'),
    )
    scope_type = models.ForeignKey(
        to='contenttypes.ContentType', on_delete=models.PROTECT, related_name='+',
        limit_choices_to={'model__in': MAP_SCOPE_TYPES}, blank=True, null=True,
    )
    scope_id = models.PositiveBigIntegerField(blank=True, null=True)
    scope = GenericForeignKey(ct_field='scope_type', fk_field='scope_id')
    description = models.CharField(verbose_name=_('description'), max_length=200, blank=True)
    comments = models.TextField(verbose_name=_('comments'), blank=True)

    clone_fields = ('parent', 'base_layer', 'scope_type', 'scope_id')

    class Meta:
        ordering = ('name',)
        indexes = (models.Index(fields=('scope_type', 'scope_id')),)
        verbose_name = _('map')
        verbose_name_plural = _('maps')

    def __str__(self):
        return self.name

    def get_absolute_url(self):
        return reverse('plugins:netbox_map:map', args=[self.pk])

    def clean(self):
        super().clean()
        # A map can't be its own ancestor.
        ancestor = self.parent
        while ancestor is not None:
            if self.pk and ancestor.pk == self.pk:
                raise ValidationError({'parent': _('A map cannot be placed under itself or one of its submaps.')})
            ancestor = ancestor.parent
        if self.scope_type_id and self.scope_type.model not in MAP_SCOPE_TYPES:
            raise ValidationError({'scope': _('A map can be assigned to a region, site group, site or location.')})
        if bool(self.scope_type_id) != bool(self.scope_id):
            raise ValidationError({'scope': _('Choose both the type and the object, or neither.')})


class MapOverlay(ChangeLoggedModel):
    """
    An image laid over a map, such as a floor plan over a world map, with
    its own opacity. On an image-only map the first overlay (lowest weight)
    is the background.

    The corners are left empty until the overlay is placed. An unplaced
    overlay is drawn at its own pixel size on an image-only map, and over the
    current view on a world map.
    """
    map = models.ForeignKey(to=Map, verbose_name=_('map'), on_delete=models.CASCADE, related_name='overlays')
    name = models.CharField(verbose_name=_('name'), max_length=100)
    image = models.FileField(
        verbose_name=_('image'), upload_to=overlay_upload_to, max_length=255, validators=[images.validate_image],
        help_text=_('PNG, JPEG, GIF, WebP or SVG.'),
    )
    image_width = models.PositiveIntegerField(verbose_name=_('image width'), editable=False, default=0)
    image_height = models.PositiveIntegerField(verbose_name=_('image height'), editable=False, default=0)
    opacity = models.PositiveSmallIntegerField(
        verbose_name=_('opacity'), default=100, validators=[MinValueValidator(0), MaxValueValidator(100)],
        help_text=_('Percent. 100 is solid, lower lets the map below show through.'),
    )
    weight = models.PositiveSmallIntegerField(
        verbose_name=_('weight'), default=100,
        help_text=_('Overlays with a higher weight are drawn on top.'),
    )
    # Bottom-left and top-right corners. See the module notes for units.
    x_min = models.FloatField(verbose_name=_('left'), blank=True, null=True)
    y_min = models.FloatField(verbose_name=_('bottom'), blank=True, null=True)
    x_max = models.FloatField(verbose_name=_('right'), blank=True, null=True)
    y_max = models.FloatField(verbose_name=_('top'), blank=True, null=True)

    class Meta:
        ordering = ('map', 'weight', 'name')
        constraints = (
            models.UniqueConstraint(fields=('map', 'name'), name='netbox_map_overlay_unique_name'),
        )
        verbose_name = _('overlay')
        verbose_name_plural = _('overlays')

    def __str__(self):
        return self.name

    def get_absolute_url(self):
        return self.map.get_absolute_url()

    @property
    def is_placed(self):
        return None not in (self.x_min, self.y_min, self.x_max, self.y_max)

    def clean(self):
        super().clean()
        corners = (self.x_min, self.y_min, self.x_max, self.y_max)
        if any(value is not None for value in corners) and None in corners:
            raise ValidationError(_('Give all four corners, or none to place the overlay later.'))
        if self.is_placed and (self.x_min >= self.x_max or self.y_min >= self.y_max):
            raise ValidationError(_('Left must be less than right, and bottom less than top.'))

    def save(self, *args, **kwargs):
        # Remember the pixel size whenever a new file comes in.
        if self.image and not getattr(self.image, '_committed', True):
            self.image_width, self.image_height = images.image_size(self.image.file)
        super().save(*args, **kwargs)


class MapMarker(ChangeLoggedModel):
    """
    A point on a map: a NetBox object (device, rack, site, location, another
    map, ...) or, with no object, a text label. A marker for another map
    opens that map when clicked. Each object is on a map at most once, but
    may be on any number of maps.
    """
    map = models.ForeignKey(to=Map, verbose_name=_('map'), on_delete=models.CASCADE, related_name='markers')
    object_type = models.ForeignKey(
        to='contenttypes.ContentType', on_delete=models.CASCADE, related_name='+', blank=True, null=True,
    )
    object_id = models.PositiveBigIntegerField(blank=True, null=True)
    object = GenericForeignKey(ct_field='object_type', fk_field='object_id')
    label = models.CharField(
        verbose_name=_('label'), max_length=100, blank=True,
        help_text=_("Shown instead of the object's name. Required for a marker with no object."),
    )
    icon = models.CharField(
        verbose_name=_('icon'), max_length=50, blank=True,
        help_text=_('A Material Design Icons name without the "mdi-" prefix, such as "router" or "server".'),
    )
    color = ColorField(
        verbose_name=_('color'), blank=True,
        help_text=_("Empty: the object's status color."),
    )
    # Empty until the marker is placed on the map.
    x = models.FloatField(verbose_name=_('x'), blank=True, null=True)
    y = models.FloatField(verbose_name=_('y'), blank=True, null=True)

    class Meta:
        ordering = ('map', 'label', 'pk')
        indexes = (models.Index(fields=('object_type', 'object_id')),)
        constraints = (
            models.UniqueConstraint(
                fields=('map', 'object_type', 'object_id'), name='netbox_map_marker_unique_object',
                violation_error_message=_('This object is already on the map.'),
            ),
        )
        verbose_name = _('marker')
        verbose_name_plural = _('markers')

    def __str__(self):
        if self.label:
            return self.label
        return str(self.object) if self.object is not None else _('Marker {id}').format(id=self.pk)

    def get_absolute_url(self):
        return self.map.get_absolute_url()

    @property
    def is_placed(self):
        return self.x is not None and self.y is not None

    @property
    def is_map_link(self):
        return isinstance(self.object, Map)

    def clean(self):
        super().clean()
        if bool(self.object_type_id) != bool(self.object_id):
            raise ValidationError({'object': _('Choose both the type and the object, or neither.')})
        if self.object_type_id:
            model = self.object_type.model_class()
            if model is None or not model.objects.filter(pk=self.object_id).exists():
                raise ValidationError({'object': _('No such object.')})
            if model is Map and self.object_id == self.map_id:
                raise ValidationError({'object': _('A map cannot link to itself.')})
        elif not self.label:
            raise ValidationError({'label': _('A marker with no object needs a label.')})
        if (self.x is None) != (self.y is None):
            raise ValidationError(_('Give both x and y, or neither to place the marker later.'))


class MapShape(ChangeLoggedModel):
    """
    A line, area or circle drawn on a map, such as a room outline or a cable
    route. Lines and areas are a list of [x, y] points; a circle is one
    point (its center) and a radius, in meters on a world map and pixels on
    an image-only map.
    """
    map = models.ForeignKey(to=Map, verbose_name=_('map'), on_delete=models.CASCADE, related_name='shapes')
    kind = models.CharField(verbose_name=_('kind'), max_length=20, choices=ShapeKindChoices)
    label = models.CharField(verbose_name=_('label'), max_length=100, blank=True)
    color = ColorField(verbose_name=_('color'), default='2196f3')
    points = models.JSONField(verbose_name=_('points'), default=list, help_text=_('A list of [x, y] pairs.'))
    radius = models.FloatField(verbose_name=_('radius'), blank=True, null=True)

    class Meta:
        ordering = ('map', 'label', 'pk')
        verbose_name = _('shape')
        verbose_name_plural = _('shapes')

    def __str__(self):
        return self.label or _('{kind} {id}').format(kind=self.get_kind_display(), id=self.pk)

    def get_absolute_url(self):
        return self.map.get_absolute_url()

    def clean(self):
        super().clean()
        points = self.points
        if not isinstance(points, list) or not all(
            isinstance(point, (list, tuple)) and len(point) == 2
            and all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in point)
            for point in points
        ):
            raise ValidationError({'points': _('Points must be a list of [x, y] number pairs.')})
        least = {ShapeKindChoices.LINE: 2, ShapeKindChoices.AREA: 3, ShapeKindChoices.CIRCLE: 1}.get(self.kind, 1)
        if len(points) < least:
            raise ValidationError({'points': _('A {kind} needs at least {count} points.').format(
                kind=self.get_kind_display().lower(), count=least,
            )})
        if self.kind == ShapeKindChoices.CIRCLE:
            if len(points) != 1:
                raise ValidationError({'points': _('A circle has one point, its center.')})
            if not self.radius or self.radius <= 0:
                raise ValidationError({'radius': _('A circle needs a radius above zero.')})
        elif self.radius is not None:
            raise ValidationError({'radius': _('Only circles have a radius.')})
