"""
Keeps maps tidy when things they point at go away.

Markers and map scopes refer to NetBox objects by type and ID, so the
database doesn't remove them by itself. When such an object is deleted:

- its markers are deleted from every map (change-logged);
- lines drawn as its route stay, as plain lines;
- a map assigned to it stays, with no assignment.

Overlay image files are deleted from storage with their overlay, and when
a new file replaces them.

A line attached to a marker or junction follows it when it moves.
"""
from django.contrib.contenttypes.models import ContentType
from django.core.cache import cache
from django.db import transaction
from django.db.models import Q
from django.db.models.signals import post_delete, post_save, pre_save

from .choices import ShapeKindChoices
from .models import MAP_SCOPE_TYPES, Map, MapMarker, MapOverlay, MapShape

# Deleting these never concerns a map: NetBox bookkeeping and the map's own
# parts.
SKIPPED_APPS = ('admin', 'auth', 'contenttypes', 'core', 'django_rq', 'sessions', 'social_django', 'taggit')
SKIPPED_MODELS = (MapMarker, MapOverlay, MapShape)

# The object types that are on some map (as a marker, a route or a map's
# assignment), kept in NetBox's cache (shared by all workers). A delete of
# any other type then costs no query. A save that brings in a type not yet
# in the set drops it, and the next delete rebuilds it. Deletes don't drop
# it: a type that is no longer on a map only costs the lookups below. The
# set also expires after a few minutes, in case markers were written past
# Django's signals (bulk_create, a restored database).
REFERENCED_TYPES_KEY = 'netbox_map:referenced_types'
REFERENCED_TYPES_TIMEOUT = 300


def referenced_types():
    types = cache.get(REFERENCED_TYPES_KEY)
    if types is None:
        types = set(MapMarker.objects.filter(object_type__isnull=False).values_list('object_type', flat=True))
        types |= set(MapShape.objects.filter(object_type__isnull=False).values_list('object_type', flat=True))
        types |= set(Map.objects.filter(scope_type__isnull=False).values_list('scope_type', flat=True))
        cache.set(REFERENCED_TYPES_KEY, types, REFERENCED_TYPES_TIMEOUT)
    return types


def type_saved(sender, instance, **kwargs):
    """Drops the cached set when a marker, route or map brings in a new type."""
    type_id = instance.scope_type_id if sender is Map else instance.object_type_id
    types = cache.get(REFERENCED_TYPES_KEY)
    if type_id is not None and types is not None and type_id not in types:
        cache.delete(REFERENCED_TYPES_KEY)


def object_deleted(sender, instance, **kwargs):
    """
    Watches every model: any NetBox object can be on a map, plugins' too.
    get_for_model() is answered from ContentType's own cache, so for an
    object type that is on no map this needs no query.
    """
    if sender._meta.app_label in SKIPPED_APPS or sender in SKIPPED_MODELS or instance.pk is None:
        return
    content_type = ContentType.objects.get_for_model(sender)
    if content_type.pk not in referenced_types():
        return
    for marker in MapMarker.objects.filter(object_type=content_type, object_id=instance.pk):
        marker.delete()
    for shape in MapShape.objects.filter(object_type=content_type, object_id=instance.pk):
        shape.snapshot()
        shape.object_type, shape.object_id = None, None
        shape.save()
    if sender._meta.app_label == 'dcim' and sender._meta.model_name in MAP_SCOPE_TYPES:
        for map_ in Map.objects.filter(scope_type=content_type, scope_id=instance.pk):
            map_.snapshot()
            map_.scope_type, map_.scope_id = None, None
            map_.save()


def _remove_file(name, storage):
    # After the commit, so a rolled-back delete keeps its image.
    transaction.on_commit(lambda: storage.delete(name))


def overlay_deleted(sender, instance, **kwargs):
    if instance.image:
        _remove_file(instance.image.name, instance.image.storage)


def overlay_replaced(sender, instance, raw=False, **kwargs):
    if raw or not instance.pk:
        return
    old = MapOverlay.objects.filter(pk=instance.pk).values_list('image', flat=True).first()
    if old and old != instance.image.name:
        _remove_file(old, instance.image.storage)


def _follow(map_id, kind, pk, position):
    """
    Moves the points of lines attached to a marker or junction (`kind` is
    'marker' or 'shape') to its new position: the start, the end and any
    point the line runs through.
    """
    lines = MapShape.objects.filter(map_id=map_id, kind=ShapeKindChoices.LINE).filter(
        Q(**{f'ends__start__{kind}': pk}) | Q(**{f'ends__end__{kind}': pk})
        | Q(ends__via__contains=[{kind: pk}])
    )
    for line in lines:
        points = [list(point) for point in line.points]
        if not points:
            continue
        indexes = [index for end, index in (('start', 0), ('end', len(points) - 1))
                   if (line.ends.get(end) or {}).get(kind) == pk]
        indexes += [via['point'] for via in line.ends.get('via') or []
                    if via.get(kind) == pk and 0 <= via['point'] < len(points)]
        changed = False
        for index in indexes:
            if points[index] != position:
                points[index] = list(position)
                changed = True
        if changed:
            line.snapshot()
            line.points = points
            line.save()


def marker_moved(sender, instance, raw=False, **kwargs):
    """Lines attached to a marker follow it."""
    if raw or instance.x is None or instance.y is None:
        return
    _follow(instance.map_id, 'marker', instance.pk, [instance.x, instance.y])


def junction_moved(sender, instance, raw=False, **kwargs):
    """Lines running through a junction follow it."""
    if raw or instance.kind != ShapeKindChoices.JUNCTION or len(instance.points or []) != 1:
        return
    _follow(instance.map_id, 'shape', instance.pk, list(instance.points[0]))


def connect():
    """Connects the receivers above; called once from the plugin's ready()."""
    post_delete.connect(object_deleted, dispatch_uid='netbox_map:object_deleted')
    for model in (Map, MapMarker, MapShape):
        post_save.connect(type_saved, sender=model, dispatch_uid=f'netbox_map:type_saved:{model._meta.model_name}')
    post_delete.connect(overlay_deleted, sender=MapOverlay, dispatch_uid='netbox_map:overlay_deleted')
    pre_save.connect(overlay_replaced, sender=MapOverlay, dispatch_uid='netbox_map:overlay_replaced')
    post_save.connect(marker_moved, sender=MapMarker, dispatch_uid='netbox_map:marker_moved')
    post_save.connect(junction_moved, sender=MapShape, dispatch_uid='netbox_map:junction_moved')
