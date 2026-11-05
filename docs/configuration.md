# Configuration

Settings live under `PLUGINS_CONFIG['netbox_map']` in NetBox's
`configuration.py`. All are optional.

| Key | Type | Default | Description |
|---|---|---|---|
| `tile_url` | string | `'https://tile.openstreetmap.org/{z}/{x}/{y}.png'` | Address of the world map's tiles, with `{z}`, `{x}` and `{y}` where the zoom level and tile numbers go (`{s}` for a subdomain also works). The browser loads the tiles, so it needs to reach this server. Empty: world maps have no background. |
| `tile_attribution` | string | OpenStreetMap credit | Credit shown in the corner of world maps. HTML is allowed. Most tile servers require one. |
| `max_zoom` | integer | `19` | Highest zoom level the tile server offers. |

Image-only maps never load tiles.

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
sites.
