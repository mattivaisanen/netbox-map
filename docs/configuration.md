# Configuration

Settings live under `PLUGINS_CONFIG['netbox_map']` in NetBox's
`configuration.py`. All are optional.

| Key | Type | Default | Description |
|---|---|---|---|
| `tile_url` | string | `'https://tile.openstreetmap.org/{z}/{x}/{y}.png'` | Address of the world map's tiles, with `{z}`, `{x}` and `{y}` where the zoom level and tile numbers go (`{s}` for a subdomain also works). The browser loads the tiles, so it needs to reach this server. Empty: world maps have no background. |
| `tile_attribution` | string | OpenStreetMap credit | Credit shown in the corner of world maps. HTML is allowed. Most tile servers require one. |
| `max_zoom` | integer | `19` | Highest zoom level the tile server offers. World maps zoom in further, to level 22, by enlarging the last tiles. |
| `geocoder_url` | string | `'https://nominatim.openstreetmap.org/search'` | Address of a [Nominatim](https://nominatim.org)-compatible search, used by the place box on world maps. The browser calls it directly. Empty: the box accepts only coordinates. |
| `hover_fields` | dict | `{}` | Details on the card shown when the mouse rests on a marker, per object type. See below. |
| `rack_elevation` | boolean | `True` | Show a rack's front elevation on its card. |

Image-only maps never load tiles.

## Marker cards

`hover_fields` maps an object type (`app_label.model`) to the fields its
card shows, in order. A field can be a field of the object, a path through
related objects with dots, or `cf.` and a custom field's name. Names the
object doesn't have are left out. Types not listed keep the built-in
choice: status, role, device type, primary IP, rack and position for
devices; status, role, location and height for racks; status and
description for anything else.

```python
PLUGINS_CONFIG = {
    'netbox_map': {
        'hover_fields': {
            'dcim.device': ['status', 'device_type.manufacturer', 'device_type', 'primary_ip4', 'serial', 'cf.owner'],
            'dcim.rack': ['status', 'facility_id', 'u_height'],
        },
    },
}
```

## A tile server in your own network

When the browsers using NetBox can't reach the internet, point `tile_url`
at a tile server inside the network:

```python
PLUGINS_CONFIG = {
    'netbox_map': {
        'tile_url': 'https://tiles.internal.lan/{z}/{x}/{y}.png',
        'tile_attribution': 'Map data from our own tile server',
        'max_zoom': 18,
    },
}
```

OpenStreetMap's public tiles are free for light use under their
[tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
The policy requires a referrer, so tile requests send NetBox's address
(without the page path), although NetBox otherwise sends none to other
sites. The same goes for OpenStreetMap's public place search under its
[Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/):
searches are made one at a time, when a user presses Enter.
