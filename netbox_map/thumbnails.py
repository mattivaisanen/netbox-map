"""
Pictures of world maps for the maps grid.

A world map's thumbnail is a few background tiles laid side by side in
plain HTML, with the map's placed images on top. No map library runs on
the maps page and nothing is fetched by NetBox itself: the browser loads
the tiles straight from the tile server (lazily, only for cards in view)
and caches them like on the map pages.

Vector backgrounds (a `style` in base_layers) need MapLibre and WebGL,
which is far too heavy for a grid of cards, so thumbnails use the first
background with a tile `url`. With none, the card keeps its icon.

Thumbnails are north up and leave out layer offsets.
"""
import math
import re

from django.db.models import Max, Min

from .choices import BaseLayerChoices
from .models import MapMarker, MapShape
from .viewer import tile_settings

# The picture laid out under each card, in CSS pixels. Wider than a card
# so wide cards (one per row on small screens) are still filled; the card
# shows its middle.
WIDTH, HEIGHT = 480, 160
# Room the map's contents are fitted into: a card's size minus a margin.
FIT_WIDTH, FIT_HEIGHT = 240, 110
# Zoom for a map with only one point on it.
POINT_ZOOM = 16
# How much further out than its own start view a map is shown: the start
# zoom is meant for a whole window, a card is about a quarter as wide.
START_VIEW_ZOOM_OUT = 2
# Web Mercator stops here.
MAX_LATITUDE = 85.0511287798

# Leaflet's {name} placeholders in a tile url.
PLACEHOLDER = re.compile(r'\{ *([\w-]+) *\}')


def thumbnail_layer():
    """The first background that can be drawn as plain tiles, or None."""
    for layer in tile_settings()['layers']:
        if layer.get('url'):
            return layer
    return None


def project(x, y, zoom):
    """Longitude, latitude to Web Mercator pixels at `zoom` (256 px tiles)."""
    size = 256 * 2 ** zoom
    lat = math.radians(max(-MAX_LATITUDE, min(MAX_LATITUDE, y)))
    return (
        (x + 180) / 360 * size,
        (1 - math.log(math.tan(lat) + 1 / math.cos(lat)) / math.pi) / 2 * size,
    )


def tile_url(layer, x, y, z):
    """One tile's address, filled in the way Leaflet fills a tile url."""
    subdomains = layer.get('subdomains', 'abc')
    values = {
        **{key: value for key, value in layer.items() if isinstance(value, (str, int, float))},
        'x': x, 'z': z, 'r': '',
        'y': (2 ** z - 1 - y) if layer.get('tms') else y,
        '-y': 2 ** z - 1 - y,
        's': subdomains[(x + y) % len(subdomains)] if subdomains else '',
    }

    def fill(match):
        if match.group(1) not in values:
            raise KeyError(match.group(1))
        return str(values[match.group(1)])
    return PLACEHOLDER.sub(fill, layer['url'])


def view_for(map_, points, max_zoom):
    """
    The center (x, y) and whole zoom level to show: the map's start view
    zoomed out to card size, or everything on it fitted to a card, or the
    whole world when it is empty.
    """
    if map_.has_default_view:
        zoom = math.floor(map_.default_zoom) - START_VIEW_ZOOM_OUT
        return (map_.default_x, map_.default_y), max(0, min(max_zoom, zoom))
    if not points:
        return (0, 20), 0
    # Fit in pixels at zoom 0, so the middle is the middle on the map.
    pixels = [project(x, y, 0) for x, y in points]
    left, right = min(p[0] for p in pixels), max(p[0] for p in pixels)
    top, bottom = min(p[1] for p in pixels), max(p[1] for p in pixels)
    width, height = right - left, bottom - top
    if width == height == 0:
        zoom = min(POINT_ZOOM, max_zoom)
    else:
        scale = min(FIT_WIDTH / width if width else math.inf, FIT_HEIGHT / height if height else math.inf)
        zoom = max(0, min(max_zoom, math.floor(math.log2(scale))))
    # Back to longitude, latitude.
    middle_x = (left + right) / 2 / 256 * 360 - 180
    middle_y = math.degrees(math.atan(math.sinh(math.pi * (1 - (top + bottom) / 256))))
    return (middle_x, middle_y), zoom


def build(map_, points, overlays, layer):
    """
    A thumbnail for one world map: `tiles` and `overlays`, each with its
    place in the WIDTH x HEIGHT picture. None when the layer's url can't be
    filled in.
    """
    size = int(layer.get('tileSize', 256))
    zoom_offset = int(layer.get('zoomOffset', 0))
    (center_x, center_y), zoom = view_for(map_, points, int(layer.get('max_zoom', 19)))
    cx, cy = project(center_x, center_y, zoom)
    origin_x, origin_y = cx - WIDTH / 2, cy - HEIGHT / 2
    count = 256 * 2 ** zoom // size  # tiles across the world at this zoom

    tiles = []
    try:
        for ty in range(max(0, math.floor(origin_y / size)), min(count, math.ceil((origin_y + HEIGHT) / size))):
            for tx in range(math.floor(origin_x / size), math.ceil((origin_x + WIDTH) / size)):
                tiles.append({
                    # Past the date line the world repeats, as on the map.
                    'url': tile_url(layer, tx % count, ty, zoom + zoom_offset),
                    'left': round(tx * size - origin_x),
                    'top': round(ty * size - origin_y),
                })
    except (KeyError, ZeroDivisionError):
        return None

    placed = []
    for overlay in overlays:
        if not overlay.is_placed:
            continue
        left, top = project(overlay.x_min, overlay.y_max, zoom)
        right, bottom = project(overlay.x_max, overlay.y_min, zoom)
        placed.append({
            'url': overlay.image.url,
            'opacity': overlay.opacity / 100,
            'left': round(left - origin_x), 'top': round(top - origin_y),
            'width': max(1, round(right - left)), 'height': max(1, round(bottom - top)),
        })
    return {'size': size, 'filter': layer.get('filter', ''), 'tiles': tiles, 'overlays': placed}


def add_thumbnails(maps):
    """
    Set `thumbnail` on each world map in `maps` (overlays prefetched in
    drawing order). Two queries in all: the corners of each map's markers,
    and the points of its shapes.
    """
    layer = thumbnail_layer()
    world = [m for m in maps if m.base_layer == BaseLayerChoices.WORLD]
    if not layer or not world:
        return layer
    ids = [m.pk for m in world]
    points = {pk: [] for pk in ids}
    for row in (
        MapMarker.objects.filter(map_id__in=ids, x__isnull=False, y__isnull=False)
        .values('map_id').annotate(x_min=Min('x'), x_max=Max('x'), y_min=Min('y'), y_max=Max('y'))
    ):
        points[row['map_id']] += [(row['x_min'], row['y_min']), (row['x_max'], row['y_max'])]
    for map_id, shape_points in MapShape.objects.filter(map_id__in=ids).values_list('map_id', 'points'):
        points[map_id] += [
            (p[0], p[1]) for p in shape_points or []
            if isinstance(p, list) and len(p) == 2 and all(isinstance(v, (int, float)) for v in p)
        ]
    for map_ in world:
        overlays = list(map_.overlays.all())
        corners = [
            point for o in overlays if o.is_placed for point in ((o.x_min, o.y_min), (o.x_max, o.y_max))
        ]
        map_.thumbnail = build(map_, points[map_.pk] + corners, overlays, layer)
    return layer
