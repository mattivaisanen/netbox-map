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
        # Tiles of the world map. Any server with the usual {z}/{x}/{y}
        # layout works, including one inside your own network.
        'tile_url': 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        'tile_attribution': '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        # Highest zoom level the tile server offers. The map zooms further
        # in than that by enlarging the last tiles.
        'max_zoom': 19,
        # Place search on world maps: a Nominatim-compatible search address.
        # Empty: only coordinates can be searched.
        'geocoder_url': 'https://nominatim.openstreetmap.org/search',
        # Fields on the card shown when the mouse rests on a marker, per
        # object type ('dcim.device': ['status', 'primary_ip', ...]). Types
        # not named here keep the built-in choice (see cards.py).
        'hover_fields': {},
        # Show a rack's front elevation on its card.
        'rack_elevation': True,
    }

    menu = 'navigation.menu'
    template_extensions = 'template_content.template_extensions'

    def ready(self):
        super().ready()

        from . import signals  # noqa: F401 (connects receivers)


config = NetBoxMapConfig
