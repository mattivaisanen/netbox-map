"""
What the browser needs to draw a map: the map's settings, its overlays,
markers and shapes, the user's rights, and the REST API addresses the
editor saves to. Built here, handed to the page as JSON and drawn by
assets/map.js.

Positions go to the browser as stored (x, y). map.js turns them into
Leaflet's [y, x] order.
"""
from django.middleware.csrf import get_token
from django.urls import reverse
from django.utils.http import urlencode

from netbox.plugins import get_plugin_config

from .choices import BaseLayerChoices
from .models import MapMarker

PLUGIN = 'netbox_map'

# Icons used when a marker has none of its own.
DEFAULT_ICONS = {
    'dcim.device': 'server',
    'dcim.rack': 'server-network',
    'dcim.site': 'domain',
    'dcim.location': 'floor-plan',
    'dcim.region': 'earth',
    'dcim.powerpanel': 'flash',
    'circuits.circuit': 'transit-connection-variant',
    'netbox_map.map': 'map-marker-path',
}
LABEL_ICON = 'label-outline'
OBJECT_ICON = 'map-marker'


def tile_settings():
    return {
        'url': get_plugin_config(PLUGIN, 'tile_url'),
        'attribution': get_plugin_config(PLUGIN, 'tile_attribution'),
        'max_zoom': get_plugin_config(PLUGIN, 'max_zoom'),
        'geocoder_url': get_plugin_config(PLUGIN, 'geocoder_url'),
    }


def _marker(marker, user):
    """One marker for the browser, or None when the user may not see its object."""
    obj = marker.object
    if marker.object_type_id:
        if obj is None:
            return None
        model = type(obj)
        if hasattr(model.objects, 'restrict') and not model.objects.restrict(user, 'view').filter(pk=obj.pk).exists():
            return None
    type_label = f'{marker.object_type.app_label}.{marker.object_type.model}' if marker.object_type_id else ''
    status_color = obj.get_status_color() if obj is not None and hasattr(obj, 'get_status_color') else None
    return {
        'id': marker.pk,
        # 'app.model:id', so the editor can tell which objects are already on the map.
        'object': f'{type_label}:{marker.object_id}' if marker.object_type_id else None,
        'x': marker.x,
        'y': marker.y,
        'label': str(marker),
        'type': str(marker.object_type.name).title() if marker.object_type_id else '',
        'url': obj.get_absolute_url() if obj is not None and hasattr(obj, 'get_absolute_url') else None,
        'map_link': marker.is_map_link,
        # Racks are drawn as squares, everything else as round pins.
        'square': type_label == 'dcim.rack',
        'icon': marker.icon or DEFAULT_ICONS.get(type_label, OBJECT_ICON if obj is not None else LABEL_ICON),
        'color': f'#{marker.color}' if marker.color else None,
        'status': status_color or ('secondary' if obj is not None else None),
        'edit_url': reverse('plugins:netbox_map:mapmarker_edit', args=[marker.pk]),
    }


def _overlay(overlay):
    return {
        'id': overlay.pk,
        'name': overlay.name,
        'url': overlay.image.url,
        'opacity': overlay.opacity,
        'weight': overlay.weight,
        'width': overlay.image_width,
        'height': overlay.image_height,
        'bounds': [[overlay.y_min, overlay.x_min], [overlay.y_max, overlay.x_max]] if overlay.is_placed else None,
        'edit_url': reverse('plugins:netbox_map:mapoverlay_edit', args=[overlay.pk]),
    }


def _shape(shape):
    return {
        'id': shape.pk,
        'kind': shape.kind,
        'label': shape.label,
        'color': f'#{shape.color}',
        'points': shape.points,
        'radius': shape.radius,
        'link_url': shape.link.get_absolute_url() if shape.link_id else None,
        'link_name': shape.link.name if shape.link_id else None,
        'edit_url': reverse('plugins:netbox_map:mapshape_edit', args=[shape.pk]),
    }


# What the editor's right-click menu can add, and the REST API it searches.
SEARCHABLE = {
    'device': ('dcim.device', 'dcim-api:device-list', 'dcim.view_device'),
    'rack': ('dcim.rack', 'dcim-api:rack-list', 'dcim.view_rack'),
    'map': ('netbox_map.map', 'plugins-api:netbox_map-api:map-list', 'netbox_map.view_map'),
}

# The REST API filter for objects inside a map's region, site group, site or location.
SCOPE_FILTERS = {'region': 'region_id', 'sitegroup': 'site_group_id', 'site': 'site_id', 'location': 'location_id'}


def marker_data(marker, user):
    """One marker as map.js draws it (used by the editor after adding one)."""
    return _marker(marker, user)


def _search_sources(map_, user):
    """
    Where the right-click menu looks for devices, racks and maps. Devices and
    racks are limited to the map's region, site group, site or location
    when it has one.
    """
    sources = {}
    scope_filter = ''
    if map_.scope_type_id and map_.scope_type.model in SCOPE_FILTERS:
        scope_filter = urlencode({SCOPE_FILTERS[map_.scope_type.model]: map_.scope_id})
    for kind, (object_type, viewname, permission) in SEARCHABLE.items():
        if not user.has_perm(permission):
            continue
        url = reverse(viewname)
        if scope_filter and kind != 'map':
            url += f'?{scope_filter}'
        sources[kind] = {'type': object_type, 'url': url}
    return sources


def map_data(map_, request, highlight=None):
    """Everything assets/map.js needs to draw `map_` for this request's user."""
    user = request.user
    markers = MapMarker.objects.restrict(user, 'view').filter(map=map_).select_related('object_type')
    markers = [data for data in (_marker(marker, user) for marker in markers.prefetch_related('object')) if data]
    return_url = map_.get_absolute_url()
    return {
        'id': map_.pk,
        'name': map_.name,
        'url': map_.get_absolute_url(),
        'image_only': map_.base_layer == BaseLayerChoices.IMAGE,
        'tiles': tile_settings(),
        'overlays': [_overlay(overlay) for overlay in map_.overlays.restrict(user, 'view')],
        'markers': markers,
        'shapes': [_shape(shape) for shape in map_.shapes.restrict(user, 'view').select_related('link')],
        'default_view': (
            {'x': map_.default_x, 'y': map_.default_y, 'zoom': map_.default_zoom} if map_.has_default_view else None
        ),
        'rotation': map_.rotation,
        'highlight': highlight,
        # The editor's rights and addresses.
        'can': {
            name: user.has_perm(f'netbox_map.{action}_{model}')
            for name, action, model in (
                ('add_marker', 'add', 'mapmarker'), ('change_marker', 'change', 'mapmarker'),
                ('add_shape', 'add', 'mapshape'), ('change_shape', 'change', 'mapshape'),
                ('delete_shape', 'delete', 'mapshape'), ('add_overlay', 'add', 'mapoverlay'),
                ('change_overlay', 'change', 'mapoverlay'), ('change_map', 'change', 'map'),
            )
        },
        'api': {
            'markers': reverse('plugins-api:netbox_map-api:mapmarker-list'),
            'shapes': reverse('plugins-api:netbox_map-api:mapshape-list'),
            'overlays': reverse('plugins-api:netbox_map-api:mapoverlay-list'),
            'map': reverse('plugins-api:netbox_map-api:map-detail', args=[map_.pk]),
        },
        'add_marker_url': reverse('plugins:netbox_map:mapmarker_add') + '?' + urlencode(
            {'map': map_.pk, 'return_url': return_url}
        ),
        'return_url': return_url,
        'search': _search_sources(map_, user),
        # The address of one marker's data; map.js puts the marker's ID in place of the 0.
        'marker_data_url': reverse('plugins:netbox_map:marker_data', args=[0]),
        # The card shown when the mouse rests on a marker, addressed the same way.
        'marker_card_url': reverse('plugins:netbox_map:marker_card', args=[0]),
        # NetBox's CSRF cookie is HttpOnly, so the editor gets the token here.
        'csrf_token': get_token(request),
    }
