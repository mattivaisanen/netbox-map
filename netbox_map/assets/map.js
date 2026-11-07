/*
 * Draws a map with Leaflet and, on the map's own page, lets users edit it.
 *
 * NetBoxMap.render(element, data, options) draws one map. `data` comes from
 * viewer.py. Positions arrive as x/y and Leaflet wants [y, x], so every
 * conversion goes through toLatLng() and fromLatLng().
 *
 * Editing (options.edit) saves straight to NetBox's REST API with the
 * user's session: dragging a marker, drawing a shape, moving or stretching
 * an overlay. Anything bigger (labels, colors, objects) goes through the
 * normal NetBox forms.
 */
(function () {
  'use strict';

  // How far a world map zooms in, beyond the tile server's own levels.
  var MAX_ZOOM = 22;

  function toLatLng(x, y) { return L.latLng(y, x); }
  function fromLatLng(latlng) { return { x: latlng.lng, y: latlng.lat }; }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  // Set by render() from the page's data; NetBox's CSRF cookie can't be read from JavaScript.
  var csrfToken = '';
  // The `default_colors` setting, {kind: '#rrggbb'}; also set by render().
  var defaultColors = {};

  // One REST API call with the user's session. Resolves with the JSON
  // answer, rejects with NetBox's error text.
  function api(method, url, body) {
    return fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-CSRFToken': csrfToken },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (response) {
      if (response.status === 204) { return null; }
      return response.json().then(function (json) {
        if (!response.ok) { throw new Error(JSON.stringify(json)); }
        return json;
      });
    });
  }

  function failed(error) {
    window.alert('Saving failed: ' + error.message);
  }

  // A round pin with an icon: the marker's own color, else the default
  // color for its kind of object (setting), else the object's status color.
  function markerIcon(marker, highlighted) {
    var kind = { device: 'device', rack: 'rack', other: 'object' }[markerCategory(marker)];
    var color = marker.color || defaultColors[kind];
    var classes = 'nbm-pin';
    if (!color) { classes += ' text-bg-' + (marker.status || 'primary'); }
    if (marker.map_link) { classes += ' nbm-pin-link'; }
    if (marker.square) { classes += ' nbm-pin-square'; }
    if (highlighted) { classes += ' nbm-pin-highlight'; }
    var style = color ? ' style="background-color:' + color + ';color:#fff"' : '';
    return L.divIcon({
      className: 'nbm-marker',
      html: '<span class="' + classes + '"' + style + '><i class="mdi mdi-' + escapeHtml(marker.icon) + '"></i></span>',
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      tooltipAnchor: [0, 13],
      popupAnchor: [0, -15],
    });
  }

  // A small square drag handle, for overlay corners.
  function handleIcon(kind) {
    return L.divIcon({ className: 'nbm-handle nbm-handle-' + kind, iconSize: [14, 14], iconAnchor: [7, 7] });
  }

  function markerPopup(marker, edit) {
    var html = '<strong>' + escapeHtml(marker.label) + '</strong>';
    if (marker.type) { html += '<br><span class="text-secondary">' + escapeHtml(marker.type) + '</span>'; }
    var links = [];
    if (marker.url) { links.push('<a href="' + marker.url + '">' + (marker.map_link ? 'Open map' : 'Open') + '</a>'); }
    if (edit) { links.push('<a href="' + marker.edit_url + '">Edit</a>'); }
    if (links.length) { html += '<br>' + links.join(' · '); }
    return html;
  }

  // Draws one marker and remembers it in state.markers. Returns the layer,
  // or nothing for a marker without a position.
  function addMarker(state, marker, edit) {
    var data = state.data;
    if (marker.x == null || marker.y == null) { return null; }
    var highlighted = data.highlight === marker.id;
    var layer = L.marker(toLatLng(marker.x, marker.y), {
      icon: markerIcon(marker, highlighted),
      draggable: edit && data.can.change_marker,
      zIndexOffset: highlighted ? 1000 : 0,
      title: marker.label,
    }).addTo(state.map);
    layer.nbmLabel = marker.label;
    if (marker.map_link && marker.url && !edit) {
      layer.on('click', function () { window.location.href = marker.url; });
    } else {
      layer.bindPopup(markerPopup(marker, edit && data.can.change_marker));
    }
    // Lines attached to the marker follow it (NetBox saves the same when the marker is saved).
    layer.on('drag', function () { followAnchor(state, 'm' + marker.id, layer.getLatLng()); });
    layer.on('dragend', function () {
      api('PATCH', data.api.markers + marker.id + '/', fromLatLng(layer.getLatLng())).catch(failed);
    });
    var url = marker.object && cardUrl(state, 'marker', marker.id);
    if (url) { hoverCard(state, layer, function () { return { key: url, url: url }; }); }
    state.markers[marker.id] = layer;
    state.bounds.extend(layer.getLatLng());
    if (state.ready) { addLabel(layer); }
    return layer;
  }

  // The card shown when the mouse rests on a marker with an object, a
  // cable route, a bundle or a junction. `content(event)` says what it shows:
  // {key, url} for a card NetBox renders (cards.py), {key, html} for one
  // built here, plus `highlight`, spans to light up meanwhile; or null for
  // none. A rendered card starts loading as soon as the mouse arrives and is
  // kept. The mouse can move onto the card to follow its links: it closes a
  // moment after the mouse leaves both.
  var HOVER_DELAY = 150;

  function hoverCard(state, layer, content) {
    var timer = null;
    var pending = null;
    function start(event) {
      var what = content(event);
      if (!what || what.key === pending || (state.cardFor === layer && state.cardKey === what.key)) { return; }
      pending = what.key;
      if (what.url) { loadCard(state, what.url); }
      // Markers anchor the card at their point, lines where the mouse is.
      var anchor = layer.getLatLng ? layer.getLatLng() : event.latlng;
      clearTimeout(timer);
      timer = setTimeout(function () { pending = null; showCard(state, layer, what, anchor); }, HOVER_DELAY);
    }
    layer.on('mouseover', function (event) { cancelHide(state); start(event); });
    // Along a line, the part under the mouse (and so the card) can change.
    if (!layer.getLatLng) { layer.on('mousemove', start); }
    layer.on('mouseout', function () { clearTimeout(timer); pending = null; hideSoon(state); });
    layer.on('click dragstart', function () { clearTimeout(timer); pending = null; hideCard(state); });
  }

  function cardUrl(state, kind, id) {
    var base = state.data[kind + '_card_url'];
    return base ? base.replace('/0/', '/' + id + '/') : null;
  }

  // A rendered card's HTML (a promise), fetched once.
  function loadCard(state, url) {
    if (!state.cards[url]) {
      state.cards[url] = fetch(url, { credentials: 'same-origin' })
        .then(function (response) { return response.ok ? response.text() : ''; })
        .catch(function () { return ''; });
    }
    return state.cards[url];
  }

  function showCard(state, layer, what, anchor) {
    if (!state.card) {
      state.card = L.DomUtil.create('div', 'nbm-hover', state.map.getContainer());
      L.DomEvent.disableClickPropagation(state.card);
      L.DomEvent.disableScrollPropagation(state.card);
      L.DomEvent.on(state.card, 'mouseenter', function () { cancelHide(state); });
      L.DomEvent.on(state.card, 'mouseleave', function () { hideSoon(state); });
      state.map.on('movestart zoomstart', function () { hideCard(state); });
    }
    state.cardFor = layer;
    state.cardKey = what.key;
    function fill(html) {
      if (state.cardFor !== layer || state.cardKey !== what.key || !html) { return; }
      state.card.innerHTML = html;
      state.card.style.display = 'block';
      placeCard(state, anchor);
      if (what.highlight) { highlight(state, what.highlight); } else { unhighlight(state); }
      // A rack elevation changes the card's size once it has loaded.
      state.card.querySelectorAll('img').forEach(function (img) {
        img.addEventListener('load', function () { placeCard(state, anchor); });
      });
    }
    if (what.html) { fill(what.html); } else { loadCard(state, what.url).then(fill); }
  }

  // Beside the anchor point, on whichever side has room, and inside the map.
  function placeCard(state, anchor) {
    var card = state.card;
    var size = state.map.getSize();
    var point = state.map.latLngToContainerPoint(anchor);
    var left = point.x + 20;
    if (left + card.offsetWidth > size.x - 8) { left = point.x - 20 - card.offsetWidth; }
    var top = Math.min(point.y - 24, size.y - card.offsetHeight - 8);
    card.style.left = Math.max(8, left) + 'px';
    card.style.top = Math.max(8, top) + 'px';
  }

  function hideSoon(state) {
    cancelHide(state);
    state.cardHide = setTimeout(function () { hideCard(state); }, 300);
  }

  function cancelHide(state) { clearTimeout(state.cardHide); }

  function hideCard(state) {
    cancelHide(state);
    state.cardFor = null;
    state.cardKey = null;
    unhighlight(state);
    if (state.card) { state.card.style.display = 'none'; }
  }

  function addLabel(layer) {
    layer.bindTooltip(escapeHtml(layer.nbmLabel), { permanent: true, direction: 'bottom', className: 'nbm-label' });
  }

  // A button under + and − that brings the whole map back into view.
  function fitButton(fitAll, hasStartView) {
    var Control = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        var bar = L.DomUtil.create('div', 'leaflet-bar');
        var button = L.DomUtil.create('a', 'nbm-fit', bar);
        button.href = '#';
        var title = hasStartView ? 'Back to the start view' : 'Show the whole map';
        button.title = title;
        button.setAttribute('role', 'button');
        button.setAttribute('aria-label', title);
        button.innerHTML = '<i class="mdi mdi-fit-to-screen-outline"></i>';
        L.DomEvent.disableClickPropagation(button);
        L.DomEvent.on(button, 'click', function (event) { L.DomEvent.preventDefault(event); fitAll(); });
        return bar;
      },
    });
    return new Control();
  }

  //
  // Turned maps
  //
  // Leaflet always draws north up. A turned map gets a coordinate system
  // whose pixel space is the normal one rotated around its origin, so
  // everything Leaflet positions by pixels (markers, shapes, popups, mouse
  // clicks) lands in the right place without further help. Three things
  // assume pixels run straight across and are adjusted below: map tiles,
  // overlay images and circles.

  // Rotates a pixel point clockwise by the angle with sine `sin` and cosine `cos`.
  function turn(point, sin, cos) {
    return L.point(point.x * cos - point.y * sin, point.x * sin + point.y * cos);
  }

  // A copy of `base` (a Leaflet CRS) with its pixel space turned clockwise by `degrees`.
  function turnedCrs(base, degrees) {
    var rad = degrees * Math.PI / 180;
    var sin = Math.sin(rad);
    var cos = Math.cos(rad);
    var inner = base.transformation;
    var transformation = {
      _transform: function (point, scale) {
        var p = turn(inner._transform(point, scale), sin, cos);
        point.x = p.x;
        point.y = p.y;
        return point;
      },
      transform: function (point, scale) { return this._transform(point.clone(), scale); },
      untransform: function (point, scale) { return inner.untransform(turn(point, -sin, cos), scale); },
    };
    return L.Util.extend({}, base, { transformation: transformation, nbmSin: sin, nbmCos: cos, nbmDegrees: degrees });
  }

  // Background tiles. Each tile is drawn one pixel larger than it is: at
  // half zoom steps the browser rounds tile edges, which otherwise leaves
  // hairline gaps (a grid) between them. A layer can also be moved a few
  // meters to line up with the other layers (setOffset).
  var MapTileLayer = L.TileLayer.extend({
    nbmOffset: null,   // [east, north] in meters

    // Moves the layer, including the tiles already shown.
    setOffset: function (offset) {
      this.nbmOffset = offset;
      if (!this._map || !this._tiles) { return this; }
      var self = this;
      Object.keys(this._tiles).forEach(function (key) {
        var tile = self._tiles[key];
        self._placeTile(tile.el, tile.coords);
      });
      this._update();
      return this;
    },

    // The offset in pixels at `zoom`, measured where the map was when first
    // needed (a few meters hardly change across a view).
    _shift: function (zoom) {
      var o = this.nbmOffset;
      if (!o || (!o[0] && !o[1]) || !this._map || zoom === undefined) { return L.point(0, 0); }
      var map = this._map;
      if (!this.nbmRef) { this.nbmRef = map.getCenter(); }
      var c = this.nbmRef;
      var to = L.latLng(c.lat + o[1] / 111320, c.lng + o[0] / (111320 * Math.cos(c.lat * Math.PI / 180)));
      return map.project(to, zoom).subtract(map.project(c, zoom));
    },

    // Tiles to load: the view, moved back by the offset.
    _getTiledPixelBounds: function (center) {
      var b = L.TileLayer.prototype._getTiledPixelBounds.call(this, center);
      var s = this._shift(this._tileZoom);
      return this._tileSpace(L.bounds(b.min.subtract(s), b.max.subtract(s)));
    },
    _tileSpace: function (bounds) { return bounds; },

    _getTilePos: function (coords) { return this._tilePos(coords).add(this._shift(coords.z)); },
    _tilePos: function (coords) { return L.TileLayer.prototype._getTilePos.call(this, coords); },
    _placeTile: function (el, coords) { L.DomUtil.setPosition(el, this._getTilePos(coords)); },

    _initTile: function (tile) {
      L.TileLayer.prototype._initTile.call(this, tile);
      var size = this.getTileSize();
      tile.style.width = (size.x + 1) + 'px';
      tile.style.height = (size.y + 1) + 'px';
    },
  });

  // Map tiles on a turned map. Leaflet works out which tiles to load and
  // where to put them in straight pixels; here the visible area is turned
  // back to straight pixels to pick the tiles, and each tile is placed at
  // its turned position and turned itself.
  var TurnedTileLayer = MapTileLayer.extend({
    _crs: function () { return this._map.options.crs; },
    _straight: function (point) { var c = this._crs(); return turn(point, -c.nbmSin, c.nbmCos); },
    _tileSpace: function (b) {
      var self = this;
      return L.bounds([b.min, b.max, b.getTopRight(), b.getBottomLeft()].map(function (p) { return self._straight(p); }));
    },
    _resetGrid: function () {
      L.TileLayer.prototype._resetGrid.call(this);
      // The world is 2^zoom tiles across in straight pixels.
      var count = Math.pow(2, this._tileZoom);
      this._globalTileRange = L.bounds([0, 0], [count - 1, count - 1]);
      this._wrapX = !this.options.noWrap && [0, count];
      this._wrapY = false;
    },
    _tilePos: function (coords) {
      var c = this._crs();
      return turn(coords.scaleBy(this.getTileSize()), c.nbmSin, c.nbmCos).subtract(this._level.origin);
    },
    _addTile: function (coords, container) {
      L.TileLayer.prototype._addTile.call(this, coords, container);
      this._placeTile(this._tiles[this._tileCoordsToKey(coords)].el, coords);
    },
    _placeTile: function (el, coords) {
      L.DomUtil.setPosition(el, this._getTilePos(coords));
      el.style.transformOrigin = '0 0';
      el.style.transform += ' rotate(' + this._crs().nbmDegrees + 'deg)';
    },
  });

  // An overlay image on a turned map: placed by its top-left corner and
  // turned with the map. (Leaflet's own only moves and scales.)
  var TurnedImageOverlay = L.ImageOverlay.extend({
    _place: function (toPoint) {
      var b = this._bounds;
      var nw = toPoint(b.getNorthWest());
      var ne = toPoint(b.getNorthEast());
      var sw = toPoint(b.getSouthWest());
      var image = this._image;
      image.style.width = nw.distanceTo(ne) + 'px';
      image.style.height = nw.distanceTo(sw) + 'px';
      image.style.transformOrigin = '0 0';
      image.style.transform = 'translate3d(' + nw.x + 'px,' + nw.y + 'px,0) rotate(' +
        Math.atan2(ne.y - nw.y, ne.x - nw.x) + 'rad)';
    },
    _reset: function () {
      var map = this._map;
      this._place(function (latlng) { return map.latLngToLayerPoint(latlng); });
    },
    _animateZoom: function (e) {
      var map = this._map;
      this._place(function (latlng) { return map._latLngToNewLayerPoint(latlng, e.zoom, e.center); });
    },
  });

  // A circle keeps its size on a turned map: Leaflet measures the radius
  // straight across, which shrinks once the map is turned.
  var TurnedCircle = L.Circle.extend({
    _project: function () {
      L.Circle.prototype._project.call(this);
      var map = this._map;
      var edge = map.options.crs.distance === L.CRS.Earth.distance
        ? [this._latlng.lat + (this._mRadius / L.CRS.Earth.R) * 180 / Math.PI, this._latlng.lng]
        : [this._latlng.lat + this._mRadius, this._latlng.lng];
      this._radius = this._radiusY = this._point.distanceTo(map.latLngToLayerPoint(edge));
      this._updateBounds();
    },
  });

  // Leaflet sizes a fit from two corners of the area, which on a turned map
  // isn't the whole area: measure all four instead.
  function getBoundsZoom(bounds, inside, padding) {
    bounds = L.latLngBounds(bounds);
    padding = L.point(padding || [0, 0]);
    var map = this;
    var zoom = map.getZoom() || 0;
    var corners = [bounds.getNorthWest(), bounds.getNorthEast(), bounds.getSouthWest(), bounds.getSouthEast()];
    var area = L.bounds(corners.map(function (c) { return map.project(c, zoom); })).getSize();
    var size = map.getSize().subtract(padding);
    var scale = (inside ? Math.max : Math.min)(size.x / area.x, size.y / area.y);
    var snap = map.options.zoomSnap;
    zoom = map.getScaleZoom(scale, zoom);
    if (snap) {
      zoom = Math.round(zoom / (snap / 100)) * (snap / 100);
      zoom = inside ? Math.ceil(zoom / snap) * snap : Math.floor(zoom / snap) * snap;
    }
    return Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), zoom));
  }

  // A small arrow that points north, shown on turned maps.
  function northArrow(degrees) {
    var Control = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        var bar = L.DomUtil.create('div', 'leaflet-bar nbm-north');
        bar.title = 'North';
        bar.innerHTML = '<i class="mdi mdi-arrow-up-bold" style="transform: rotate(' + degrees + 'deg)"></i>';
        return bar;
      },
    });
    return new Control();
  }

  //
  // Lines
  //
  // A line is drawn twice: a see-through "hit" line that takes the mouse
  // (popups, cards, editing), and what is seen, in solid and dashed pieces.
  // A piece is dashed where the line runs under an area or circle on a
  // higher level.
  //
  // A line can be attached to markers and junctions on its way ("anchors").
  // Between two anchors it runs in a "span". Lines that span the same two
  // anchors run side by side, each in its own lane; past BUNDLE_AT lines
  // they are drawn as one thick bundle. The mouse on such lines shows them
  // all as one bundle. Everything is worked out again whenever a line or an
  // area changes.

  // Lanes are this many pixels apart (a cable route's width plus a gap).
  var LANE = 7;
  // More lines than this between the same two anchors are drawn as one bundle.
  var BUNDLE_AT = 8;

  // The see-through line. Its points are the line's own; when the line is
  // curved, the mouse is caught along the curve (nbmPath) instead.
  var HitLine = L.Polyline.extend({
    setLatLngs: function (latlngs) {
      L.Polyline.prototype.setLatLngs.call(this, latlngs);
      if (this.nbmRedraw) { this.nbmRedraw(); }
      return this;
    },
    _project: function () {
      var own = this._latlngs;
      if (this.nbmPath) { this._latlngs = this.nbmPath; }
      L.Polyline.prototype._project.call(this);
      this._latlngs = own;
    },
  });

  // Steps per curved piece of a line.
  var CURVE_STEPS = 12;

  // The path a line is drawn along: its points, with curves through its
  // smooth points (`data.smooth`). Returns {latlngs, index}, where index[i]
  // is where the line's point i is in latlngs. A curve is a cubic Hermite
  // piece per segment, worked out in zoom-0 pixels: through a smooth point
  // it keeps the direction from the point before to the point after
  // (Catmull-Rom); at a sharp point it heads straight for its neighbor, so
  // two sharp ends give a straight piece.
  function linePath(state, entry) {
    var latlngs = entry.layer.getLatLngs();
    var n = latlngs.length;
    var smooth = (entry.data.smooth || []).filter(function (i) { return i > 0 && i < n - 1; });
    if (!smooth.length) {
      return { latlngs: latlngs, index: latlngs.map(function (p, i) { return i; }) };
    }
    var map = state.map;
    var p = latlngs.map(function (ll) { return map.project(ll, 0); });
    function isSmooth(i) { return smooth.indexOf(i) >= 0; }
    function tangent(i, leaving) {
      if (isSmooth(i)) { return p[i + 1].subtract(p[i - 1]).multiplyBy(0.5); }
      return leaving ? p[i + 1].subtract(p[i]) : p[i].subtract(p[i - 1]);
    }
    var path = [latlngs[0]];
    var index = [0];
    for (var i = 0; i < n - 1; i++) {
      if (isSmooth(i) || isSmooth(i + 1)) {
        var a = p[i], b = p[i + 1], ta = tangent(i, true), tb = tangent(i + 1, false);
        for (var k = 1; k < CURVE_STEPS; k++) {
          var t = k / CURVE_STEPS, t2 = t * t, t3 = t2 * t;
          var h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
          path.push(map.unproject(L.point(
            h00 * a.x + h10 * ta.x + h01 * b.x + h11 * tb.x,
            h00 * a.y + h10 * ta.y + h01 * b.y + h11 * tb.y), 0));
        }
      }
      path.push(latlngs[i + 1]);
      index.push(path.length - 1);
    }
    return { latlngs: path, index: index };
  }

  // The drawn path of one span of a line.
  function spanPath(entry, span) {
    var path = entry.path;
    return path.latlngs.slice(path.index[span.from], path.index[span.to] + 1);
  }

  // A polyline drawn `offset` pixels to the left of its points.
  var OffsetLine = L.Polyline.extend({
    _project: function () {
      L.Polyline.prototype._project.call(this);
      var offset = this.options.offset || 0;
      if (!offset || !this._rings) { return; }
      this._rings = this._rings.map(function (ring) { return offsetRing(ring, offset); });
      if (this._pxBounds) {
        var pad = L.point(Math.abs(offset), Math.abs(offset));
        this._pxBounds = L.bounds(this._pxBounds.min.subtract(pad), this._pxBounds.max.add(pad));
      }
    },
  });

  // Moves each point of a pixel ring sideways by d. At a corner the point
  // moves along the average of both segments' normals, far enough that both
  // segments stay d away (capped on very sharp corners).
  function offsetRing(ring, d) {
    var n = ring.length;
    if (n < 2) { return ring; }
    var normals = [];
    for (var i = 0; i < n - 1; i++) {
      var dx = ring[i + 1].x - ring[i].x;
      var dy = ring[i + 1].y - ring[i].y;
      var length = Math.hypot(dx, dy) || 1;
      normals.push(L.point(-dy / length, dx / length));
    }
    return ring.map(function (point, i) {
      var a = normals[Math.max(0, i - 1)];
      var b = normals[Math.min(n - 2, i)];
      var mx = a.x + b.x;
      var my = a.y + b.y;
      var length = Math.hypot(mx, my);
      if (length < 1e-6) { mx = a.x; my = a.y; length = 1; }
      mx /= length;
      my /= length;
      var scale = d / Math.max(mx * a.x + my * a.y, 0.33);
      return L.point(point.x + mx * scale, point.y + my * scale);
    });
  }

  // The color a new shape gets. A shape still in it is drawn in the default
  // color for its kind when one is set, and a cable route in its cable's
  // color, until it is given a color of its own.
  var DEFAULT_COLOR = '#2196f3';

  function hasOwnColor(shape) { return !!shape.color && shape.color.toLowerCase() !== DEFAULT_COLOR; }

  function shapeColor(shape) {
    return hasOwnColor(shape) ? shape.color : (defaultColors[shape.kind] || shape.color);
  }

  // Colors and width of a line. A cable route is drawn in its own color when
  // it has been given one, else its cable's color, else the default cable
  // color, else its status color (through a class); other lines in theirs.
  function lineStyle(shape) {
    var style = { color: shapeColor(shape), weight: 3, className: '' };
    if (shape.object) {
      style.weight = 5;
      if (hasOwnColor(shape)) { return style; }
      style.color = shape.route_color || defaultColors.cable || '#6c757d';
      if (!shape.route_color && !defaultColors.cable && shape.status) { style.className = 'nbm-route nbm-route-' + shape.status; }
    }
    return style;
  }

  // Dashes for a line `weight` pixels wide: long enough not to look dotted.
  function dashes(weight) { return (weight * 3) + ' ' + (weight * 2); }

  function eachLine(state, callback) {
    Object.keys(state.shapes).forEach(function (id) {
      if (state.shapes[id].visual) { callback(state.shapes[id]); }
    });
  }

  // 'm<id>' for a marker, 's<id>' for a shape.
  function anchorKey(target) { return target.marker ? 'm' + target.marker : 's' + target.shape; }

  // A line's anchors in point order: [{index, key}].
  function anchorsOf(entry) {
    var ends = entry.data.ends || {};
    var last = entry.layer.getLatLngs().length - 1;
    var anchors = [];
    if (ends.start) { anchors.push({ index: 0, key: anchorKey(ends.start) }); }
    (ends.via || []).forEach(function (via) {
      if (via.point > 0 && via.point < last) { anchors.push({ index: via.point, key: anchorKey(via) }); }
    });
    if (ends.end && last > 0) { anchors.push({ index: last, key: anchorKey(ends.end) }); }
    return anchors.sort(function (a, b) { return a.index - b.index; });
  }

  // Splits every line into spans at its anchors, and gives lines spanning
  // the same two anchors a lane each: ..., -1, 0, 1, ... (half lanes for an
  // even count). Lines drawn the other way round take the other side, so
  // the lanes match.
  function assignLanes(state) {
    var groups = {};
    eachLine(state, function (entry) {
      var last = entry.layer.getLatLngs().length - 1;
      var keys = {};
      var cuts = [0, last];
      anchorsOf(entry).forEach(function (anchor) { keys[anchor.index] = anchor.key; cuts.push(anchor.index); });
      cuts = cuts.filter(function (c, i) { return cuts.indexOf(c) === i; }).sort(function (a, b) { return a - b; });
      entry.spans = [];
      entry.drawnPoints = last + 1;
      for (var i = 0; i < cuts.length - 1; i++) {
        var span = { from: cuts[i], to: cuts[i + 1], lane: 0, group: null };
        var a = keys[span.from];
        var b = keys[span.to];
        if (a && b && a !== b) {
          span.sign = a < b ? 1 : -1;
          span.group = a < b ? a + '|' + b : b + '|' + a;
          (groups[span.group] = groups[span.group] || []).push({ entry: entry, span: span });
        }
        entry.spans.push(span);
      }
    });
    Object.keys(groups).forEach(function (key) {
      var members = groups[key].sort(function (x, y) { return x.entry.data.id - y.entry.data.id; });
      members.forEach(function (member, i) {
        member.span.lane = (i - (members.length - 1) / 2) * member.span.sign;
        member.span.bundled = members.length > BUNDLE_AT;
        member.span.leader = i === 0;
      });
    });
    state.groups = groups;
    sizeJunctions(state);
  }

  // A junction grows with the lines running through it, so it covers the
  // turns lines make as they change lanes inside it.
  function sizeJunctions(state) {
    Object.keys(state.shapes).forEach(function (id) {
      var entry = state.shapes[id];
      if (entry.data.kind !== 'junction') { return; }
      var widest = 1;
      Object.keys(state.groups).forEach(function (key) {
        if (key.split('|').indexOf('s' + id) < 0) { return; }
        var count = state.groups[key].length;
        widest = Math.max(widest, count > BUNDLE_AT ? 2 : count);
      });
      entry.layer.setRadius(Math.min(30, Math.max(7, widest * LANE / 2 + 4)));
    });
  }

  // Works out lanes and draws every line again.
  function relayout(state) {
    assignLanes(state);
    drawAllLines(state);
  }

  // Splits points of a line into pieces that are under a higher area or
  // circle and pieces that aren't. Worked out in pixels at zoom 0 (the same
  // for any view).
  function linePieces(state, entry, latlngs) {
    var map = state.map;
    function px(latlng) { return map.project(latlng, 0); }
    var covers = [];
    Object.keys(state.shapes).forEach(function (id) {
      var other = state.shapes[id];
      if ((other.data.level || 0) <= (entry.data.level || 0) || !map.hasLayer(other.layer)) { return; }
      if (other.data.kind === 'area') {
        covers.push({ ring: other.layer.getLatLngs()[0].map(px) });
      } else if (other.data.kind === 'circle') {
        var c = other.layer.getLatLng();
        var r = other.layer.getRadius();
        var edge = state.data.image_only ? L.latLng(c.lat + r, c.lng) : L.latLng(c.lat + r / 111320, c.lng);
        covers.push({ center: px(c), radius: px(c).distanceTo(px(edge)) });
      }
    });
    if (!covers.length || latlngs.length < 2) { return [{ latlngs: latlngs, under: false }]; }

    var pieces = [];
    var current = null;
    for (var i = 0; i < latlngs.length - 1; i++) {
      var a = px(latlngs[i]);
      var b = px(latlngs[i + 1]);
      var ts = [0, 1];
      covers.forEach(function (cover) { ts = ts.concat(crossings(a, b, cover)); });
      ts.sort(function (x, y) { return x - y; });
      for (var j = 0; j < ts.length - 1; j++) {
        if (ts[j + 1] - ts[j] < 1e-9) { continue; }
        var middle = along(a, b, (ts[j] + ts[j + 1]) / 2);
        var under = covers.some(function (cover) { return inside(middle, cover); });
        var from = map.unproject(along(a, b, ts[j]), 0);
        var to = map.unproject(along(a, b, ts[j + 1]), 0);
        if (!current || current.under !== under) {
          current = { under: under, latlngs: [from] };
          pieces.push(current);
        }
        current.latlngs.push(to);
      }
    }
    return pieces;
  }

  function along(a, b, t) { return L.point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t); }

  // Where (0..1 along a→b) the segment crosses an area's or circle's outline.
  function crossings(a, b, cover) {
    var ts = [];
    if (cover.ring) {
      var ring = cover.ring;
      for (var i = 0; i < ring.length; i++) {
        var c = ring[i];
        var d = ring[(i + 1) % ring.length];
        var rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
        var den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-12) { continue; }
        var t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
        var u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
        if (u >= 0 && u <= 1) { ts.push(t); }
      }
    } else {
      var dx = b.x - a.x, dy = b.y - a.y, fx = a.x - cover.center.x, fy = a.y - cover.center.y;
      var A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - cover.radius * cover.radius;
      var disc = B * B - 4 * A * C;
      if (A > 0 && disc > 0) {
        var root = Math.sqrt(disc);
        ts.push((-B - root) / (2 * A), (-B + root) / (2 * A));
      }
    }
    return ts.filter(function (t) { return t > 0 && t < 1; });
  }

  function inside(point, cover) {
    if (!cover.ring) { return point.distanceTo(cover.center) < cover.radius; }
    var ring = cover.ring;
    var result = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if ((ring[i].y > point.y) !== (ring[j].y > point.y) &&
          point.x < (ring[j].x - ring[i].x) * (point.y - ring[i].y) / (ring[j].y - ring[i].y) + ring[i].x) {
        result = !result;
      }
    }
    return result;
  }

  // How one span of a line looks: its own style in its lane, or, when
  // bundled, the bundle's (drawn once, by the bundle's first line).
  function spanStyle(entry, span) {
    if (!span.bundled) {
      return L.Util.extend(lineStyle(entry.data), { offset: span.lane * LANE });
    }
    return span.leader ? { color: '#5f6b7a', weight: 11, className: 'nbm-bundle', offset: 0 } : null;
  }

  // Draws (again) what is seen of one line.
  function drawLine(state, entry) {
    entry.path = linePath(state, entry);
    var curved = entry.path.latlngs.length !== entry.layer.getLatLngs().length;
    if (curved || entry.layer.nbmPath) {
      entry.layer.nbmPath = curved ? entry.path.latlngs : null;
      if (state.map.hasLayer(entry.layer)) { entry.layer.redraw(); }
    }
    entry.visual.clearLayers();
    (entry.spans || []).forEach(function (span) {
      var style = spanStyle(entry, span);
      if (!style) { return; }
      linePieces(state, entry, spanPath(entry, span)).forEach(function (piece) {
        new OffsetLine(piece.latlngs, L.Util.extend({}, style, {
          interactive: false, pane: 'nbmLines', dashArray: piece.under ? dashes(style.weight) : null, lineCap: piece.under ? 'butt' : 'round',
        })).addTo(entry.visual);
      });
    });
  }

  function drawAllLines(state) {
    eachLine(state, function (entry) { drawLine(state, entry); });
  }

  // Moves the points of lines attached to a marker or junction (`key`, see
  // anchorKey) to where it is now.
  function followAnchor(state, key, latlng) {
    eachLine(state, function (entry) {
      var indexes = anchorsOf(entry).filter(function (a) { return a.key === key; });
      if (!indexes.length) { return; }
      var points = entry.layer.getLatLngs().slice();
      indexes.forEach(function (anchor) { points[anchor.index] = latlng; });
      entry.layer.setLatLngs(points);
    });
  }

  // The span of a line nearest to `latlng`.
  function spanAt(state, entry, latlng) {
    var map = state.map;
    var mouse = map.latLngToLayerPoint(latlng);
    var path = entry.path || linePath(state, entry);
    var points = path.latlngs.map(function (ll) { return map.latLngToLayerPoint(ll); });
    var best = null;
    var nearest = Infinity;
    (entry.spans || []).forEach(function (span) {
      for (var i = path.index[span.from]; i < path.index[span.to]; i++) {
        var distance = L.LineUtil.pointToSegmentDistance(mouse, points[i], points[i + 1]);
        if (distance < nearest) { nearest = distance; best = span; }
      }
    });
    return best;
  }

  // The name of what an anchor is: a marker's label or a junction's.
  function anchorName(state, key) {
    var id = key.slice(1);
    if (key[0] === 'm') { return state.markers[id] ? state.markers[id].nbmLabel : '?'; }
    var shape = state.shapes[id];
    return shape ? (shape.data.label || 'junction') : '?';
  }

  // A card listing lines (cables, bundles, circuits), built here from the
  // map's own data, so it shows at once. With no `entries`, just the title.
  function listCard(title, entries) {
    var header = '<div class="card mb-0 nbm-card"><div class="card-header py-2"><h5 class="card-title mb-0">' +
      escapeHtml(title) + '</h5></div>';
    if (!entries) { return header + '</div>'; }
    var rows = entries.map(function (entry) {
      var s = entry.data;
      var style = lineStyle(s);
      var dot = style.className
        ? '<span class="nbm-dot text-bg-' + escapeHtml(s.status) + '"></span>'
        : '<span class="nbm-dot" style="background:' + escapeHtml(style.color) + '"></span>';
      var name = escapeHtml(s.route_name || s.label || 'Line');
      var link = s.route_url ? '<a href="' + s.route_url + '" class="text-truncate">' + name + '</a>' : '<span class="text-truncate">' + name + '</span>';
      var kind = s.route_type ? '<span class="text-secondary small ms-auto text-nowrap">' + escapeHtml(s.route_type) + '</span>' : '';
      return '<div class="list-group-item d-flex align-items-center gap-2 px-3 py-1">' + dot + link + kind + '</div>';
    });
    if (!rows.length) { rows.push('<div class="list-group-item text-secondary px-3 py-1">No cables yet</div>'); }
    return header + '<div class="list-group list-group-flush nbm-card-list">' + rows.join('') + '</div></div>';
  }

  function plural(count, one, many) { return count + ' ' + (count === 1 ? one : many); }

  // What the card shows for the part of a line under the mouse: a bundle's
  // list when other lines run alongside, else the line's own card.
  function lineCard(state, entry, latlng) {
    var span = spanAt(state, entry, latlng);
    var members = span && span.group ? state.groups[span.group] : null;
    if (members && members.length > 1) {
      var ends = span.group.split('|');
      var title = plural(members.length, 'cable', 'cables') + ' between ' + anchorName(state, ends[0]) + ' and ' + anchorName(state, ends[1]);
      return {
        key: 'group:' + span.group,
        html: listCard(title, members.map(function (m) { return m.entry; })),
        highlight: members,
      };
    }
    var url = entry.data.object && cardUrl(state, 'shape', entry.data.id);
    return url ? { key: url, url: url } : null;
  }

  // The card of a junction: the lines running through it.
  function junctionCard(state, entry) {
    var key = 's' + entry.data.id;
    var lines = [];
    var spans = [];
    eachLine(state, function (line) {
      if (!anchorsOf(line).some(function (a) { return a.key === key; })) { return; }
      lines.push(line);
      line.spans.forEach(function (span) { spans.push({ entry: line, span: span }); });
    });
    var title = (entry.data.label || 'Junction') + ': ' + plural(lines.length, 'cable', 'cables');
    return { key: 'junction:' + entry.data.id, html: listCard(title, lines), highlight: spans };
  }

  // Lights up spans ([{entry, span}]) under the mouse, behind the lines.
  function highlight(state, spans) {
    unhighlight(state);
    state.halo = L.layerGroup().addTo(state.map);
    spans.forEach(function (member) {
      var style = spanStyle(member.entry, member.span);
      if (!style) { return; }
      new OffsetLine(spanPath(member.entry, member.span), {
        offset: style.offset, weight: style.weight + 8, color: '#ffc107', opacity: 0.55,
        interactive: false, pane: 'nbmHalo',
      }).addTo(state.halo);
    });
  }

  function unhighlight(state) {
    if (state.halo) { state.map.removeLayer(state.halo); state.halo = null; }
  }

  // Where a line drawn or reshaped at `mouse` (container pixels) snaps to: a
  // marker or junction near it (its middle), or the outline of an area or
  // circle. Returns {latlng, anchor} or null.
  var SNAP_PIXELS = 14;
  var SNAP_MARKER_PIXELS = 22;
  function snapTarget(state, mouse) {
    var map = state.map;
    var best = null;
    function consider(distance, limit, latlng, anchor) {
      if (distance < limit && (!best || distance < best.distance)) {
        best = { distance: distance, latlng: latlng, anchor: anchor };
      }
    }
    Object.keys(state.markers).forEach(function (id) {
      var layer = state.markers[id];
      if (!map.hasLayer(layer)) { return; }
      consider(map.latLngToContainerPoint(layer.getLatLng()).distanceTo(mouse), SNAP_MARKER_PIXELS,
        layer.getLatLng(), { marker: parseInt(id, 10) });
    });
    Object.keys(state.shapes).forEach(function (id) {
      var shape = state.shapes[id];
      if (!map.hasLayer(shape.layer) || shape.data.kind !== 'junction') { return; }
      consider(map.latLngToContainerPoint(shape.layer.getLatLng()).distanceTo(mouse), SNAP_MARKER_PIXELS,
        shape.layer.getLatLng(), { shape: parseInt(id, 10) });
    });
    if (best) { return best; }
    Object.keys(state.shapes).forEach(function (id) {
      var shape = state.shapes[id];
      if (!map.hasLayer(shape.layer) || (shape.data.kind !== 'area' && shape.data.kind !== 'circle')) { return; }
      var point = nearestOnOutline(map, shape, mouse);
      consider(point.distanceTo(mouse), SNAP_PIXELS, map.containerPointToLatLng(point), { shape: parseInt(id, 10) });
    });
    return best;
  }

  // The point on an area's or circle's outline nearest to `mouse` (container pixels).
  function nearestOnOutline(map, shape, mouse) {
    if (shape.data.kind === 'circle') {
      var center = map.latLngToContainerPoint(shape.layer.getLatLng());
      var radius = shape.layer._radius || 0;
      var away = mouse.subtract(center);
      var length = Math.hypot(away.x, away.y) || 1;
      return center.add(away.multiplyBy(radius / length));
    }
    var ring = shape.layer.getLatLngs()[0].map(function (ll) { return map.latLngToContainerPoint(ll); });
    var best = null;
    ring.forEach(function (a, i) {
      var b = ring[(i + 1) % ring.length];
      var point = L.LineUtil.closestPointOnSegment(mouse, a, b);
      if (!best || point.distanceTo(mouse) < best.distanceTo(mouse)) { best = point; }
    });
    return best;
  }

  // Sets or removes (anchor null) what point `index` of a line with `count`
  // points is attached to, in its `ends`.
  function setAnchor(ends, index, count, anchor) {
    var name = index === 0 ? 'start' : index === count - 1 ? 'end' : null;
    if (name) {
      if (anchor) { ends[name] = anchor; } else { delete ends[name]; }
      return;
    }
    ends.via = (ends.via || []).filter(function (via) { return via.point !== index; });
    if (anchor) { ends.via.push(L.Util.extend({ point: index }, anchor)); }
    if (!ends.via.length) { delete ends.via; }
  }

  // Indexes in `list` after a point is added (change +1) or removed (-1) at `index`.
  function shiftIndexes(list, index, change) {
    return (list || [])
      .filter(function (i) { return !(change < 0 && i === index); })
      .map(function (i) { return i >= index ? i + change : i; });
  }

  // Every point in between, for a curved line of `count` points.
  function allInner(count) {
    var list = [];
    for (var i = 1; i < count - 1; i++) { list.push(i); }
    return list;
  }

  // A line as plain data: {points (latlngs), ends, smooth}.
  function lineOf(entry) {
    return { points: entry.layer.getLatLngs().slice(), ends: entry.data.ends || {}, smooth: entry.data.smooth || [] };
  }

  // The points strictly between `from` and `to` of a line, and which of them
  // are smooth (counted from the first of them); reversed when asked.
  function innerOf(line, from, to, reverse) {
    var inner = line.points.slice(from + 1, to);
    var smooth = line.smooth.filter(function (i) { return i > from && i < to; }).map(function (i) { return i - from - 1; });
    if (reverse) {
      inner.reverse();
      smooth = smooth.map(function (i) { return inner.length - 1 - i; });
    }
    return { inner: inner, smooth: smooth };
  }

  // The line with its points strictly between `from` and `to` replaced by
  // `part` (from innerOf), its attachments and smooth points kept in step.
  function replaceInner(line, from, to, part) {
    var change = part.inner.length - (to - from - 1);
    var ends = JSON.parse(JSON.stringify(line.ends || {}));
    if (ends.via) {
      ends.via = ends.via
        .filter(function (via) { return via.point <= from || via.point >= to; })
        .map(function (via) { if (via.point >= to) { via.point += change; } return via; });
      if (!ends.via.length) { delete ends.via; }
    }
    var smooth = line.smooth
      .filter(function (i) { return i <= from || i >= to; })
      .map(function (i) { return i >= to ? i + change : i; })
      .concat(part.smooth.map(function (i) { return i + from + 1; }));
    return { points: line.points.slice(0, from + 1).concat(part.inner, line.points.slice(to)), ends: ends, smooth: smooth };
  }

  // Lines that run between the same two anchors share one path there: after
  // a line is reshaped, the others in its spans take its points (and
  // curves) between those anchors. Returns the lines changed, to be saved.
  function shareSpans(state, entry) {
    var changed = [];
    var keys = [];
    (entry.spans || []).forEach(function (span) {
      if (span.group && keys.indexOf(span.group) < 0) { keys.push(span.group); }
    });
    state.linesReady = false;
    keys.forEach(function (key) {
      assignLanes(state);   // spans as they are after the changes so far
      var own = entry.spans.filter(function (span) { return span.group === key; })[0];
      if (!own) { return; }
      // Seen from the group's first anchor to its second.
      var source = innerOf(lineOf(entry), own.from, own.to, own.sign < 0);
      state.groups[key].forEach(function (member) {
        if (member.entry === entry) { return; }
        var other = member.entry;
        var part = { inner: source.inner.slice(), smooth: source.smooth.slice() };
        if (member.span.sign < 0) {
          part.inner.reverse();
          part.smooth = part.smooth.map(function (i) { return part.inner.length - 1 - i; });
        }
        var result = replaceInner(lineOf(other), member.span.from, member.span.to, part);
        other.data.ends = result.ends;
        other.data.smooth = result.smooth;
        other.layer.setLatLngs(result.points);
        if (changed.indexOf(other) < 0) { changed.push(other); }
      });
    });
    state.linesReady = true;
    relayout(state);
    return changed;
  }

  // A new line between anchors that other lines already run between takes
  // their path there. `line` is plain data (lineOf); returns the new data.
  function adoptPaths(state, line) {
    var count = line.points.length;
    var anchors = [];
    if (line.ends.start) { anchors.push({ index: 0, key: anchorKey(line.ends.start) }); }
    (line.ends.via || []).forEach(function (via) { anchors.push({ index: via.point, key: anchorKey(via) }); });
    if (line.ends.end) { anchors.push({ index: count - 1, key: anchorKey(line.ends.end) }); }
    anchors.sort(function (a, b) { return a.index - b.index; });
    // From the last span back, so earlier indexes stay put.
    for (var i = anchors.length - 2; i >= 0; i--) {
      var a = anchors[i], b = anchors[i + 1];
      if (a.key === b.key) { continue; }
      var group = state.groups[a.key < b.key ? a.key + '|' + b.key : b.key + '|' + a.key];
      if (!group || !group.length) { continue; }
      var leader = group[0];
      var part = innerOf(lineOf(leader.entry), leader.span.from, leader.span.to, leader.span.sign < 0);
      if (a.key > b.key) {
        part.inner.reverse();
        part.smooth = part.smooth.map(function (j) { return part.inner.length - 1 - j; });
      }
      line = replaceInner(line, a.index, b.index, part);
    }
    return line;
  }

  // Keeps `ends` right after a point is added (change +1) or removed (-1)
  // at `index` of a line that now has `count` points.
  function shiftAnchors(ends, index, change, count) {
    if (change < 0) {
      if (index === 0) { delete ends.start; }
      if (index === count) { delete ends.end; }   // the old last point
    }
    var via = [];
    (ends.via || []).forEach(function (item) {
      if (change < 0 && item.point === index) { return; }
      var point = item.point >= index ? item.point + change : item.point;
      var target = L.Util.extend({}, item);
      delete target.point;
      // A point in between that is now the line's first or last: its end.
      if (point === 0 && !ends.start) {
        ends.start = target;
      } else if (point === count - 1 && !ends.end) {
        ends.end = target;
      } else if (point > 0 && point < count - 1) {
        via.push(L.Util.extend({}, item, { point: point }));
      }
    });
    if (via.length) { ends.via = via; } else { delete ends.via; }
  }


  // Place search for world maps: "lat, lon" goes straight there; anything
  // else (a city, an address) is looked up with the geocoder.
  var COORDINATES = /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/;

  function placeSearch(map, geocoderUrl) {
    var Control = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        var form = L.DomUtil.create('form', 'nbm-search');
        form.innerHTML = '<input type="search" class="form-control form-control-sm" ' +
          'placeholder="' + (geocoderUrl ? 'Place, address or lat, lon' : 'lat, lon') + '" aria-label="Go to">';
        var input = form.querySelector('input');
        var list = L.DomUtil.create('div', 'list-group shadow-sm mt-1', form);
        // Zooms to a geocoder result: its outline when it has one, else its point.
        function goTo(place) {
          var box = place.boundingbox;  // [south, north, west, east] as strings
          if (box) {
            map.fitBounds([[parseFloat(box[0]), parseFloat(box[2])], [parseFloat(box[1]), parseFloat(box[3])]]);
          } else {
            map.setView([parseFloat(place.lat), parseFloat(place.lon)], 17);
          }
        }
        L.DomEvent.disableClickPropagation(form);
        L.DomEvent.disableScrollPropagation(form);
        L.DomEvent.on(form, 'submit', function (event) {
          L.DomEvent.preventDefault(event);
          var text = input.value.trim();
          var match = text.match(COORDINATES);
          if (match) {
            map.setView([parseFloat(match[1]), parseFloat(match[2])], 17);
            return;
          }
          if (!text || !geocoderUrl) { return; }
          // One search per Enter, no search-as-you-type: OpenStreetMap's
          // geocoder doesn't allow that. Up to five places come back to pick from.
          var url = geocoderUrl + (geocoderUrl.indexOf('?') < 0 ? '?' : '&') +
            'format=json&limit=5&q=' + encodeURIComponent(text);
          input.classList.remove('is-invalid');
          list.innerHTML = '';
          // Same as the tiles: the geocoder wants to see which site asks.
          fetch(url, { referrerPolicy: 'strict-origin-when-cross-origin', headers: { 'Accept': 'application/json' } })
            .then(function (response) { return response.json(); })
            .then(function (results) {
              if (!results.length) { input.classList.add('is-invalid'); return; }
              if (results.length === 1) { goTo(results[0]); return; }
              results.forEach(function (place) {
                var item = L.DomUtil.create('button', 'list-group-item list-group-item-action py-1 px-2 small', list);
                item.type = 'button';
                item.textContent = place.display_name;
                L.DomEvent.on(item, 'click', function () { list.innerHTML = ''; goTo(place); });
              });
            })
            .catch(function () { input.classList.add('is-invalid'); });
        });
        return form;
      },
    });
    return new Control();
  }

  // Small per-browser settings (chosen layer, filters). Storage may be
  // unavailable (private windows); the map then simply starts as default.
  function remembered(key) {
    try { return window.localStorage.getItem('netbox-map.' + key); } catch (e) { return null; }
  }
  function remember(key, value) {
    try { window.localStorage.setItem('netbox-map.' + key, value); } catch (e) { /* not kept */ }
  }

  // Shows one background layer, hiding the one before.
  function setBaseLayer(state, name) {
    var layer = state.baseLayers[name];
    if (!layer) { return; }
    if (state.baseLayer) { state.map.removeLayer(state.baseLayer); }
    layer.addTo(state.map);
    state.baseLayer = layer;
    state.baseLayerName = name;
    remember('base-layer', name);
    if (state.onBaseLayer) { state.onBaseLayer(); }
  }

  function render(element, data, options) {
    options = options || {};
    var edit = !!options.edit;
    csrfToken = data.csrf_token || csrfToken;
    defaultColors = data.default_colors || {};
    var layers = data.image_only ? [] : data.tiles.layers;
    // World maps zoom in half steps. Leaflet rounds to the nearest tile
    // level, so at a half step it shows the next level's tiles a little
    // smaller, which stays sharp; quarter steps would stretch tiles and blur
    // them. Image-only maps can go in quarter steps.
    var step = data.image_only ? 0.25 : 0.5;
    var mapOptions = { zoomSnap: step, zoomDelta: step, wheelPxPerZoomLevel: 120, attributionControl: !data.image_only };
    if (data.image_only) {
      mapOptions.crs = L.CRS.Simple;
      mapOptions.minZoom = -6;
      mapOptions.maxZoom = 8;
    } else {
      // Past a tile server's last level its last tiles are enlarged.
      mapOptions.maxZoom = Math.max.apply(null, [MAX_ZOOM].concat(layers.map(function (l) { return l.max_zoom; })));
    }
    var rotation = ((data.rotation || 0) % 360 + 360) % 360;
    if (rotation) { mapOptions.crs = turnedCrs(mapOptions.crs || L.CRS.EPSG3857, rotation); }
    var map = L.map(element, mapOptions);
    if (rotation) { map.getBoundsZoom = getBoundsZoom; }
    if (map.attributionControl) { map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>'); }

    // Background layers (world maps). One is shown at a time; the user's
    // last choice is remembered in the browser.
    var baseLayers = {};
    layers.forEach(function (layer) {
      // NetBox (Django) tells browsers to send no Referer to other sites, and
      // OpenStreetMap's tile servers refuse requests without one. Send just
      // NetBox's address (no page path) with tile requests.
      var tileOptions = L.Util.extend({}, layer, {
        maxNativeZoom: layer.max_zoom,
        maxZoom: mapOptions.maxZoom,
        referrerPolicy: 'strict-origin-when-cross-origin',
      });
      delete tileOptions.name;
      delete tileOptions.url;
      delete tileOptions.max_zoom;
      var tiles = new (rotation ? TurnedTileLayer : MapTileLayer)(layer.url, tileOptions);
      tiles.nbmOffset = (data.layer_offsets || {})[layer.name] || null;
      baseLayers[layer.name] = tiles;
    });

    // Layers of drawing, bottom up: images (Leaflet's overlay pane), areas
    // and circles, the light behind lines under the mouse, lines,
    // junctions, then markers (Leaflet's marker pane). Lines and junctions
    // above areas also take the mouse before them, so a cable under a
    // street can still be pointed at.
    [['nbmAreas', 410], ['nbmHalo', 415], ['nbmLines', 420], ['nbmJunctions', 430]].forEach(function (pane) {
      map.createPane(pane[0]).style.zIndex = pane[1];
    });

    // Everything placed on the map, for fitting the view to it.
    var bounds = L.latLngBounds([]);
    var state = {
      map: map, data: data, overlays: {}, markers: {}, shapes: {}, cards: {}, tool: null, bounds: bounds,
      baseLayers: baseLayers, baseLayer: null,
    };
    var names = Object.keys(baseLayers);
    if (names.length) {
      var saved = remembered('base-layer');
      setBaseLayer(state, names.indexOf(saved) >= 0 ? saved : names[0]);
    }

    // Overlays, lowest weight first. On an image-only map an overlay that
    // isn't placed yet sits at its own pixel size from the bottom-left corner.
    data.overlays.slice().sort(function (a, b) { return a.weight - b.weight; }).forEach(function (overlay) {
      var corners = overlay.bounds;
      if (!corners && data.image_only) { corners = [[0, 0], [overlay.height || 1000, overlay.width || 1000]]; }
      if (!corners) { return; }
      var layer = new (rotation ? TurnedImageOverlay : L.ImageOverlay)(overlay.url, corners, {
        opacity: overlay.opacity / 100, zIndex: overlay.weight, interactive: false,
      }).addTo(map);
      state.overlays[overlay.id] = { data: overlay, layer: layer };
      bounds.extend(layer.getBounds());
    });

    // Shapes, lower levels first, so higher areas are drawn over them.
    data.shapes.slice().sort(function (a, b) { return (a.level || 0) - (b.level || 0); }).forEach(function (shape) {
      var style = {
        color: shapeColor(shape), weight: 3, fillOpacity: 0.2, pane: 'nbmAreas', className: shape.link_url ? 'nbm-shape-link' : '',
      };
      var points = shape.points.map(function (p) { return toLatLng(p[0], p[1]); });
      var layer;
      if (shape.kind === 'circle') {
        layer = new (rotation ? TurnedCircle : L.Circle)(points[0], Object.assign({ radius: shape.radius }, style));
      } else if (shape.kind === 'area') {
        layer = L.polygon(points, style);
      } else if (shape.kind === 'junction') {
        // A ring that lines run through; sizeJunctions() sets its size.
        layer = L.circleMarker(points[0], {
          radius: 7, color: shapeColor(shape), weight: 3, fillOpacity: 1, pane: 'nbmJunctions', className: 'nbm-junction',
        });
      } else {
        // Seen through; drawLine() draws what is seen (see "Lines" above).
        layer = new HitLine(points, { opacity: 0, weight: 14, pane: 'nbmLines' });
      }
      var entry = { data: shape, layer: layer };
      if (shape.kind === 'line') {
        entry.visual = L.layerGroup();
        layer.on('add', function () { entry.visual.addTo(map); });
        layer.on('remove', function () { map.removeLayer(entry.visual); });
        layer.nbmRedraw = function () {
          if (!state.linesReady) { return; }
          // Points added or removed: the spans change, for other lines too.
          if (entry.drawnPoints !== layer.getLatLngs().length) { relayout(state); } else { drawLine(state, entry); }
        };
      } else if (shape.kind !== 'junction') {
        // Lines under this area or circle are drawn again when it changes.
        (layer.setLatLngs ? ['setLatLngs'] : ['setLatLng', 'setRadius']).forEach(function (method) {
          var original = layer[method];
          layer[method] = function () {
            var result = original.apply(this, arguments);
            if (state.linesReady) { drawAllLines(state); }
            return result;
          };
        });
      }
      layer.addTo(map);
      // A circle's bounds need the map's view, which isn't set yet: work them out here.
      if (shape.kind === 'junction') {
        bounds.extend(points[0]);
      } else if (shape.kind === 'circle') {
        bounds.extend(data.image_only
          ? L.latLngBounds([points[0].lat - shape.radius, points[0].lng - shape.radius],
                           [points[0].lat + shape.radius, points[0].lng + shape.radius])
          : points[0].toBounds(shape.radius * 2));
      } else {
        bounds.extend(layer.getBounds());
      }
      state.shapes[shape.id] = entry;
      var tooltip = shape.label || '';
      if (shape.kind === 'line') {
        // Lines show their cable's card, or the bundle they run in; plain
        // lines on their own show their label.
        hoverCard(state, layer, function (event) {
          var what = lineCard(state, entry, event.latlng);
          if (!what && tooltip) { what = { key: 'label', html: listCard(tooltip) }; }
          return what;
        });
      } else if (shape.kind === 'junction') {
        hoverCard(state, layer, function () { return junctionCard(state, entry); });
      } else if (tooltip) {
        // An area's or circle's label is always shown, in its middle (added
        // once the view is set, like marker names).
        entry.label = tooltip;
      }
      if (edit && (data.can.change_shape || data.can.delete_shape)) {
        var html = '<strong>' + escapeHtml(shape.label || shape.route_name || shape.kind) + '</strong><br>';
        var links = [];
        if (data.can.change_shape) {
          var reshape = { circle: 'Move or resize', junction: 'Move' }[shape.kind] || 'Edit points';
          links.push('<a href="#" data-nbm-reshape="' + shape.id + '">' + reshape + '</a>');
          links.push('<a href="' + shape.edit_url + '">' + (shape.kind === 'line' ? 'Label, color, route' : 'Label, color, link') + '</a>');
        }
        if (data.can.delete_shape) { links.push('<a href="#" data-nbm-delete-shape="' + shape.id + '">Delete</a>'); }
        layer.bindPopup(html + links.join(' · '));
      } else if (shape.link_url) {
        // A shape linked to another map opens it, like a map marker.
        layer.on('click', function () { window.location.href = shape.link_url; });
      }
    });

    state.linesReady = true;
    relayout(state);

    // Markers. A marker for another map opens it on click; others show a popup.
    data.markers.forEach(function (marker) { addMarker(state, marker, edit); });

    // Start fitted to everything on the map, or zoomed in on the highlighted marker.
    function fitAll() {
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [30, 30] });
      } else if (data.image_only) {
        map.setView([0, 0], 0);
      } else {
        map.setView([20, 0], 2);
      }
    }
    // The map's own start view when it has one, otherwise everything on it.
    function startView() {
      if (data.default_view) {
        map.setView(toLatLng(data.default_view.x, data.default_view.y), data.default_view.zoom);
      } else {
        fitAll();
      }
    }
    startView();
    var focus = data.highlight && state.markers[data.highlight];
    if (focus) {
      // Closer in, centered on the highlighted marker.
      var zoom = data.image_only ? map.getZoom() + 1 : Math.max(map.getZoom(), 17);
      map.setView(focus.getLatLng(), zoom);
    }
    fitButton(startView, !!data.default_view).addTo(map);
    // Place search is for finding where to draw, so it is part of the editor.
    if (!data.image_only && edit) { placeSearch(map, data.tiles.geocoder_url).addTo(map); }
    if (rotation) { northArrow(rotation).addTo(map); }
    if (options.sidebar) {
      buildSidebar(state, options.sidebar);
      sidebarToggle(state, options.sidebar);
    }

    // Names under the markers. Added once the view is set: a label that is
    // always shown needs the map's position to draw itself.
    Object.keys(state.markers).forEach(function (id) { addLabel(state.markers[id]); });
    Object.keys(state.shapes).forEach(function (id) {
      var entry = state.shapes[id];
      if (entry.label) {
        entry.layer.bindTooltip(escapeHtml(entry.label), {
          permanent: true, direction: 'center', interactive: false, className: 'nbm-label nbm-area-label',
        });
      }
    });
    state.ready = true;

    // The element may have been sized after the map started (cards, tabs).
    setTimeout(function () { map.invalidateSize(); }, 0);

    if (edit) { startEditor(state, options.toolbar); }
    return map;
  }

  //
  // Sidebar (on a map's own page): where the map is, the background layer,
  // what to show, links to other maps, and the devices, racks and cables
  // on the map.
  //

  // What sort of thing each part of the map is, for the filters.
  var CATEGORIES = [
    { key: 'device', text: 'Devices', icon: 'server' },
    { key: 'rack', text: 'Racks', icon: 'server-network' },
    { key: 'map', text: 'Map links', icon: 'map-marker-path' },
    { key: 'other', text: 'Other objects', icon: 'map-marker' },
    { key: 'label', text: 'Labels', icon: 'label-outline' },
    { key: 'cable', text: 'Cables', icon: 'cable-data' },
    { key: 'area', text: 'Areas', icon: 'vector-polygon' },
    { key: 'line', text: 'Lines', icon: 'vector-polyline' },
    { key: 'circle', text: 'Circles', icon: 'vector-circle' },
    { key: 'junction', text: 'Junctions', icon: 'circle-double' },
    { key: 'image', text: 'Images', icon: 'image-outline' },
  ];

  function markerCategory(marker) {
    if (marker.map_link) { return 'map'; }
    if (!marker.object) { return 'label'; }
    if (marker.object.indexOf('dcim.device:') === 0) { return 'device'; }
    if (marker.object.indexOf('dcim.rack:') === 0) { return 'rack'; }
    return 'other';
  }

  // Every drawn layer with its category: [{category, layer, ...}].
  function mapParts(state) {
    var parts = [];
    state.data.markers.forEach(function (marker) {
      var layer = state.markers[marker.id];
      if (layer) { parts.push({ category: markerCategory(marker), layer: layer, marker: marker }); }
    });
    Object.keys(state.shapes).forEach(function (id) {
      var shape = state.shapes[id];
      parts.push({ category: shape.data.object ? 'cable' : shape.data.kind, layer: shape.layer, shape: shape.data });
    });
    Object.keys(state.overlays).forEach(function (id) {
      parts.push({ category: 'image', layer: state.overlays[id].layer });
    });
    return parts;
  }

  function sidebarSection(aside, title) {
    var section = L.DomUtil.create('div', 'nbm-side-section', aside);
    var heading = L.DomUtil.create('div', 'nbm-side-title', section);
    heading.textContent = title;
    return section;
  }

  // A link list: items are {text, url, icon, onClick}. onClick (zoom to it)
  // wins over the link for the text; the link then gets its own icon.
  function sidebarList(section, items) {
    var list = L.DomUtil.create('div', 'list-group list-group-flush', section);
    items.forEach(function (item) {
      var row = L.DomUtil.create('div', 'list-group-item d-flex align-items-center gap-2 px-2 py-1', list);
      if (item.dot) { L.DomUtil.create('span', 'nbm-dot text-bg-' + item.dot, row); }
      var name = L.DomUtil.create('a', 'flex-fill text-truncate', row);
      name.textContent = item.text;
      name.href = item.onClick ? '#' : item.url;
      if (item.onClick) {
        name.title = 'Show on the map';
        L.DomEvent.on(name, 'click', function (event) { L.DomEvent.preventDefault(event); item.onClick(); });
        if (item.url) {
          var open = L.DomUtil.create('a', 'text-secondary', row);
          open.href = item.url;
          open.title = 'Open';
          open.innerHTML = '<i class="mdi mdi-open-in-new"></i>';
        }
      }
      row.nbmText = item.text.toLowerCase();
    });
    return list;
  }

  function buildSidebar(state, aside) {
    var data = state.data;
    var map = state.map;
    aside.innerHTML = '';
    L.DomEvent.disableScrollPropagation(aside);

    // Where the map is: parent maps, then its region, site or location.
    var where = sidebarSection(aside, 'Location');
    if (data.place.length) {
      var crumbs = L.DomUtil.create('div', 'nbm-crumbs', where);
      data.place.forEach(function (step) {
        var link = L.DomUtil.create('a', '', crumbs);
        link.href = step.url;
        link.textContent = step.label;
        L.DomUtil.create('span', 'text-secondary', crumbs).textContent = ' › ';
      });
      L.DomUtil.create('span', 'fw-bold', crumbs).textContent = data.name;
    } else {
      L.DomUtil.create('div', 'text-secondary small', where).textContent = 'Not assigned to a place.';
    }

    // Background layer of a world map.
    var layerNames = Object.keys(state.baseLayers);
    if (layerNames.length > 1) {
      var background = sidebarSection(aside, 'Background');
      state.backgroundSection = background;
      var group = L.DomUtil.create('div', 'btn-group btn-group-sm w-100 flex-wrap', background);
      layerNames.forEach(function (name) {
        var button = L.DomUtil.create('button', 'btn btn-outline-primary', group);
        button.type = 'button';
        button.textContent = name;
        if (name === state.baseLayerName) { button.classList.add('active'); }
        L.DomEvent.on(button, 'click', function () {
          setBaseLayer(state, name);
          group.querySelectorAll('.btn').forEach(function (b) { b.classList.toggle('active', b === button); });
        });
      });
    }

    // Filters: one switch per kind of thing on the map, remembered in the browser.
    var parts = mapParts(state);
    var hidden = (remembered('hidden') || '').split(',').filter(Boolean);
    function apply() {
      parts.forEach(function (part) {
        var show = hidden.indexOf(part.category) < 0;
        if (show && !map.hasLayer(part.layer)) { part.layer.addTo(map); }
        if (!show && map.hasLayer(part.layer)) { map.removeLayer(part.layer); }
      });
      // A hidden area no longer covers lines: draw them again.
      drawAllLines(state);
    }
    var present = CATEGORIES.filter(function (c) { return parts.some(function (p) { return p.category === c.key; }); });
    if (present.length) {
      var show = sidebarSection(aside, 'Show');
      present.forEach(function (category) {
        var count = parts.filter(function (p) { return p.category === category.key; }).length;
        var row = L.DomUtil.create('label', 'form-check form-switch mb-1', show);
        row.innerHTML = '<input class="form-check-input" type="checkbox"> <span class="form-check-label">' +
          '<i class="mdi mdi-' + category.icon + '"></i> ' + category.text + ' <span class="text-secondary">' + count + '</span></span>';
        var box = row.querySelector('input');
        box.checked = hidden.indexOf(category.key) < 0;
        L.DomEvent.on(box, 'change', function () {
          hidden = hidden.filter(function (key) { return key !== category.key; });
          if (!box.checked) { hidden.push(category.key); }
          remember('hidden', hidden.join(','));
          apply();
        });
      });
      apply();
    }

    // Zooms in on a marker or a line, showing it first if it was filtered out.
    function focus(part) {
      if (!map.hasLayer(part.layer)) { part.layer.addTo(map); }
      if (part.layer.getLatLng) {
        map.setView(part.layer.getLatLng(), Math.max(map.getZoom(), data.image_only ? map.getZoom() : 18));
      } else {
        map.fitBounds(part.layer.getBounds(), { padding: [40, 40] });
      }
    }

    // Other maps: submaps, map markers and shapes that open a map.
    var maps = [];
    var seen = {};
    function addMap(text, url) {
      if (!url || seen[url]) { return; }
      seen[url] = true;
      maps.push({ text: text, url: url, icon: 'map' });
    }
    data.submaps.forEach(function (submap) { addMap(submap.name, submap.url); });
    data.markers.forEach(function (marker) { if (marker.map_link) { addMap(marker.label, marker.url); } });
    data.shapes.forEach(function (shape) { if (shape.link_url) { addMap(shape.link_name, shape.link_url); } });
    if (maps.length) { sidebarList(sidebarSection(aside, 'Maps'), maps); }

    // Devices, racks and cables on the map: click to zoom in, icon to open.
    [
      { key: 'rack', title: 'Racks' },
      { key: 'device', title: 'Devices' },
      { key: 'cable', title: 'Cables and circuits' },
    ].forEach(function (group) {
      var members = parts.filter(function (p) { return p.category === group.key; });
      if (!members.length) { return; }
      var section = sidebarSection(aside, group.title + ' (' + members.length + ')');
      var filter = null;
      if (members.length > 8) {
        filter = L.DomUtil.create('input', 'form-control form-control-sm mb-1', section);
        filter.type = 'search';
        filter.placeholder = 'Filter';
      }
      var list = sidebarList(section, members.map(function (part) {
        var item = part.marker || part.shape;
        return {
          text: part.marker ? item.label : (item.label || item.route_name),
          url: part.marker ? item.url : item.route_url,
          dot: item.status,
          onClick: function () { focus(part); },
        };
      }).sort(function (a, b) { return a.text.localeCompare(b.text); }));
      if (filter) {
        L.DomEvent.on(filter, 'input', function () {
          var text = filter.value.toLowerCase();
          list.childNodes.forEach(function (row) { row.classList.toggle('d-none', row.nbmText.indexOf(text) < 0); });
        });
      }
    });
  }

  // A button on the map that shows or hides the sidebar.
  function sidebarToggle(state, aside) {
    var map = state.map;
    function set(open) {
      aside.classList.toggle('d-none', !open);
      remember('sidebar', open ? 'open' : 'closed');
      map.invalidateSize();
    }
    set(remembered('sidebar') !== 'closed');
    var Control = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        var bar = L.DomUtil.create('div', 'leaflet-bar');
        var button = L.DomUtil.create('a', 'nbm-fit', bar);
        button.href = '#';
        button.title = 'Show or hide the side panel';
        button.setAttribute('role', 'button');
        button.innerHTML = '<i class="mdi mdi-dock-right"></i>';
        L.DomEvent.disableClickPropagation(button);
        L.DomEvent.on(button, 'click', function (event) {
          L.DomEvent.preventDefault(event);
          set(aside.classList.contains('d-none'));
        });
        return bar;
      },
    });
    new Control().addTo(map);
  }

  //
  // Editor
  //

  function startEditor(state, toolbar) {
    var map = state.map;
    var data = state.data;
    var hint = toolbar ? toolbar.querySelector('[data-nbm-hint]') : null;

    function say(text) { if (hint) { hint.textContent = text || ''; } }
    function reload() { window.location.reload(); }

    // Delete and reshape links in shape popups.
    map.on('popupopen', function (event) {
      var reshape = event.popup.getElement().querySelector('[data-nbm-reshape]');
      if (reshape) {
        reshape.addEventListener('click', function (click) {
          click.preventDefault();
          map.closePopup();
          startReshape(state, state.shapes[reshape.getAttribute('data-nbm-reshape')], say);
        });
      }
      var link = event.popup.getElement().querySelector('[data-nbm-delete-shape]');
      if (!link) { return; }
      link.addEventListener('click', function (click) {
        click.preventDefault();
        if (!window.confirm('Delete this shape?')) { return; }
        api('DELETE', data.api.shapes + link.getAttribute('data-nbm-delete-shape') + '/').then(reload, failed);
      });
    });

    // Overlay handles: drag a corner to stretch, the middle to move.
    if (data.can.change_overlay) {
      Object.keys(state.overlays).forEach(function (id) {
        var overlay = state.overlays[id];
        var b = overlay.layer.getBounds();
        var sw = L.marker(b.getSouthWest(), { draggable: true, icon: handleIcon('corner') }).addTo(map);
        var ne = L.marker(b.getNorthEast(), { draggable: true, icon: handleIcon('corner') }).addTo(map);
        var middle = L.marker(b.getCenter(), { draggable: true, icon: handleIcon('move') }).addTo(map);
        middle.bindTooltip(escapeHtml(overlay.data.name) + ': drag to move', { direction: 'top' });
        var moveFrom = null;

        function redraw() {
          var nb = L.latLngBounds(sw.getLatLng(), ne.getLatLng());
          overlay.layer.setBounds(nb);
          middle.setLatLng(nb.getCenter());
        }
        function save() {
          var nb = overlay.layer.getBounds();
          api('PATCH', data.api.overlays + id + '/', {
            x_min: nb.getWest(), y_min: nb.getSouth(), x_max: nb.getEast(), y_max: nb.getNorth(),
          }).catch(failed);
        }
        sw.on('drag', redraw).on('dragend', save);
        ne.on('drag', redraw).on('dragend', save);
        middle.on('dragstart', function () { moveFrom = middle.getLatLng(); });
        middle.on('drag', function () {
          var now = middle.getLatLng();
          var dLat = now.lat - moveFrom.lat;
          var dLng = now.lng - moveFrom.lng;
          moveFrom = now;
          sw.setLatLng([sw.getLatLng().lat + dLat, sw.getLatLng().lng + dLng]);
          ne.setLatLng([ne.getLatLng().lat + dLat, ne.getLatLng().lng + dLng]);
          overlay.layer.setBounds(L.latLngBounds(sw.getLatLng(), ne.getLatLng()));
        });
        middle.on('dragend', save);
      });
    }

    if (data.can.add_marker) { startContextMenu(state); }

    if (!toolbar) { return; }

    // Start view: save what is on screen now, or go back to fitting everything.
    var setView = toolbar.querySelector('[data-nbm-set-view]');
    if (setView) {
      setView.addEventListener('click', function () {
        var center = fromLatLng(map.getCenter());
        api('PATCH', data.api.map, { default_x: center.x, default_y: center.y, default_zoom: map.getZoom() })
          .then(function () { say('The map now opens at this view.'); }, failed);
      });
    }
    var clearView = toolbar.querySelector('[data-nbm-clear-view]');
    if (clearView) {
      clearView.addEventListener('click', function () {
        api('PATCH', data.api.map, { default_x: null, default_y: null, default_zoom: null })
          .then(function () { say('The map now opens fitted to everything on it.'); }, failed);
      });
    }

    // Turning the map: saved, then the page is drawn again with the new angle.
    var rotation = toolbar.querySelector('[data-nbm-rotation]');
    if (rotation) {
      rotation.addEventListener('change', function () {
        var degrees = parseFloat(rotation.value);
        if (isNaN(degrees)) { return; }
        api('PATCH', data.api.map, { rotation: degrees }).then(reload, failed);
      });
    }

    // Opacity sliders, one per overlay.
    toolbar.querySelectorAll('[data-nbm-opacity]').forEach(function (slider) {
      var id = slider.getAttribute('data-nbm-opacity');
      slider.addEventListener('input', function () {
        if (state.overlays[id]) { state.overlays[id].layer.setOpacity(slider.value / 100); }
      });
      slider.addEventListener('change', function () {
        api('PATCH', data.api.overlays + id + '/', { opacity: parseInt(slider.value, 10) }).catch(failed);
      });
    });

    // Place an overlay that has no corners yet over the middle of the view.
    toolbar.querySelectorAll('[data-nbm-place-overlay]').forEach(function (button) {
      button.addEventListener('click', function () {
        var view = map.getBounds();
        var center = view.getCenter();
        var halfLat = (view.getNorth() - view.getSouth()) / 4;
        var halfLng = (view.getEast() - view.getWest()) / 4;
        api('PATCH', data.api.overlays + button.getAttribute('data-nbm-place-overlay') + '/', {
          x_min: center.lng - halfLng, y_min: center.lat - halfLat,
          x_max: center.lng + halfLng, y_max: center.lat + halfLat,
        }).then(reload, failed);
      });
    });

    // Tools that take clicks on the map: placing a marker, adding one, drawing.
    var drawing = null;   // { kind, points, anchors, preview, cursor }

    function stopTool() {
      if (state.tool && state.tool.stop) { state.tool.stop(); }
      state.tool = null;
      if (drawing && drawing.preview) { map.removeLayer(drawing.preview); }
      drawing = null;
      map.getContainer().style.cursor = '';
      L.DomUtil.removeClass(map.getContainer(), 'nbm-tool-on');
      map.doubleClickZoom.enable();
      toolbar.querySelectorAll('[data-nbm-finish], [data-nbm-undo]').forEach(function (b) { b.classList.add('d-none'); });
      say('');
    }

    function startTool(tool, text) {
      stopTool();
      state.tool = tool;
      map.getContainer().style.cursor = 'crosshair';
      // Clicks go to the map, not to shapes already on it (see map.css).
      L.DomUtil.addClass(map.getContainer(), 'nbm-tool-on');
      say(text + ' Press Esc to cancel.');
    }

    // Lining up background layers: while "Line up" is on, dragging the map
    // moves the background shown, to match the others (satellite photos and
    // street maps often differ by a few meters). Saved for this map.
    if (data.can.change_map && state.backgroundSection) {
      var row = L.DomUtil.create('div', 'd-flex align-items-center flex-wrap gap-2 mt-2', state.backgroundSection);
      var lineUp = L.DomUtil.create('button', 'btn btn-sm btn-outline-secondary', row);
      lineUp.type = 'button';
      lineUp.innerHTML = '<i class="mdi mdi-arrow-all"></i> Line up';
      lineUp.title = 'Drag the map to move this background into line with the others';
      var resetOffset = L.DomUtil.create('button', 'btn btn-sm btn-ghost-secondary', row);
      resetOffset.type = 'button';
      resetOffset.textContent = 'Reset';
      var readout = L.DomUtil.create('span', 'small text-secondary', row);
      data.layer_offsets = data.layer_offsets || {};
      var offsetOf = function () { return data.layer_offsets[state.baseLayerName] || [0, 0]; };
      var describe = function () {
        var o = offsetOf();
        var moved = o[0] || o[1];
        readout.textContent = moved
          ? Math.abs(o[0]).toFixed(1) + ' m ' + (o[0] < 0 ? 'west' : 'east') + ', ' +
            Math.abs(o[1]).toFixed(1) + ' m ' + (o[1] < 0 ? 'south' : 'north')
          : '';
        resetOffset.classList.toggle('d-none', !moved);
      };
      var saveOffsets = function () { api('PATCH', data.api.map, { layer_offsets: data.layer_offsets }).catch(failed); };
      state.onBaseLayer = describe;
      describe();
      L.DomEvent.on(lineUp, 'click', function () {
        if (state.tool && state.tool.align) { stopTool(); return; }
        startTool({ align: true, stop: function () {
          map.dragging.enable();
          lineUp.classList.remove('active');
        } }, 'Drag the map to move the "' + state.baseLayerName + '" background. Click Line up again when done.');
        map.dragging.disable();
        map.getContainer().style.cursor = 'move';
        lineUp.classList.add('active');
      });
      L.DomEvent.on(resetOffset, 'click', function () {
        delete data.layer_offsets[state.baseLayerName];
        state.baseLayer.setOffset(null);
        describe();
        saveOffsets();
      });
      map.on('mousedown', function (event) {
        if (!state.tool || !state.tool.align || !state.baseLayer) { return; }
        var name = state.baseLayerName;
        var layer = state.baseLayer;
        var from = event.latlng;
        var start = offsetOf().slice();
        var metersPerLng = 111320 * Math.cos(from.lat * Math.PI / 180);
        function move(e) {
          var now = map.mouseEventToLatLng(e);
          var offset = [
            Math.round((start[0] + (now.lng - from.lng) * metersPerLng) * 100) / 100,
            Math.round((start[1] + (now.lat - from.lat) * 111320) * 100) / 100,
          ];
          data.layer_offsets[name] = offset;
          layer.setOffset(offset);
          describe();
        }
        function up() {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          saveOffsets();
        }
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    }

    toolbar.querySelectorAll('[data-nbm-place-marker]').forEach(function (button) {
      button.addEventListener('click', function () {
        startTool({ place: button.getAttribute('data-nbm-place-marker') }, 'Click where "' + button.getAttribute('data-nbm-name') + '" goes.');
      });
    });

    var addMarker = toolbar.querySelector('[data-nbm-add-marker]');
    if (addMarker) {
      addMarker.addEventListener('click', function () {
        startTool({ add: true }, 'Click where the new marker goes.');
      });
    }

    toolbar.querySelectorAll('[data-nbm-draw]').forEach(function (button) {
      button.addEventListener('click', function () {
        var kind = button.getAttribute('data-nbm-draw');
        startTool({ draw: kind }, {
          circle: 'Click the center, then a point on the edge.',
          junction: 'Click where the junction (a manhole, cable well, pole, ...) goes.',
        }[kind] || 'Click the points, then Finish (or double-click the last point). Clicks on markers and junctions attach the line to them.');
        drawing = { kind: kind, points: [], anchors: [], preview: null, cursor: null };
        map.doubleClickZoom.disable();
        if (kind !== 'circle' && kind !== 'junction') {
          toolbar.querySelectorAll('[data-nbm-finish], [data-nbm-undo]').forEach(function (b) { b.classList.remove('d-none'); });
        }
      });
    });

    function saveShape(kind, points, radius, ends, smooth) {
      var label = window.prompt('Label for the ' + kind + ' (optional):', '');
      if (label === null) { stopTool(); return; }
      api('POST', data.api.shapes, {
        map: data.id, kind: kind, label: label, points: points, radius: radius, ends: ends || {}, smooth: smooth || [],
      }).then(reload, failed);
    }

    // What the line's points are attached to, for the API.
    function drawnEnds() {
      var ends = {};
      var count = drawing.anchors.length;
      drawing.anchors.forEach(function (anchor, i) {
        if (anchor) { setAnchor(ends, i, count, anchor); }
      });
      return ends;
    }

    function finishDrawing() {
      if (!drawing) { return; }
      // A double-click adds its point twice; drop repeats (and their anchors).
      var keep = drawing.points.map(function (p, i, all) { return i === 0 || !p.equals(all[i - 1]); });
      drawing.points = drawing.points.filter(function (p, i) { return keep[i]; });
      drawing.anchors = drawing.anchors.filter(function (a, i) { return keep[i]; });
      var least = drawing.kind === 'area' ? 3 : 2;
      if (drawing.points.length < least) {
        say('A ' + drawing.kind + ' needs at least ' + least + ' points.');
        return;
      }
      var points = drawing.points.map(function (p) { return [p.lng, p.lat]; });
      if (drawing.kind === 'area') {
        saveShape('area', points);
        return;
      }
      // Between anchors other lines already use, the new line takes their path.
      var line = adoptPaths(state, { points: drawing.points.slice(), ends: drawnEnds(), smooth: [] });
      points = line.points.map(function (p) { return [p.lng, p.lat]; });
      if (drawing.kind === 'cable') {
        // A cable route is a line tied to a cable, bundle or circuit.
        state.tool = null;
        say('Pick what this route is for.');
        pickRoute(state, drawing.points[drawing.points.length - 1], function (type, id) {
          api('POST', data.api.shapes, {
            map: data.id, kind: 'line', points: points, object_type: type, object_id: id, ends: line.ends, smooth: line.smooth,
          }).then(reload, failed);
        }, stopTool);
        return;
      }
      saveShape('line', points, null, line.ends, line.smooth);
    }

    toolbar.querySelectorAll('[data-nbm-finish]').forEach(function (button) {
      button.addEventListener('click', finishDrawing);
    });

    // Take back the last point while drawing.
    function undoPoint() {
      if (!drawing || !drawing.points.length) { return; }
      drawing.points.pop();
      drawing.anchors.pop();
      redrawPreview();
    }
    toolbar.querySelectorAll('[data-nbm-undo]').forEach(function (button) {
      button.addEventListener('click', undoPoint);
    });

    // The shape so far, plus where the next click would go (dashed).
    function redrawPreview() {
      if (drawing.preview) { map.removeLayer(drawing.preview); }
      var style = { color: '#2196f3', dashArray: '4 4', weight: 2, interactive: false, pane: 'nbmJunctions' };
      var points = drawing.points.slice();
      if (drawing.cursor) { points.push(drawing.cursor.latlng); }
      var preview = L.layerGroup();
      if (drawing.kind === 'circle') {
        if (drawing.points.length && drawing.cursor) {
          var center = drawing.points[0];
          new (state.data.rotation ? TurnedCircle : L.Circle)(center, L.Util.extend({ radius: circleRadius(center, drawing.cursor.latlng) }, style)).addTo(preview);
        }
      } else if (points.length > 1) {
        (drawing.kind === 'area' && points.length > 2 ? L.polygon(points, style) : L.polyline(points, style)).addTo(preview);
      }
      // A ring where the next point snaps to a marker or an outline.
      if (drawing.cursor && drawing.cursor.anchor) {
        L.circleMarker(drawing.cursor.latlng, { radius: 9, color: '#2196f3', weight: 3, fill: false, interactive: false, pane: 'nbmJunctions' }).addTo(preview);
      }
      drawing.preview = preview.addTo(map);
    }

    // Meters on a world map, map units (pixels) on an image-only one.
    function circleRadius(center, edge) {
      return data.image_only ? Math.hypot(edge.lat - center.lat, edge.lng - center.lng) : map.distance(center, edge);
    }

    // Where a click goes while drawing a line or cable: onto a marker or
    // junction near the mouse, or onto the outline of an area or circle,
    // which then holds that point of the line ("anchor", see snapTarget).
    // Anywhere else, just where it is.
    function snapped(event) {
      var free = { latlng: event.latlng, anchor: null };
      if (!drawing || (drawing.kind !== 'line' && drawing.kind !== 'cable')) { return free; }
      return snapTarget(state, event.containerPoint) || free;
    }

    map.on('mousemove', function (event) {
      if (!drawing || !state.tool || !state.tool.draw) { return; }
      drawing.cursor = snapped(event);
      redrawPreview();
    });

    map.on('click', function (event) {
      var tool = state.tool;
      if (!tool) { return; }
      var point = fromLatLng(event.latlng);
      if (tool.place) {
        api('PATCH', data.api.markers + tool.place + '/', point).then(reload, failed);
        stopTool();
      } else if (tool.add) {
        window.location.href = data.add_marker_url + '&x=' + point.x + '&y=' + point.y;
      } else if (tool.draw === 'junction') {
        saveShape('junction', [[event.latlng.lng, event.latlng.lat]]);
      } else if (tool.draw === 'circle') {
        drawing.points.push(event.latlng);
        if (drawing.points.length === 2) {
          var center = drawing.points[0];
          saveShape('circle', [[center.lng, center.lat]], circleRadius(center, event.latlng));
        }
      } else if (tool.draw) {
        var at = snapped(event);
        drawing.points.push(at.latlng);
        drawing.anchors.push(at.anchor);
        redrawPreview();
      }
    });

    map.on('dblclick', function () {
      if (state.tool && state.tool.draw && state.tool.draw !== 'circle' && state.tool.draw !== 'junction') { finishDrawing(); }
    });

    // Whether Ctrl (or Cmd) is held, for curving lines while dragging.
    document.addEventListener('keydown', function (event) { if (event.ctrlKey || event.metaKey) { state.ctrlDown = true; } });
    document.addEventListener('keyup', function (event) { state.ctrlDown = event.ctrlKey || event.metaKey; });
    window.addEventListener('blur', function () { state.ctrlDown = false; });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && state.tool) { stopTool(); }
      var typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
      if (drawing && !typing && (event.key === 'Backspace' || ((event.ctrlKey || event.metaKey) && event.key === 'z'))) {
        event.preventDefault();
        undoPoint();
      }
    });
  }

  //
  // Reshaping a drawn shape: drag its points, drag a midpoint to add one,
  // right-click a point to remove it. A circle has a center and an edge
  // handle. Every change is saved when the drag ends.
  //

  function startReshape(state, shape, say) {
    var map = state.map;
    var data = state.data;
    if (state.reshaping) { state.reshaping(); }
    var handles = [];
    var layer = shape.layer;
    var kind = shape.data.kind;

    function clear() {
      handles.forEach(function (h) { map.removeLayer(h); });
      handles = [];
    }
    function stop() {
      clear();
      state.reshaping = null;
      map.off('click', stop);
      say('');
    }
    state.reshaping = stop;
    map.on('click', stop);
    say({
      circle: 'Drag the middle to move the circle, the edge handle to resize it. Click the map when done.',
      junction: 'Drag the junction to move it; lines through it follow. Click the map when done.',
      line: 'Drag points to move them (an end onto another marker or junction to connect it there), a small midpoint ' +
        'to add a sharp turn, hold Ctrl while dragging to curve the whole line, right-click a point to remove it. ' +
        'Click the map when done.',
    }[kind] || 'Drag points to move them, a small midpoint to add one, right-click a point to remove it. Click the map when done.');

    function handle(latlng, small) {
      // Above markers, so a line's end on a device can still be picked up.
      var h = L.marker(latlng, { draggable: true, icon: handleIcon(small ? 'mid' : 'corner'), zIndexOffset: 2000 }).addTo(map);
      handles.push(h);
      return h;
    }

    function save(fields) {
      api('PATCH', data.api.shapes + shape.data.id + '/', fields).catch(failed);
    }

    if (kind === 'junction') {
      var spot = handle(layer.getLatLng());
      spot.on('drag', function () {
        layer.setLatLng(spot.getLatLng());
        followAnchor(state, 's' + shape.data.id, spot.getLatLng());
      });
      // NetBox moves the lines through it the same way when it is saved.
      spot.on('dragend', function () {
        var c = fromLatLng(layer.getLatLng());
        save({ points: [[c.x, c.y]] });
      });
      return;
    }

    if (kind === 'circle') {
      var center = handle(layer.getLatLng());
      var edgeAt = function () {
        var c = layer.getLatLng();
        return data.image_only ? L.latLng(c.lat, c.lng + layer.getRadius()) : L.latLng(c.lat, layer.getBounds().getEast());
      };
      var edge = handle(edgeAt(), true);
      center.on('drag', function () { layer.setLatLng(center.getLatLng()); edge.setLatLng(edgeAt()); });
      center.on('dragend', function () {
        var c = fromLatLng(layer.getLatLng());
        save({ points: [[c.x, c.y]] });
      });
      edge.on('drag', function () {
        var c = layer.getLatLng();
        var e = edge.getLatLng();
        layer.setRadius(data.image_only ? Math.hypot(e.lat - c.lat, e.lng - c.lng) : map.distance(c, e));
      });
      edge.on('dragend', function () { save({ radius: layer.getRadius() }); });
      return;
    }

    var closed = kind === 'area';
    var least = closed ? 3 : 2;
    // What a line's points are attached to; kept in step as points change.
    var ends = kind === 'line' ? (shape.data.ends = shape.data.ends || {}) : null;
    var isLine = kind === 'line';
    // Ctrl (or Cmd) held while dragging curves the whole line.
    function curveAll(event) {
      var original = event && event.originalEvent;
      if (!isLine || !(state.ctrlDown || (original && (original.ctrlKey || original.metaKey)))) { return; }
      shape.data.smooth = allInner(latlngs().length);
    }

    function latlngs() {
      var points = layer.getLatLngs();
      return closed ? points[0] : points;
    }
    function apply(points) { layer.setLatLngs(points); }
    function savePoints() {
      var fields = { points: latlngs().map(function (p) { return [p.lng, p.lat]; }) };
      if (!isLine) { save(fields); return; }
      fields.ends = ends;
      fields.smooth = shape.data.smooth || [];
      relayout(state);
      save(fields);
      // Lines between the same two anchors take the same path.
      shareSpans(state, shape).forEach(function (other) {
        api('PATCH', data.api.shapes + other.data.id + '/', {
          points: other.layer.getLatLngs().map(function (p) { return [p.lng, p.lat]; }),
          ends: other.data.ends, smooth: other.data.smooth,
        }).catch(failed);
      });
      ends = shape.data.ends;
    }

    function build() {
      clear();
      var points = latlngs().slice();
      points.forEach(function (point, i) {
        var h = handle(point);
        h.on('drag', function (event) {
          var now = latlngs().slice();
          now[i] = h.getLatLng();
          curveAll(event);
          apply(now);
        });
        h.on('dragend', function () {
          if (ends) {
            // A line's point attaches to what it is dropped on, or comes loose.
            var now = latlngs().slice();
            var target = snapTarget(state, map.latLngToContainerPoint(h.getLatLng()));
            if (target) { now[i] = target.latlng; }
            setAnchor(ends, i, now.length, target ? target.anchor : null);
            apply(now);
          }
          savePoints();
          build();
        });
        h.on('contextmenu', function (event) {
          L.DomEvent.stop(event);
          var now = latlngs().slice();
          if (now.length <= least) { say('A ' + kind + ' needs at least ' + least + ' points.'); return; }
          now.splice(i, 1);
          if (ends) {
            shiftAnchors(ends, i, -1, now.length);
            shape.data.smooth = shiftIndexes(shape.data.smooth, i, -1).filter(function (j) { return j > 0 && j < now.length - 1; });
          }
          apply(now);
          savePoints();
          build();
        });
      });
      // Midpoints: drag one to add a point between two others.
      var segments = closed ? points.length : points.length - 1;
      for (var i = 0; i < segments; i++) {
        (function (i) {
          var a = points[i];
          var b = points[(i + 1) % points.length];
          // On a curve, halfway along the curved piece.
          var at = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
          if (shape.path && shape.path.index[i + 1] - shape.path.index[i] > 1) {
            at = shape.path.latlngs[Math.round((shape.path.index[i] + shape.path.index[i + 1]) / 2)];
          }
          var mid = handle(at, true);
          // The new point is a sharp turn; with Ctrl held the whole line curves.
          mid.on('dragstart', function () {
            if (!ends) { return; }
            shiftAnchors(ends, i + 1, 1, points.length + 1);
            shape.data.smooth = shiftIndexes(shape.data.smooth, i + 1, 1);
          });
          mid.on('drag', function (event) {
            var now = points.slice();
            now.splice(i + 1, 0, mid.getLatLng());
            curveAll(event);
            apply(now);
          });
          mid.on('dragend', function () { savePoints(); build(); });
        })(i);
      }
    }
    build();
  }

  //
  // Right-click menu: add a device, rack, map link or text label at that spot
  //

  // A search box over one of data.search's sources (NetBox's REST API),
  // listing matches. Objects for which taken('app.model:id') is true are
  // shown but can't be picked; pick(object, type) gets the chosen one.
  function searchList(box, source, what, taken, pick) {
    box.innerHTML = '<input type="search" class="form-control form-control-sm" placeholder="Search ' + escapeHtml(what) + '">' +
      '<div class="nbm-results list-group list-group-flush mt-1"></div>';
    var input = box.querySelector('input');
    var results = box.querySelector('.nbm-results');
    var timer = null;

    function load() {
      var url = source.url + (source.url.indexOf('?') < 0 ? '?' : '&') + 'limit=12&brief=1&q=' + encodeURIComponent(input.value);
      api('GET', url).then(function (json) {
        results.innerHTML = '';
        json.results.forEach(function (obj) {
          var placed = taken(source.type + ':' + obj.id);
          var item = document.createElement('button');
          item.type = 'button';
          item.className = 'list-group-item list-group-item-action py-1 px-2';
          item.disabled = placed;
          item.textContent = obj.display + (placed ? ' (on this map)' : '');
          item.addEventListener('click', function () { pick(obj, source.type); });
          results.appendChild(item);
        });
        if (!json.results.length) { results.innerHTML = '<div class="text-secondary small p-1">Nothing found</div>'; }
      }).catch(failed);
    }
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(load, 250); });
    input.focus();
    load();
  }

  // A small menu on the map at containerPoint. Clicks and scrolling inside
  // it don't reach the map.
  function mapMenu(map, containerPoint) {
    var menu = L.DomUtil.create('div', 'nbm-menu card shadow p-1', map.getContainer());
    menu.style.left = containerPoint.x + 'px';
    menu.style.top = containerPoint.y + 'px';
    L.DomEvent.disableClickPropagation(menu);
    L.DomEvent.disableScrollPropagation(menu);
    return menu;
  }

  // What a drawn cable route can be tied to.
  var ROUTE_KINDS = [
    { kind: 'cable', text: 'Cable', icon: 'cable-data' },
    { kind: 'cablebundle', text: 'Cable bundle', icon: 'cable-data' },
    { kind: 'circuit', text: 'Circuit', icon: 'transit-connection-variant' },
  ];

  // Asks which cable, bundle or circuit a drawn route belongs to. Calls
  // pick(type, id) with the choice, or cancel() when the menu is closed.
  function pickRoute(state, latlng, pick, cancel) {
    var data = state.data;
    var menu = mapMenu(state.map, state.map.latLngToContainerPoint(latlng));
    var done = false;
    function close(picked) {
      if (done) { return; }
      done = true;
      menu.remove();
      document.removeEventListener('keydown', onKey);
      if (!picked) { cancel(); }
    }
    function onKey(event) { if (event.key === 'Escape') { close(false); } }
    document.addEventListener('keydown', onKey);
    var title = L.DomUtil.create('div', 'small text-secondary px-2 pt-1', menu);
    title.textContent = 'This route is for:';
    ROUTE_KINDS.forEach(function (entry) {
      if (!data.search[entry.kind]) { return; }
      var item = L.DomUtil.create('button', 'btn btn-sm btn-ghost-secondary w-100 text-start', menu);
      item.type = 'button';
      item.innerHTML = '<i class="mdi mdi-' + entry.icon + '"></i> ' + entry.text;
      item.addEventListener('click', function (click) {
        L.DomEvent.stop(click);
        searchList(menu, data.search[entry.kind], entry.text.toLowerCase() + 's',
          function (key) { return data.shapes.some(function (s) { return s.object === key; }); },
          function (obj, type) { close(true); pick(type, obj.id); });
      });
    });
    var cancelButton = L.DomUtil.create('button', 'btn btn-sm btn-ghost-danger w-100 text-start', menu);
    cancelButton.type = 'button';
    cancelButton.innerHTML = '<i class="mdi mdi-close"></i> Cancel';
    cancelButton.addEventListener('click', function () { close(false); });
  }

  var MENU_KINDS = [
    { kind: 'device', text: 'Add device', icon: 'server' },
    { kind: 'rack', text: 'Add rack', icon: 'server-network' },
    { kind: 'map', text: 'Link to a map', icon: 'map-marker-path' },
    { kind: 'label', text: 'Add label', icon: 'label-outline' },
  ];

  function startContextMenu(state) {
    var map = state.map;
    var data = state.data;
    var menu = null;

    function close() {
      if (menu) { menu.remove(); menu = null; }
    }

    // Saves a new marker, then draws it from the plugin's own marker data
    // (status color, icon, name) without reloading the page.
    function create(fields) {
      return api('POST', data.api.markers, Object.assign({ map: data.id }, fields))
        .then(function (created) { return api('GET', data.marker_data_url.replace('/0/', '/' + created.id + '/')); })
        .then(function (marker) { data.markers.push(marker); addMarker(state, marker, true); close(); })
        .catch(failed);
    }

    function search(kind, point) {
      searchList(menu, data.search[kind], kind + 's',
        function (key) { return data.markers.some(function (m) { return m.object === key; }); },
        function (obj, type) { create({ object_type: type, object_id: obj.id, x: point.x, y: point.y }); });
    }

    function labelForm(point) {
      menu.innerHTML = '<form class="d-flex gap-1"><input type="text" class="form-control form-control-sm" ' +
        'placeholder="Label" maxlength="100" required><button class="btn btn-sm btn-primary">Add</button></form>';
      var form = menu.querySelector('form');
      form.querySelector('input').focus();
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        create({ label: form.querySelector('input').value, x: point.x, y: point.y });
      });
    }

    map.on('contextmenu', function (event) {
      close();
      var point = fromLatLng(event.latlng);
      menu = mapMenu(map, event.containerPoint);
      MENU_KINDS.forEach(function (entry) {
        if (entry.kind !== 'label' && !data.search[entry.kind]) { return; }
        var item = L.DomUtil.create('button', 'btn btn-sm btn-ghost-secondary w-100 text-start', menu);
        item.type = 'button';
        item.innerHTML = '<i class="mdi mdi-' + entry.icon + '"></i> ' + entry.text;
        item.addEventListener('click', function (click) {
          // This replaces the menu's content, so Leaflet can no longer tell the
          // click came from the menu: stop it here, or the map would close the menu.
          L.DomEvent.stop(click);
          if (entry.kind === 'label') { labelForm(point); } else { search(entry.kind, point); }
        });
      });
    });
    map.on('click movestart', close);
    document.addEventListener('keydown', function (event) { if (event.key === 'Escape') { close(); } });
  }

  window.NetBoxMap = { render: render };
})();
