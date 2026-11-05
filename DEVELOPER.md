# Developer guide

How the plugin is put together, and why.

## Ground rules

- **NetBox 4.7+ only**, through documented plugin extension points:
  generic views, `register_model_view`, `get_model_urls`, NetBox's form,
  table, filter set and REST API base classes. No monkey-patching.
- **No dependency on other plugins** and no Python packages beyond what
  NetBox installs. Images are read with Pillow, which NetBox already has.
  Leaflet 1.9.4 is bundled in `assets/`; nothing is loaded from a CDN.
- **NetBox's own tables are never changed.** Everything lives in the
  plugin's tables; NetBox objects are referred to by type and ID. Removing
  the plugin (after `prepare_map_uninstall`) leaves NetBox as it was.
- **No database queries at startup.** Form querysets are lazy.

## Module map

| Module | Responsibility |
|---|---|
| `models.py` | `Map` (a NetBoxModel) and its change-logged parts `MapOverlay`, `MapMarker` and `MapShape`, with their validation. |
| `images.py` | Overlay file checks: allowed types, unsafe SVG content, and reading the pixel size. |
| `viewer.py` | Builds the JSON a map page hands to `map.js`: overlays, markers (with status color and icon), shapes, the user's rights and the API addresses. |
| `cards.py` | The card shown when the mouse rests on a marker: which fields, and how each value is shown. |
| `assets.py`, `assets/` | Leaflet, `map.js` and `map.css`, served by the plugin itself. |
| `assets/map.js` | Draws a map and runs the editor. |
| `template_content.py` | **Show on map**, assigned maps on region/site/location pages, the rack's maps on rack pages. |
| `templatetags/netbox_map.py` | `{% map_asset %}`: an asset's address with the plugin version. |
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

## Drawing the map

`viewer.map_data()` collects what the browser needs, with the user's view
permissions applied (a marker whose object the user can't see is left
out). The page embeds it with `json_script` and calls
`NetBoxMap.render(element, data, options)`.

- **Coordinates:** stored as x/y, Leaflet wants `[lat, lng]` = `[y, x]`.
  `toLatLng()` and `fromLatLng()` in `map.js` are the only conversions.
- **Image-only maps** use `L.CRS.Simple`, so one map unit is one pixel of
  the image. An overlay without corners is drawn at `[0, 0]`–`[height,
  width]`.
- **Fitting:** everything placed is added to one bounds and the map starts
  with `fitBounds()`. A circle's bounds are worked out by hand, because
  Leaflet needs the map's view to compute them and the view isn't set yet.
  Permanent marker labels are bound after the view is set for the same
  reason.
- **Status colors:** markers use NetBox's own `text-bg-<color>` classes
  with the object's `get_status_color()`, so they match its badges and
  follow light and dark mode.
- **Tiles** are requested with `referrerPolicy: 'strict-origin-when-cross-origin'`.
  Django's default `Referrer-Policy: same-origin` would send no referrer,
  and OpenStreetMap blocks tile requests without one.
- `?marker=<id>` highlights one marker and zooms to it; **Show on map**
  links use it.
- **Zoom:** world maps go to level 22. The tile layer's `maxNativeZoom` is
  `max_zoom`, so Leaflet enlarges the last real tiles beyond it.
- **Start view:** `default_x`, `default_y` and `default_zoom` on the map,
  set together or not at all. The fit button goes back to it.
- **Place search** (`placeSearch()`): coordinates are parsed in the
  browser; anything else goes to `geocoder_url` (Nominatim's JSON API) with
  the same referrer policy as the tiles.

## Turned maps

Leaflet always draws north up, and the usual rotation add-ons patch
Leaflet's map internals. Instead, `turnedCrs()` wraps the CRS (EPSG:3857
or `CRS.Simple`) so its pixel space is the normal one rotated around the
origin. Markers, shapes, popups, dragging and clicks all go through the
CRS and need nothing more. Three things assume pixels run straight across
and get small subclasses:

- `TurnedTileLayer`: the visible area is turned back to pick tiles, each
  tile is placed at its turned corner and rotated with CSS. Tiles are
  drawn one pixel larger to hide seams. The tile grid is fixed at
  `2^zoom` tiles across, with the usual wrapping in longitude.
- `TurnedImageOverlay`: placed by its top-left corner with a CSS
  translate and rotate, during zoom animation too.
- `TurnedCircle`: Leaflet measures the radius along the x axis, which
  shrinks once turned; it is measured as a distance instead.

`map.getBoundsZoom` is replaced on turned maps so fitting measures all four
corners of the area, not two.

## Marker cards

`markers/<id>/card/` (`MarkerCardView`) renders
`inc/hover_card.html` from `cards.card_context()`. It uses NetBox's own
`card` and `attr-table` classes, so it follows NetBox's theme and any
theme plugin. `map.js` fetches it after the mouse rests on a marker for
200 ms, keeps it per marker, and places it beside the marker inside the
map. A rack's card has an `<img>` of NetBox's own elevation SVG
(`/api/dcim/racks/<id>/elevation/?render=svg`), so NetBox applies its own
permissions to it.

## Assets without collectstatic

Leaflet and `map.js` are served by `assets.asset()` from the package
folder, not as Django static files. Static files only reach NetBox's web
server through `collectstatic`, which a plugin installed into, or mounted
into, a container image after it was built never gets. The view serves a
fixed list of files with a week of browser caching; `{% map_asset %}` adds
the plugin version and the file's modification time to the address, so a
changed file is loaded at once.

## The editor

The editor saves through NetBox's REST API with the user's session, so
permissions, validation and change logging are exactly NetBox's. NetBox's
CSRF cookie is HttpOnly, so the token comes in the page data.

- Dragging a marker, overlay corner or overlay middle sends a `PATCH` on
  drag end.
- Drawing collects clicks and sends a `POST` to `shapes/` when finished,
  then reloads the page. A double-click adds its point twice; repeats are
  dropped. While a tool is on, the map gets `nbm-tool-on`, which lets
  clicks pass through existing shapes (their popups would stop the click).
- **Reshaping** (`startReshape()`): a handle per point, a smaller one per
  segment middle that adds a point when dragged, right-click to remove a
  point. Each change is a `PATCH` of `points` (or `radius`).
- Shapes have no add form: they are drawn on the map. Their edit form has
  no points field, and shows the radius only for circles.
- **Right-click menu** (`startContextMenu()`): devices, racks and maps are
  searched through NetBox's REST API (`viewer.SEARCHABLE`, limited to the
  map's scope with the matching `*_id` filter), labels are typed in place.
  The marker is created with a `POST`, then drawn from
  `markers/<id>/data/` (`MarkerDataView`), which returns the same data as
  the page, so the new marker has its status color without a reload.
- **Add marker** sends the user to the normal marker form with `map`, `x`
  and `y` filled in (NetBox fills form fields from the query string), so
  picking any object type works the same as everywhere else in NetBox.

## Other pages

`template_content.py` adds:

- `ShowOnMap.buttons()` on every object page (`models = None`). One query
  for the object's markers; a device or anything with `rack`, `location` or
  `site` falls back to those, in that order.
- `AssignedMaps.full_width_page()` on region, site group, site and location
  pages, and `RackMaps.right_page()` on rack pages, each a small read-only
  map.

## Tests

```bash
cd /opt/netbox/netbox
python manage.py test netbox_map
```

CI runs them on the oldest supported NetBox release.
