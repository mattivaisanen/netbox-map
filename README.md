# netbox-map

A NetBox plugin that puts your network on a map. Draw where things are:
which building a site is in, which room a rack stands in, where a device
hangs on the wall. Open a map and you see your NetBox objects in place, and
click through to them.

A map is either a real world map, with your own images (floor plans, site
drawings, aerial photos) laid on top, or just your own image on its own.
Maps can contain other maps, so a campus map can lead to a building, and the
building to each floor.

> **Status:** early development. This version stores maps and what is on
> them, with pages to manage them and a REST API. Drawing the map in the
> browser comes next; see the [changelog](CHANGELOG.md).

## What you can put on a map

- **Overlays:** images laid over the map, each with its own opacity, so the
  map below can show through. PNG, JPEG, GIF, WebP or SVG.
- **Markers:** any NetBox object at a point: devices, racks, sites,
  locations, power panels, circuits, and other maps. A marker for another
  map opens that map. A marker can also be just a text label.
- **Shapes:** lines, areas and circles, for room outlines, cable routes or
  coverage areas.

The same object can be on several maps, for example on a building overview
and on its floor plan.

A map can be assigned to a region, site group, site or location.

## Requirements

- NetBox 4.7 or later. NetBox refuses to load the plugin on older versions.
- No other plugins, and no Python packages beyond what NetBox installs.

## Installation

Install into NetBox's Python environment:

```bash
pip install git+https://github.com/mattivaisanen/netbox-map.git
```

Enable it in `configuration.py`:

```python
PLUGINS = ['netbox_map']
```

Create the plugin's tables and restart NetBox:

```bash
cd /opt/netbox/netbox && python manage.py migrate netbox_map
sudo systemctl restart netbox
```

Give users the `netbox_map` permissions they need under
**Admin → Permissions**. See [docs/installation.md](docs/installation.md).

## Upgrading

```bash
pip install --upgrade --force-reinstall --no-deps git+https://github.com/mattivaisanen/netbox-map.git
cd /opt/netbox/netbox && python manage.py migrate
```

Then restart NetBox. The [changelog](CHANGELOG.md) lists what each version
needs.

## Uninstalling

The plugin keeps everything in its own tables and never changes NetBox's
own data. To remove it cleanly:

```bash
cd /opt/netbox/netbox
python manage.py prepare_map_uninstall
python manage.py migrate netbox_map zero
```

Then take `netbox_map` out of `PLUGINS`, restart NetBox and
`pip uninstall netbox-map`. See
[docs/installation.md](docs/installation.md#uninstalling) for what each step
does.

## Documentation

- [Installation, upgrading and uninstalling](docs/installation.md)
- [Using maps](docs/usage.md)
- [Configuration](docs/configuration.md)
- [Developer notes](DEVELOPER.md)
- [Changelog](CHANGELOG.md)

## License

Apache License 2.0, see [LICENSE](LICENSE).
