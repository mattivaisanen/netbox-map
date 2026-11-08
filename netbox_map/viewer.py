"""
What the browser needs to draw a map: the map's settings, its overlays,
markers and shapes, the user's rights, and the REST API addresses the
editor saves to. Built here, handed to the page as JSON and drawn by
assets/map.js.

Positions go to the browser as stored (x, y). map.js turns them into
Leaflet's [y, x] order.
"""
from collections import defaultdict

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


# The kinds `default_colors` can name (see __init__.py).
COLOR_KINDS = ('device', 'rack', 'object', 'cable', 'line', 'area', 'circle', 'junction')


def default_colors():
    """The `default_colors` setting as {kind: '#rrggbb'}, skipping anything that isn't a color."""
    colors = {}
    for kind, value in (get_plugin_config(PLUGIN, 'default_colors') or {}).items():
        value = str(value).strip().lstrip('#').lower()
        if kind in COLOR_KINDS and len(value) == 6 and all(c in '0123456789abcdef' for c in value):
            colors[kind] = f'#{value}'
    return colors


def tile_settings():
    return {
        # Each with at least a name and a tile `url` or a vector `style`; see __init__.py.
        'layers': [
            {'max_zoom': 19, 'attribution': '', **layer}
            for layer in get_plugin_config(PLUGIN, 'base_layers') or [] if layer.get('url') or layer.get('style')
        ],
        'geocoder_url': get_plugin_config(PLUGIN, 'geocoder_url'),
    }


def visible_objects(objects, user):
    """
    The objects among `objects` the user may see, as a set of (model, pk).
    One query per kind of object, however many there are.
    """
    by_model = defaultdict(set)
    for obj in objects:
        if obj is not None:
            by_model[type(obj)].add(obj.pk)
    visible = set()
    for model, pks in by_model.items():
        if hasattr(model.objects, 'restrict'):
            pks = model.objects.restrict(user, 'view').filter(pk__in=pks).order_by().values_list('pk', flat=True)
        visible.update((model, pk) for pk in pks)
    return visible


def _sees(obj, user, visible):
    """Whether the user may see `obj`; `visible` is from visible_objects(), or None to ask now."""
    if obj is None:
        return False
    if visible is None:
        visible = visible_objects([obj], user)
    return (type(obj), obj.pk) in visible


def _marker(marker, user, visible=None):
    """One marker for the browser, or None when the user may not see its object."""
    obj = marker.object
    if marker.object_type_id and not _sees(obj, user, visible):
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
        'label_offset': marker.label_offset,
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


def route_object(shape, user, visible=None):
    """The cable, cable bundle or circuit `shape` is the route of, if the user may see it."""
    obj = shape.object if shape.object_type_id else None
    return obj if _sees(obj, user, visible) else None


def _shape(shape, user, visible=None):
    route = route_object(shape, user, visible)
    return {
        'id': shape.pk,
        'kind': shape.kind,
        'label': shape.label,
        'color': f'#{shape.color}',
        'points': shape.points,
        'radius': shape.radius,
        'level': shape.level,
        'ends': shape.ends or {},
        'smooth': shape.smooth or [],
        'label_position': shape.label_position,
        'link_url': shape.link.get_absolute_url() if shape.link_id else None,
        'link_name': shape.link.name if shape.link_id else None,
        # The route's object: 'app.model:id', its kind and name, and its status
        # color for drawing the line when the cable has no color of its own.
        'object': f'{shape.object_type.app_label}.{shape.object_type.model}:{shape.object_id}' if route else None,
        'route_type': str(shape.object_type.name).title() if route else None,
        'route_name': str(route) if route else None,
        'route_url': route.get_absolute_url() if route else None,
        'route_color': f'#{route.color}' if getattr(route, 'color', '') else None,
        'status': route.get_status_color() if route is not None and hasattr(route, 'get_status_color') else None,
        'edit_url': reverse('plugins:netbox_map:mapshape_edit', args=[shape.pk]),
    }


# What the editor's right-click menu can add, and the REST API it searches.
SEARCHABLE = {
    'device': ('dcim.device', 'dcim-api:device-list', 'dcim.view_device'),
    'rack': ('dcim.rack', 'dcim-api:rack-list', 'dcim.view_rack'),
    'map': ('netbox_map.map', 'plugins-api:netbox_map-api:map-list', 'netbox_map.view_map'),
    # What a drawn cable route can be tied to.
    'cable': ('dcim.cable', 'dcim-api:cable-list', 'dcim.view_cable'),
    'cablebundle': ('dcim.cablebundle', 'dcim-api:cablebundle-list', 'dcim.view_cablebundle'),
    'circuit': ('circuits.circuit', 'circuits-api:circuit-list', 'circuits.view_circuit'),
}
# Searches limited to the map's region, site or location.
SCOPED_SEARCHES = ('device', 'rack')

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
        if scope_filter and kind in SCOPED_SEARCHES:
            url += f'?{scope_filter}'
        sources[kind] = {'type': object_type, 'url': url}
    return sources


def _place(map_):
    """
    Where the map is, for the sidebar: its parent maps from the top down,
    then the region, site or location it is assigned to.
    """
    place = []
    ancestor = map_.parent
    while ancestor is not None and len(place) < 20:
        place.insert(0, {'label': ancestor.name, 'url': ancestor.get_absolute_url(), 'kind': 'map'})
        ancestor = ancestor.parent
    scope = map_.scope if map_.scope_type_id else None
    if scope is not None:
        # A location's site, a site's region: one step up says where it is.
        site = getattr(scope, 'site', None)
        if site is not None:
            place.append({'label': str(site), 'url': site.get_absolute_url(), 'kind': 'site'})
        place.append({'label': str(scope), 'url': scope.get_absolute_url(), 'kind': map_.scope_type.model})
    return place


def map_data(map_, request, highlight=None):
    """Everything assets/map.js needs to draw `map_` for this request's user."""
    user = request.user
    # Objects come in one query per kind (prefetch), and so do the checks
    # of which of them the user may see.
    markers = list(
        MapMarker.objects.restrict(user, 'view').filter(map=map_).select_related('object_type').prefetch_related('object')
    )
    shapes = list(map_.shapes.restrict(user, 'view').select_related('link', 'object_type').prefetch_related('object'))
    visible = visible_objects(
        [m.object for m in markers if m.object_type_id] + [s.object for s in shapes if s.object_type_id], user
    )
    markers = [data for data in (_marker(marker, user, visible) for marker in markers) if data]
    return_url = map_.get_absolute_url()
    return {
        'id': map_.pk,
        'name': map_.name,
        'url': map_.get_absolute_url(),
        'image_only': map_.base_layer == BaseLayerChoices.IMAGE,
        'tiles': tile_settings(),
        'overlays': [_overlay(overlay) for overlay in map_.overlays.restrict(user, 'view')],
        'markers': markers,
        'shapes': [_shape(shape, user, visible) for shape in shapes],
        'default_view': (
            {'x': map_.default_x, 'y': map_.default_y, 'zoom': map_.default_zoom} if map_.has_default_view else None
        ),
        'rotation': map_.rotation,
        'layer_offsets': map_.layer_offsets or {},
        'default_colors': default_colors(),
        'place': _place(map_),
        'submaps': [
            {'name': child.name, 'url': child.get_absolute_url()}
            for child in map_.children.restrict(user, 'view').order_by('name')
        ],
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
        'shape_card_url': reverse('plugins:netbox_map:shape_card', args=[0]),
        # NetBox's CSRF cookie is HttpOnly, so the editor gets the token here.
        'csrf_token': get_token(request),
    }
