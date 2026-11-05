# Developer guide

How the plugin is put together, and why.

## Ground rules

- **NetBox 4.7+ only**, through documented plugin extension points:
  generic views, `register_model_view`, `get_model_urls`, NetBox's form,
  table, filter set and REST API base classes. No monkey-patching.
- **No dependency on other plugins** and no Python packages beyond what
  NetBox installs. Images are read with Pillow, which NetBox already has.
- **NetBox's own tables are never changed.** Everything lives in the
  plugin's tables; NetBox objects are referred to by type and ID. Removing
  the plugin (after `prepare_map_uninstall`) leaves NetBox as it was.
- **No database queries at startup.** Form querysets are lazy.

## Module map

| Module | Responsibility |
|---|---|
| `models.py` | `Map` (a NetBoxModel) and its change-logged parts `MapOverlay`, `MapMarker` and `MapShape`, with their validation. |
| `images.py` | Overlay file checks: allowed types, unsafe SVG content, and reading the pixel size. |
| `signals.py` | Removes markers of deleted objects, clears the assignment of maps whose region/site/location was deleted, deletes overlay files. |
| `views.py`, `forms.py`, `filtersets.py`, `tables.py`, `urls.py`, `navigation.py`, `search.py`, `api/` | Standard NetBox UI and REST API. |
| `management/commands/prepare_map_uninstall.py` | Removes NetBox rows about maps that would break NetBox pages once the plugin is gone. |

## Data model

- **Map** is a full NetBoxModel: change log, journal, tags, custom fields,
  Event Rules, search. `parent` makes submaps (`SET_NULL`, so deleting a
  building keeps its floors). `scope` is a generic relation limited to
  NetBox's location scope types (region, site group, site, location), the
  same set NetBox uses for prefix and cluster scopes.
- **MapOverlay**, **MapMarker** and **MapShape** are ChangeLoggedModels, like
  NetBox's image attachments: change-logged, without tags or custom fields.
  They have no page of their own; `get_absolute_url()` is their map's page,
  where they are listed. Their list, add, edit and delete views exist so
  permissions, change log links and bulk delete work as usual.
- **Positions** are plain `x`/`y` floats in the map's own units: longitude
  and latitude on a world map, pixels from the bottom-left corner on an
  image-only map. This is how Leaflet's `CRS.Simple` counts, so the map
  view can use the stored numbers as they are. Empty positions and corners
  mean "not placed yet", so objects can be added from forms or the API
  first and placed on the map later.
- **Shapes** store their points as a JSON list of `[x, y]` pairs. A circle is
  one point and a radius. `MapShape.clean()` checks the structure.

## Markers and deleted objects

A marker points at any public NetBox object type through a generic
relation, so the database does not remove it when the object goes.
`signals.object_deleted` listens to every `post_delete`, skips NetBox's
bookkeeping apps and the map's own parts, and deletes the object's markers
one by one so each deletion is change-logged. A map assigned to a deleted
region, site group, site or location keeps existing with no assignment.

`Map` itself can be a marker's object (a link to another map). The
constraint `(map, object_type, object_id)` allows an object once per map;
text labels have no object and are not limited.

## Overlay images

Stored with a plain `FileField` under `MEDIA_ROOT/netbox-map/<map id>/`.
NetBox's `ImageField` uses Pillow to validate, and Pillow can't open SVG,
so `images.validate_image()` checks raster files with Pillow and SVG files
with a pattern that refuses scripts, event handlers, `javascript:` links
and embedded HTML. NetBox serves media from its own address, so a script
in an SVG opened directly would run as the logged-in user.

The pixel size is read on save when a new file comes in. Old files are
deleted after the transaction commits, when an overlay is deleted or its
image replaced.

## Tests

```bash
cd /opt/netbox/netbox
python manage.py test netbox_map
```

CI runs them on the oldest supported NetBox release.
