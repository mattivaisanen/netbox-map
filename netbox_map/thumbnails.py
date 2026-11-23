"""
Pictures of maps for the maps grid.

Each card shows its map's start view, drawn in the browser by map.js
(NetBox.thumbnails) with the same code as the map's own page: same middle,
zoom, turn, background, images, areas and circles. Markers, lines,
junctions and labels are left out. This module gathers what those pictures
need, for all cards at once.

Vector backgrounds (a `style` in base_layers) need MapLibre and WebGL,
which is far too heavy for a grid of cards (browsers allow only a few WebGL
maps per page), so pictures use plain tile backgrounds only.
"""
from django.db.models import Max, Min

from .choices import BaseLayerChoices, ShapeKindChoices
from .models import MapMarker, MapOverlay, MapShape
from .viewer import default_colors, tile_settings

# Shapes drawn in the pictures. Lines (cables and other connections) and
# junctions are left out like markers, but still count towards the view.
DRAWN_KINDS = (ShapeKindChoices.AREA, ShapeKindChoices.CIRCLE)


def backgrounds():
    """The base_layers that can be drawn as plain tiles, in their order."""
    return [layer for layer in tile_settings()['layers'] if layer.get('url')]


def _is_point(point):
    return (
        isinstance(point, list) and len(point) == 2
        and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in point)
    )


def _extend(extent, x, y):
    """Grow `extent` ([[y_min, x_min], [y_max, x_max]] or None) to hold x, y."""
    if extent is None:
        return [[y, x], [y, x]]
    (y_min, x_min), (y_max, x_max) = extent
    return [[min(y_min, y), min(x_min, x)], [max(y_max, y), max(x_max, x)]]


def grid_data(maps, user):
    """
    What map.js needs to draw the pictures of `maps`, for `user`: the tile
    backgrounds, and per map ID its view, turn, images, areas and circles,
    and the extent of what isn't drawn (markers, lines, junctions), which
    the page still fits its view to. Three queries in all, whatever the
    number of maps.
    """
    ids = [m.pk for m in maps]
    entries = {
        m.pk: {
            'image_only': m.base_layer == BaseLayerChoices.IMAGE,
            'rotation': m.rotation,
            'layer_offsets': m.layer_offsets or {},
            'default_view': (
                {'x': m.default_x, 'y': m.default_y, 'zoom': m.default_zoom} if m.has_default_view else None
            ),
            'overlays': [],
            'shapes': [],
            'extent': None,
        }
        for m in maps
    }
    if not ids:
        return {'backgrounds': backgrounds(), 'maps': {}}

    # Markers only count towards the view: their corners are enough.
    for row in (
        MapMarker.objects.restrict(user, 'view')
        .filter(map_id__in=ids, x__isnull=False, y__isnull=False)
        .values('map_id').annotate(x_min=Min('x'), x_max=Max('x'), y_min=Min('y'), y_max=Max('y'))
    ):
        entry = entries[row['map_id']]
        entry['extent'] = _extend(entry['extent'], row['x_min'], row['y_min'])
        entry['extent'] = _extend(entry['extent'], row['x_max'], row['y_max'])

    for overlay in MapOverlay.objects.restrict(user, 'view').filter(map_id__in=ids).order_by('weight', 'pk'):
        entries[overlay.map_id]['overlays'].append({
            'url': overlay.image.url,
            'opacity': overlay.opacity,
            'weight': overlay.weight,
            'width': overlay.image_width,
            'height': overlay.image_height,
            'bounds': [[overlay.y_min, overlay.x_min], [overlay.y_max, overlay.x_max]] if overlay.is_placed else None,
        })

    for map_id, kind, color, points, radius, level in (
        MapShape.objects.restrict(user, 'view').filter(map_id__in=ids)
        .values_list('map_id', 'kind', 'color', 'points', 'radius', 'level')
    ):
        points = [p for p in points or [] if _is_point(p)]
        if not points:
            continue
        entry = entries[map_id]
        if kind in DRAWN_KINDS:
            entry['shapes'].append({
                'kind': kind, 'color': f'#{color}', 'points': points, 'radius': radius, 'level': level,
            })
        else:
            for x, y in points:
                entry['extent'] = _extend(entry['extent'], x, y)

    return {'backgrounds': backgrounds(), 'default_colors': default_colors(), 'maps': entries}
