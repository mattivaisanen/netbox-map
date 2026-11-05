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

    default_settings = {}

    menu = 'navigation.menu'

    def ready(self):
        super().ready()

        from . import signals  # noqa: F401 (connects receivers)


config = NetBoxMapConfig
