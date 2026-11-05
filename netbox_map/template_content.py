"""
What the plugin adds to other NetBox pages:

- **Show on map** on the page of any object that is on a map, opening the
  map zoomed in on it. An object that is not on a map itself is found
  through what contains it: a device through its rack, location or site.
- On a region, site group, site or location page: the maps assigned to it.
- On a rack page: the maps the rack is on, with the rack highlighted.
"""
from django.contrib.contenttypes.models import ContentType
from django.utils.http import urlencode
from django.utils.translation import gettext as _

from netbox.plugins import PluginTemplateExtension

from . import viewer
from .models import MAP_SCOPE_TYPES, Map, MapMarker

# Where to look, in order, for an object that isn't on a map itself.
CONTAINERS = ('rack', 'location', 'site')


def _markers_for(obj, user):
    """Placed markers of `obj` on maps the user can see."""
    return (
        MapMarker.objects.restrict(user, 'view')
        .filter(object_type=ContentType.objects.get_for_model(obj), object_id=obj.pk, x__isnull=False)
        .filter(map__in=Map.objects.restrict(user, 'view'))
        .select_related('map')
    )


def map_links(obj, user):
    """
    [{'url', 'text'}] for each map `obj` is on. Falls back to the first of
    its rack, location or site that is on a map.
    """
    markers, via = list(_markers_for(obj, user)), None
    for attribute in CONTAINERS:
        if markers:
            break
        container = getattr(obj, attribute, None)
        if container is not None and hasattr(container, 'pk'):
            markers, via = list(_markers_for(container, user)), container
    links = []
    for marker in markers:
        text = marker.map.name if via is None else _('{map} (at {place})').format(map=marker.map.name, place=via)
        links.append({'url': f"{marker.map.get_absolute_url()}?{urlencode({'marker': marker.pk})}", 'text': text})
    return links


def _embed(map_, request, marker=None):
    """A small read-only map for the embed template."""
    open_url = map_.get_absolute_url() + (f"?{urlencode({'marker': marker.pk})}" if marker else '')
    return {
        'map': map_,
        'data': viewer.map_data(map_, request, highlight=marker.pk if marker else None),
        'data_id': f'nbm-embed-data-{map_.pk}',
        'open_url': open_url,
    }


class ShowOnMap(PluginTemplateExtension):
    """The Show on map button, on any object's page."""
    models = None

    def buttons(self):
        obj = self.context.get('object')
        request = self.context['request']
        if obj is None or not getattr(obj, 'pk', None) or obj._meta.app_label == 'netbox_map':
            return ''
        if not request.user.has_perm('netbox_map.view_map'):
            return ''
        links = map_links(obj, request.user)
        if not links:
            return ''
        return self.render('netbox_map/inc/show_on_map.html', extra_context={'links': links})


class AssignedMaps(PluginTemplateExtension):
    """The maps assigned to a region, site group, site or location, on its page."""
    models = [f'dcim.{model}' for model in MAP_SCOPE_TYPES]

    def full_width_page(self):
        obj = self.context['object']
        request = self.context['request']
        if not request.user.has_perm('netbox_map.view_map'):
            return ''
        maps = Map.objects.restrict(request.user, 'view').filter(
            scope_type=ContentType.objects.get_for_model(obj), scope_id=obj.pk,
        )
        embeds = [_embed(map_, request) for map_ in maps]
        if not embeds:
            return ''
        return self.render('netbox_map/inc/map_embed.html', extra_context={'embeds': embeds})


class RackMaps(PluginTemplateExtension):
    """The maps a rack is on, with the rack highlighted, on the rack's page."""
    models = ['dcim.rack']

    def right_page(self):
        obj = self.context['object']
        request = self.context['request']
        if not request.user.has_perm('netbox_map.view_map'):
            return ''
        embeds = [_embed(marker.map, request, marker) for marker in _markers_for(obj, request.user)]
        if not embeds:
            return ''
        return self.render('netbox_map/inc/map_embed.html', extra_context={'embeds': embeds})


template_extensions = [ShowOnMap, AssignedMaps, RackMaps]
