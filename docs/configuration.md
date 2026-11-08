# Configuration

Settings live under `PLUGINS_CONFIG['netbox_map']` in NetBox's
`configuration.py`. All are optional.

| Key | Type | Default | Description |
|---|---|---|---|
| `base_layers` | list | Simple, Regular, Satellite (see below) | Backgrounds of world maps. Users switch between them in the map's side panel. Empty list: world maps have no background. |
| `default_colors` | dict | `{}` | Colors for markers and shapes that have none of their own, by kind. See below. |
| `geocoder_url` | string | `'https://nominatim.openstreetmap.org/search'` | Address of a [Nominatim](https://nominatim.org)-compatible search, used by the place box in the map editor. The browser calls it directly. Empty: the box accepts only coordinates. |
| `hover_fields` | dict | `{}` | Details on the card shown when the mouse rests on a marker or a cable route, per object type. See below. |
| `rack_elevation` | boolean | `True` | Show a rack's front elevation on its card. |

Image-only maps never load tiles.

## Background layers

Each entry of `base_layers` is one background:

| Key | Description |
|---|---|
| `name` | Shown on the layer's button. |
| `url` | Tile address, with `{z}`, `{x}` and `{y}` where the zoom level and tile numbers go. `{s}` (subdomain) and `{r}` (`@2x` on high-resolution screens) also work. |
| `attribution` | Credit shown in the map's corner. HTML is allowed. Most tile servers require one. |
| `max_zoom` | Highest zoom level the server offers (default 19). Maps zoom in further, to level 22, by enlarging the last tiles. Zooming goes in half steps. |

Other keys go to Leaflet's
[tile layer options](https://leafletjs.com/reference.html#tilelayer-option),
such as `subdomains`.

The defaults are:

| Name | Source | Terms |
|---|---|---|
| Simple | Esri World Light Gray Canvas (to level 16) | [Esri terms of use](https://www.esri.com/en-us/legal/terms/full-master-agreement). |
| Regular | OpenStreetMap | [Tile usage policy](https://operations.osmfoundation.org/policies/tiles/): free for light use. |
| Satellite | Esri World Imagery | [Esri terms of use](https://www.esri.com/en-us/legal/terms/full-master-agreement). |

Check that the terms fit how your organization uses NetBox. To use other
sources, or only some of these, list them yourself:

```python
PLUGINS_CONFIG = {
    'netbox_map': {
        'base_layers': [
            {
                'name': 'Streets',
                'url': 'https://tiles.example.net/streets/{z}/{x}/{y}.png',
                'attribution': 'Map data from our own tile server',
                'max_zoom': 18,
            },
            {
                'name': 'Aerial',
                'url': 'https://tiles.example.net/aerial/{z}/{x}/{y}.jpg',
                'attribution': 'Aerial images from our own tile server',
            },
        ],
    },
}
```

When the browsers using NetBox can't reach the internet, list only tile
servers inside the network, and set `geocoder_url` to an internal search
or to `''`.

OpenStreetMap requires a referrer on tile requests, so tiles are requested
with NetBox's address (without the page path), although NetBox otherwise
sends none to other sites. The place search follows OpenStreetMap's
[Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/):
it searches once when the user presses Enter, never while typing, and
lists up to five places to pick from.

## Cards

`hover_fields` maps an object type (`app_label.model`) to the fields its
card shows, in order. A field can be a field of the object, a path through
related objects with dots, or `cf.` and a custom field's name. Names the
object doesn't have are left out. Types not listed keep the built-in
choice:

| Type | Fields |
|---|---|
| Device | status, role, device type, primary IP, rack, position |
| Rack | status, role, location, height; plus the elevation and the devices in it |
| Cable | status, type, both ends, length |
| Circuit | status, provider, type |
| Anything else | status, description |

```python
PLUGINS_CONFIG = {
    'netbox_map': {
        'hover_fields': {
            'dcim.device': ['status', 'device_type.manufacturer', 'device_type', 'primary_ip4', 'serial', 'cf.owner'],
            'dcim.cable': ['status', 'label', 'length', 'tenant'],
        },
    },
}
```

## Default colors

`default_colors` sets colors by kind, as hex such as `'4caf50'`:

| Kind | Used for |
|---|---|
| `device`, `rack`, `object` | Markers of devices, racks and other objects without a color of their own, instead of their status color. |
| `cable` | Cable routes without a color of their own whose cable has no color, instead of their status color. |
| `line`, `area`, `circle`, `junction` | Shapes still in the color new shapes get (`#2196f3`). |

Changing a setting recolors everything that has no color of its own.

```python
PLUGINS_CONFIG = {
    'netbox_map': {
        'default_colors': {'rack': '455a64', 'junction': '795548', 'area': '9e9e9e'},
    },
}
```

