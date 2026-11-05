# Using maps

Everything is under **Maps** in the navigation bar.

## Maps

A map has a name and a **base layer**:

- **World map:** a real map of the world. Overlays, markers and shapes are
  placed by longitude and latitude.
- **Image only:** no world map. The overlay with the lowest weight is the
  background, and positions are pixels of that image.

Use *World map* when places on the map are far apart (a campus, a city, a
country) and *Image only* for a floor plan or a rack room.

**Parent** puts a map under another one: a floor under its building, a
building under its campus. The parent's page lists its submaps.

**Assigned to** ties the map to a region, site group, site or location.
If that object is deleted, the map stays and is no longer assigned.

## Overlays

An overlay is an image on the map: PNG, JPEG, GIF, WebP or SVG. SVG files
with scripts or embedded HTML are refused.

- **Opacity:** 100 is solid. Lower lets the map below show through, which
  helps when lining a floor plan up with a world map.
- **Weight:** overlays with a higher weight are drawn on top.
- **Corners:** where the image's left, bottom, right and top edges are on
  the map. Leave them empty to place the overlay later.

## Markers

A marker is one NetBox object at a point on the map, or a text label:

- **Object:** pick the type first (device, rack, site, location, map, ...)
  and then the object. A marker for another map opens that map.
- **Label:** shown instead of the object's name. A marker with no object
  needs one.
- **Icon** and **Color:** optional. The icon is a
  [Material Design Icons](https://pictogrammers.com/library/mdi/) name
  without the `mdi-` prefix.
- **Position:** x and y. Leave them empty to place the marker later.

Each object can be on a map once, and on any number of maps. When an object
is deleted from NetBox, its markers are removed from every map.

## Shapes

A shape is a **line**, an **area** or a **circle**, with an optional label
and a color. Its points are a list of `[x, y]` pairs: at least two for a
line, three for an area, and one (the center) for a circle. A circle's
radius is in meters on a world map and in pixels on an image-only map.

## Positions

Everything on a map uses the same x/y numbers:

| Base layer | x | y |
|---|---|---|
| World map | longitude, in degrees | latitude, in degrees |
| Image only | pixels from the left edge | pixels from the bottom edge |

## REST API

Everything is available under `/api/plugins/maps/`: `maps/`, `overlays/`,
`markers/` and `shapes/`. Overlay images are uploaded as
`multipart/form-data`. A marker's object is given as `object_type` (such as
`dcim.rack`) and `object_id`.
