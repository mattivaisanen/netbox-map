"""
Keeps maps tidy when things they point at go away.

Markers and map scopes refer to NetBox objects by type and ID, so the
database doesn't remove them by itself. When such an object is deleted:

- its markers are deleted from every map (change-logged);
- lines drawn as its route stay, as plain lines;
- a map assigned to it stays, with no assignment.

Overlay image files are deleted from storage with their overlay, and when
a new file replaces them.
"""
from django.contrib.contenttypes.models import ContentType
from django.db import transaction
from django.db.models.signals import post_delete, pre_save
from django.dispatch import receiver

from .models import MAP_SCOPE_TYPES, Map, MapMarker, MapOverlay, MapShape

# Deleting these never concerns a map: NetBox bookkeeping and the map's own
# parts. Skipping them saves a query per deleted row (change log entries,
# sessions, ...).
SKIPPED_APPS = ('admin', 'auth', 'contenttypes', 'core', 'django_rq', 'sessions', 'social_django', 'taggit')
SKIPPED_MODELS = (MapMarker, MapOverlay, MapShape)


@receiver(post_delete)
def object_deleted(sender, instance, **kwargs):
    if sender._meta.app_label in SKIPPED_APPS or sender in SKIPPED_MODELS or instance.pk is None:
        return
    content_type = ContentType.objects.get_for_model(sender)
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


@receiver(post_delete, sender=MapOverlay)
def overlay_deleted(sender, instance, **kwargs):
    if instance.image:
        _remove_file(instance.image.name, instance.image.storage)


@receiver(pre_save, sender=MapOverlay)
def overlay_replaced(sender, instance, raw=False, **kwargs):
    if raw or not instance.pk:
        return
    old = MapOverlay.objects.filter(pk=instance.pk).values_list('image', flat=True).first()
    if old and old != instance.image.name:
        _remove_file(old, instance.image.storage)
