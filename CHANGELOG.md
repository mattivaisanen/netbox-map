# Changelog

## Unreleased

New:

- Maps, with a world map or an image as the base layer. A map can sit under
  another map and be assigned to a region, site group, site or location.
- Overlays: PNG, JPEG, GIF, WebP or SVG images on a map, with opacity and
  drawing order.
- Markers: any NetBox object, another map, or a text label at a point on a
  map. An object can be on many maps.
- Shapes: lines, areas and circles on a map.
- The map drawn on its page with Leaflet, fitted to the window. Markers
  show their object's status color and name; a marker for another map
  opens it.
- A button under the zoom buttons goes back to the start view.
- Map editor: right-click the map to add a device, rack, map link or label
  right there, picked from a search list. Drag markers, place markers that
  have no position yet, draw lines, areas and circles, move and stretch
  images and change their opacity.
- **Show on map** on the page of every object on a map (devices fall back to
  their rack, location or site), assigned maps on region, site group, site
  and location pages, and the rack's maps on rack pages.
- Settings for the world map's tile server: `tile_url`, `tile_attribution`
  and `max_zoom`. Tile requests carry NetBox's address as the referrer, as
  OpenStreetMap's tile servers require.
- Pages to list, add, change and delete all of these, and a REST API under
  `/api/plugins/maps/`.
- Place search in the editor of world maps: a city, an address or a
  latitude and longitude, with a list to pick from when several places
  match. Set `geocoder_url` to use another search server.
- Background layers for world maps (Standard, Simple and Satellite by
  default), switched in the side panel and set with `base_layers`.
- Side panel beside the map: where the map is, the background, switches to
  hide kinds of things, linked maps, and the racks, devices and cables on
  the map.
- Cable routes: lines drawn on the map and tied to a cable, cable bundle
  or circuit, with that object's card on hover.
- Maps zoom further in, past the tile server's last level.
- Start view: a map can open at a saved position and zoom instead of fitted
  to everything.
- Maps can be turned, so north doesn't have to be up.
- Areas, lines and circles can open another map when clicked.
- Shape points are edited on the map: drag, add and remove points, move and
  resize circles. **Undo** removes the last point while drawing. The shape
  form keeps only label, color, link and, for circles, radius.
- Resting the mouse on a marker shows a card with the object's details in
  NetBox's style. Racks show their elevation next to their details and
  devices. The details are set with `hover_fields`.
- World maps zoom in whole steps, so map tiles stay sharp.
- Racks are drawn as squares and map links as diamonds.
- When an object is deleted from NetBox, its markers leave every map.
- `prepare_map_uninstall` removes NetBox's rows about maps before the plugin
  is uninstalled.
