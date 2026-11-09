"""
NetBox plugin for maps: a world map or your own floor plan as the base,
image overlays and drawn shapes on top, and NetBox objects (devices, racks,
sites, other maps, ...) placed on it. See README.md and docs/.
"""
from netbox.plugins import PluginConfig


class NetBoxMapConfig(PluginConfig):
    name = 'netbox_map'
    verbose_name = 'Maps'
    description = (
        'Maps in NetBox: world maps or your own floor plans, with image overlays, drawn shapes, '
        'and devices, racks and other objects placed on them.'
    )
    version = '0.1.0'
    author = 'Matti'
    base_url = 'maps'
    # The oldest NetBox release the tests run on.
    min_version = '4.7.0'

    # See docs/configuration.md.
    default_settings = {
        # Background layers of world maps; users switch between them in the
        # map's sidebar. Any tile server with the usual {z}/{x}/{y} layout
        # works, including one inside your own network, and so does a vector
        # map given as a MapLibre `style`. max_zoom is the server's highest
        # level: the map zooms further in by enlarging the last tiles. Other
        # keys are passed to Leaflet's tile layer.
        'base_layers': [
            {
                # Light gray, no names, sharp at every zoom: OpenFreeMap's
                # Positron vector map without its labels, in gray. No key
                # is needed; commercial use is allowed with attribution.
                'name': 'Simple',
                'style': 'https://tiles.openfreemap.org/styles/positron',
                'labels': False,
                'filter': 'grayscale(1)',
                'attribution': '<a href="https://openfreemap.org">OpenFreeMap</a> '
                               '&copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> '
                               'Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
                'max_zoom': 22,
            },
            {
                'name': 'Regular',
                'url': 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                'attribution': '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                'max_zoom': 19,
            },
            {
                'name': 'Satellite',
                'url': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                'attribution': 'Imagery &copy; Esri, Maxar, Earthstar Geographics and the GIS User Community',
                'max_zoom': 19,
            },
        ],
        # Place search on world maps: a Nominatim-compatible search address.
        # Empty: only coordinates can be searched.
        'geocoder_url': 'https://nominatim.openstreetmap.org/search',
        # Fields on the card shown when the mouse rests on a marker, per
        # object type ('dcim.device': ['status', 'primary_ip', ...]). Types
        # not named here keep the built-in choice (see cards.py).
        'hover_fields': {},
        # Show a rack's front elevation on its card.
        'rack_elevation': True,
        # Colors used when a marker or shape has none of its own, by kind:
        # device, rack, object (other markers), cable, line, area, circle,
        # junction. Hex, such as '4caf50'. Unset kinds keep the built-in
        # look (status colors for markers and cables).
        'default_colors': {},
        # A colored dot on device markers showing how fresh a value on the
        # device is, such as when it last answered. Off until `field` is
        # set; see health.py for the keys and their defaults.
        'device_health': {},
    }

    menu = 'navigation.menu'
    template_extensions = 'template_content.template_extensions'

    def ready(self):
        super().ready()

        from . import signals  # noqa: F401 (connects receivers)


config = NetBoxMapConfig
