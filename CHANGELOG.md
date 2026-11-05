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
- Pages to list, add, change and delete all of these, and a REST API under
  `/api/plugins/maps/`.
- When an object is deleted from NetBox, its markers leave every map.
- `prepare_map_uninstall` removes NetBox's rows about maps before the plugin
  is uninstalled.
