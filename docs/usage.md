# Using maps

Everything is under **Maps** in the navigation bar.

## Viewing a map

A map's page shows the map itself, at its start view or zoomed to fit
everything on it. Drag to move around and scroll or use **+**/**−** to zoom.
The button under them goes back to the start view.

- Markers are colored by their object's status (the same colors as NetBox's
  status badges), unless the marker has a color of its own. Each shows its
  name below it. Racks are square, links to other maps are diamonds, and
  everything else is round.
- Rest the mouse on a marker, or on a cable route, to see a card with the
  object's details. Move the mouse onto the card to click its links. A
  rack's card shows its front elevation next to its details and the
  devices in it. Which details show is set in the
  [configuration](configuration.md).
- Click a marker for a link to its object. A diamond marker, or an area
  that opens a map, takes you to that map.
- Cable routes are thick lines in the cable's color, or its status color
  when it has none.
- On a turned map an arrow in the top-right corner points north.
- **↑ parent** in the card header goes up to the parent map.

### Side panel

The panel on the right of the map (the button in the map's top-right
corner shows or hides it) has:

- **Location:** the parent maps and the region, site or location the map
  is assigned to, as links.
- **Background:** on a world map, the background to show, such as
  Standard or Satellite.
- **Show:** switches to hide devices, racks, map links, labels, cables,
  areas, lines, circles or images.
- **Maps:** submaps and the maps this one links to.
- **Racks**, **Devices** and **Cables and circuits:** what is on the map.
  Click a name to zoom to it on the map, or the icon next to it to open its
  page. Long lists get a filter box.

The browser remembers the background, the switches and whether the panel
is open.

## Editing a map

**Edit map** in the map's card header turns on the editor. **Done** turns
it off. Everything is saved as you go.

| To | Do |
|---|---|
| Add a device, rack, map link or label | Right-click the spot, pick what to add, then pick it from the list (or type the label). Devices and racks are limited to the map's region, site or location when it has one. |
| Move a marker | Drag it. |
| Put a marker that has no position yet on the map | Click its name under **Not on the map yet**, then click the spot. |
| Add any other object | **Add marker**, click the spot, then pick the object in the form. |
| Draw a line or an area | **Line** or **Area**, click the points, then **Finish** or double-click the last point. A dashed line shows where the next click goes. **Undo** (or Backspace) removes the last point. |
| Draw a circle | **Circle**, click the center, then a point on the edge. |
| Draw a cable route | **Cable**, click the points along the route, **Finish**, then pick the cable, cable bundle or circuit it belongs to. |
| Attach a line's end to something | While drawing a line or cable, click on a marker (a ring shows it snaps), or on the edge of an area or circle. An end on a marker follows the marker when it is moved. |
| Jump to a place (world maps) | Type a city, an address, or a latitude and longitude such as `48.85, 2.35` in the box at the top right, then Enter. When several places match, pick one from the list. |
| Move a shape's points | Click the shape, then **Edit points**. Drag a point to move it, drag a small midpoint to add one, right-click a point to remove it. Click the map when done. |
| Move or resize a circle | Click it, then **Move or resize**, and drag the middle or the edge. |
| Label a shape, change its color or level, make an area open another map, or change a line's cable | Click the shape, then **Label, color, link** (**Label, color, route** on a line). |
| Delete a shape | Click it, then **Delete**. |
| Set where the map opens | Move and zoom the map, then **Set start view**. **Clear start view** goes back to fitting everything. |
| Turn the map | Type the angle next to the turn icon. 90 puts north on the right. |
| Add an image | **Add image**. On a world map, **Place in view** then puts it in the middle of what you see. |
| Move or stretch an image | Drag its round middle handle to move it, its square corner handles to stretch it. |
| Change an image's opacity | The slider next to its name. |

What a user can do follows their permissions: changing markers needs
`change` on Marker, drawing needs `add` on Shape, and so on.

Esc cancels the current tool.

## Maps on other pages

- **Show on map** appears on the page of any object that is on a map. It
  opens the map zoomed in on the object. A device that isn't on a map
  itself is shown through its rack, location or site, in that order.
- A region, site group, site or location page shows the maps assigned to
  it.
- A rack page shows the maps the rack is on, with the rack marked.

## Maps

A map has a name and a **base layer**:

- **World map:** a real map of the world. Overlays, markers and shapes are
  placed by longitude and latitude.
- **Image only:** no world map. The overlay with the lowest weight is the
  background, and positions are pixels of that image.

Use *World map* when places on the map are far apart (a campus, a city, a
country) and *Image only* for a floor plan or a rack room.

**Parent** puts a map under another one: a floor under its building, a
building under its campus. The parent's page lists its submaps. To get
from the parent map to a submap by clicking, add the submap to the parent
as a marker.

**Assigned to** ties the map to a region, site group, site or location.
If that object is deleted, the map stays and is no longer assigned.

**Rotation** turns the map clockwise by that many degrees, for a building
or a floor plan that doesn't run north to south. 0 keeps north up.

The **start view** (position and zoom the map opens at) is set from the map
editor. Without one, the map opens fitted to everything on it.

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
and a color. Shapes are drawn and reshaped on the map itself; the shape's
form only changes its label, color, link and (for a circle) radius.

**Level** is below ground, ground or above ground. A line is drawn
dashed where it runs under an area or circle on a higher level: draw a
street as an area on *Above ground*, and cables crossing it are dashed
there. Higher areas are also drawn over lower ones.

**Ends** (lines only): a line's first and last points can be attached to a
marker, or to an area or circle, by clicking on it while drawing. Lines
attached to the same two things are drawn side by side instead of on top
of each other. This is only on the map: nothing is connected in NetBox.

**Route of** (lines only) ties the line to a cable, cable bundle or
circuit. The line then shows that object's card and colors. When the
object is deleted from NetBox, the line stays as a plain line.

**Opens map** (areas and circles) makes the shape a link: clicking it opens that map, the same
as a map marker. Use it to make a building outline on a campus map lead to
the building's own map.

In the REST API, points are a list of `[x, y]` pairs: at least two for a
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
