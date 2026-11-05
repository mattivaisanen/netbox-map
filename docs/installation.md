# Installation

The plugin is not on PyPI. Install it from GitHub into NetBox's own Python
environment (on a standard install, `source /opt/netbox/venv/bin/activate`
first):

```bash
pip install git+https://github.com/mattivaisanen/netbox-map.git
```

To keep it installed across NetBox upgrades, add the same line to
`/opt/netbox/local_requirements.txt`:

```text
git+https://github.com/mattivaisanen/netbox-map.git
```

Add it to `configuration.py`:

```python
PLUGINS = [
    'netbox_map',
]
```

Create the plugin's tables, then restart NetBox:

```bash
cd /opt/netbox/netbox
python manage.py migrate netbox_map
sudo systemctl restart netbox
```

## Permissions

Give users permissions on the object types under *Maps* (Admin →
Permissions):

| To | Give |
|---|---|
| See maps | `view` on Map, Marker, Overlay and Shape |
| Create and change maps | `add`, `change`, `delete` on Map |
| Place objects and labels | `add`, `change`, `delete` on Marker |
| Upload and place images | `add`, `change`, `delete` on Overlay |
| Draw lines, areas and circles | `add`, `change`, `delete` on Shape |

A user also needs `view` on an object to see its name on a marker.

## Overlay images

Overlay images are stored under `MEDIA_ROOT/netbox-map/<map id>/`, next to
NetBox's own image attachments. Back them up with the rest of NetBox's media
folder.

## Upgrading

```bash
pip install --upgrade --force-reinstall --no-deps git+https://github.com/mattivaisanen/netbox-map.git
cd /opt/netbox/netbox
python manage.py migrate
sudo systemctl restart netbox
```

## Uninstalling

The plugin never writes to NetBox's own tables. NetBox itself, however,
keeps rows about every object, maps included: change log and journal
entries, bookmarks, notifications, tag assignments and so on. Once the
plugin is gone, a NetBox page that lists such a row can't load the map
behind it and fails with a server error. The same goes for a tag, custom
field or permission set up for maps.

`prepare_map_uninstall` removes those rows while the plugin is still
installed:

- deletes change log and journal entries, bookmarks, notifications,
  subscriptions, tag assignments, image attachments, saved table
  configurations, search entries and background jobs about maps
- takes the plugin's object types off custom fields, custom links, export
  templates, saved filters, tags, event rules and permissions, and deletes
  those that were only about maps
- deletes custom fields whose values are maps

It shows what it will remove and asks first. `--dry-run` only shows.

```bash
cd /opt/netbox/netbox
python manage.py prepare_map_uninstall --dry-run
python manage.py prepare_map_uninstall
```

Maps are kept until you remove the plugin's tables:

```bash
python manage.py migrate netbox_map zero
```

Then take `netbox_map` out of `PLUGINS`, restart NetBox, uninstall the
package, and delete `MEDIA_ROOT/netbox-map/` if you don't want the overlay
images any more:

```bash
pip uninstall netbox-map
```
