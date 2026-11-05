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
- A button under the zoom buttons brings the whole map back into view.
- Map editor: right-click the map to add a device, rack, map link or label
  right there, picked from a search list. Drag markers, place markers that have no position yet, draw
  lines, areas and circles, move and stretch images and change their
  opacity.
- **Show on map** on the page of every object on a map (devices fall back to
  their rack, location or site), assigned maps on region, site group, site
  and location pages, and the rack's maps on rack pages.
- Settings for the world map's tile server: `tile_url`, `tile_attribution`
  and `max_zoom`. Tile requests carry NetBox's address as the referrer, as
  OpenStreetMap's tile servers require.
- Pages to list, add, change and delete all of these, and a REST API under
  `/api/plugins/maps/`.
- When an object is deleted from NetBox, its markers leave every map.
- `prepare_map_uninstall` removes NetBox's rows about maps before the plugin
  is uninstalled.
