# netbox-map

A NetBox plugin that puts your network on a map. Draw where things are:
which building a site is in, which room a rack stands in, where a device
hangs on the wall. Open a map and you see your NetBox objects in place, and
click through to them.

A map is either a real world map, with your own images (floor plans, site
drawings, aerial photos) laid on top, or just your own image on its own.
Maps can contain other maps, so a campus map can lead to a building, and the
building to each floor.

Maps are drawn and edited right in NetBox: drag devices into place, draw
room outlines, and line a floor plan up with the world map below it. Rest
the mouse on a device, rack or cable to see its details, filter what is
shown from the side panel, switch between street and satellite views, and
turn a map so it matches how the building is laid out. Any map can be saved
as a PNG, SVG or PDF file, exactly as it is shown.

## What you can put on a map

- **Overlays:** images laid over the map, each with its own opacity, so the
  map below can show through. PNG, JPEG, GIF, WebP or SVG.
- **Markers:** any NetBox object at a point: devices, racks, sites,
  locations, power panels, circuits, and other maps. A marker for another
  map opens that map. A marker can also be just a text label.
- **Device health:** an optional colored dot on device markers, green to
  red by how old a value on the device is, such as the time it last
  answered a monitoring check. Any custom field can drive it.
- **Shapes:** lines, areas and circles, for room outlines or coverage
  areas, and junctions (manholes, cable wells, poles) that cables run
  through.
- **Cable routes:** lines tied to a NetBox cable, cable bundle or circuit,
  showing where it runs. An area can open another map, so clicking a building
  outline takes you to the building.

The same object can be on several maps, for example on a building overview
and on its floor plan.

A map can be assigned to a region, site group, site or location, and then
shows on that object's page. Every object on a map gets a **Show on map**
button, and a device that isn't on a map itself is found through its rack,
location or site.

## Requirements

- NetBox 4.7 or later. NetBox refuses to load the plugin on older versions.
- No other plugins, and no Python packages beyond what NetBox installs.
- For world maps, browsers need to reach map tile servers. The defaults
  are OpenStreetMap and Esri; servers in your own network can be set
  instead (see [configuration](docs/configuration.md)). Image-only maps
  need nothing.

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

Apache License 2.0, see [LICENSE](LICENSE). Includes
[Leaflet](https://leafletjs.com) 1.9.4 (BSD 2-Clause, see
`netbox_map/assets/LICENSE-leaflet.txt`) and
[MapLibre GL JS](https://maplibre.org) 5.24.0 (BSD 3-Clause, see
`netbox_map/assets/LICENSE-maplibre.txt`).
