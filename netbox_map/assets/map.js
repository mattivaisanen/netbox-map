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

  // A round pin with an icon: the object's status color, or the marker's own color.
  function markerIcon(marker, highlighted) {
    var classes = 'nbm-pin';
    if (!marker.color) { classes += ' text-bg-' + (marker.status || 'primary'); }
    if (marker.map_link) { classes += ' nbm-pin-link'; }
    if (marker.square) { classes += ' nbm-pin-square'; }
    if (highlighted) { classes += ' nbm-pin-highlight'; }
    var style = marker.color ? ' style="background-color:' + marker.color + ';color:#fff"' : '';
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
    layer.on('dragend', function () {
      api('PATCH', data.api.markers + marker.id + '/', fromLatLng(layer.getLatLng())).catch(failed);
    });
    hoverCard(state, layer, marker);
    state.markers[marker.id] = layer;
    state.bounds.extend(layer.getLatLng());
    if (state.ready) { addLabel(layer); }
    return layer;
  }

  // The card shown when the mouse rests on a marker with an object. NetBox
  // renders it (cards.py); it is fetched on the first hover and kept.
  function hoverCard(state, layer, marker) {
    if (!marker.object || !state.data.marker_card_url) { return; }
    var url = state.data.marker_card_url.replace('/0/', '/' + marker.id + '/');
    var timer = null;
    layer.on('mouseover', function () {
      timer = setTimeout(function () { showCard(state, layer, url); }, 200);
    });
    layer.on('mouseout click dragstart', function () { clearTimeout(timer); hideCard(state); });
  }

  function showCard(state, layer, url) {
    if (!state.card) {
      state.card = L.DomUtil.create('div', 'nbm-hover', state.map.getContainer());
      state.map.on('movestart zoomstart', function () { hideCard(state); });
    }
    state.cardFor = layer;
    function fill(html) {
      if (state.cardFor !== layer || !html) { return; }
      state.card.innerHTML = html;
      state.card.style.display = 'block';
      placeCard(state, layer);
      // A rack elevation changes the card's height once it has loaded.
      state.card.querySelectorAll('img').forEach(function (img) {
        img.addEventListener('load', function () { placeCard(state, layer); });
      });
    }
    if (url in state.cards) {
      fill(state.cards[url]);
    } else {
      fetch(url, { credentials: 'same-origin' })
        .then(function (response) { return response.ok ? response.text() : ''; })
        .then(function (html) { state.cards[url] = html; fill(html); });
    }
  }

  // Beside the marker, on whichever side has room, and inside the map.
  function placeCard(state, layer) {
    var card = state.card;
    var size = state.map.getSize();
    var point = state.map.latLngToContainerPoint(layer.getLatLng());
    var left = point.x + 24;
    if (left + card.offsetWidth > size.x - 8) { left = point.x - 24 - card.offsetWidth; }
    var top = Math.min(point.y - 24, size.y - card.offsetHeight - 8);
    card.style.left = Math.max(8, left) + 'px';
    card.style.top = Math.max(8, top) + 'px';
  }

  function hideCard(state) {
    state.cardFor = null;
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

  // Map tiles on a turned map. Leaflet works out which tiles to load and
  // where to put them in straight pixels; here the visible area is turned
  // back to straight pixels to pick the tiles, and each tile is placed at
  // its turned position and turned itself.
  var TurnedTileLayer = L.TileLayer.extend({
    _crs: function () { return this._map.options.crs; },
    _straight: function (point) { var c = this._crs(); return turn(point, -c.nbmSin, c.nbmCos); },
    _getTiledPixelBounds: function (center) {
      var b = L.TileLayer.prototype._getTiledPixelBounds.call(this, center);
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
    _getTilePos: function (coords) {
      var c = this._crs();
      return turn(coords.scaleBy(this.getTileSize()), c.nbmSin, c.nbmCos).subtract(this._level.origin);
    },
    _addTile: function (coords, container) {
      L.TileLayer.prototype._addTile.call(this, coords, container);
      var tile = this._tiles[this._tileCoordsToKey(coords)].el;
      var size = this.getTileSize();
      // One pixel larger hides the hairline seams between turned tiles.
      tile.style.width = (size.x + 1) + 'px';
      tile.style.height = (size.y + 1) + 'px';
      tile.style.transformOrigin = '0 0';
      tile.style.transform += ' rotate(' + this._crs().nbmDegrees + 'deg)';
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
          var url = geocoderUrl + (geocoderUrl.indexOf('?') < 0 ? '?' : '&') +
            'format=json&limit=1&q=' + encodeURIComponent(text);
          input.classList.remove('is-invalid');
          // Same as the tiles: the geocoder wants to see which site asks.
          fetch(url, { referrerPolicy: 'strict-origin-when-cross-origin', headers: { 'Accept': 'application/json' } })
            .then(function (response) { return response.json(); })
            .then(function (results) {
              if (!results.length) { input.classList.add('is-invalid'); return; }
              var box = results[0].boundingbox;  // [south, north, west, east] as strings
              if (box) {
                map.fitBounds([[parseFloat(box[0]), parseFloat(box[2])], [parseFloat(box[1]), parseFloat(box[3])]]);
              } else {
                map.setView([parseFloat(results[0].lat), parseFloat(results[0].lon)], 17);
              }
            })
            .catch(function () { input.classList.add('is-invalid'); });
        });
        return form;
      },
    });
    return new Control();
  }

  function render(element, data, options) {
    options = options || {};
    var edit = !!options.edit;
    csrfToken = data.csrf_token || csrfToken;
    var mapOptions = { zoomSnap: 0.25, attributionControl: !data.image_only };
    if (data.image_only) {
      mapOptions.crs = L.CRS.Simple;
      mapOptions.minZoom = -6;
      mapOptions.maxZoom = 8;
    } else {
      // Past the tile server's last level the last tiles are enlarged.
      mapOptions.maxZoom = Math.max(MAX_ZOOM, data.tiles.max_zoom);
    }
    var rotation = ((data.rotation || 0) % 360 + 360) % 360;
    if (rotation) { mapOptions.crs = turnedCrs(mapOptions.crs || L.CRS.EPSG3857, rotation); }
    var map = L.map(element, mapOptions);
    if (rotation) { map.getBoundsZoom = getBoundsZoom; }
    if (map.attributionControl) { map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>'); }
    if (!data.image_only && data.tiles.url) {
      // NetBox (Django) tells browsers to send no Referer to other sites, and
      // OpenStreetMap's tile servers refuse requests without one. Send just
      // NetBox's address (no page path) with tile requests.
      new (rotation ? TurnedTileLayer : L.TileLayer)(data.tiles.url, {
        attribution: data.tiles.attribution,
        maxNativeZoom: data.tiles.max_zoom,
        maxZoom: mapOptions.maxZoom,
        referrerPolicy: 'strict-origin-when-cross-origin',
      }).addTo(map);
    }

    // Everything placed on the map, for fitting the view to it.
    var bounds = L.latLngBounds([]);
    var state = { map: map, data: data, overlays: {}, markers: {}, shapes: {}, cards: {}, tool: null, bounds: bounds };

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

    // Shapes.
    data.shapes.forEach(function (shape) {
      var style = { color: shape.color, weight: 3, fillOpacity: 0.2, className: shape.link_url ? 'nbm-shape-link' : '' };
      var points = shape.points.map(function (p) { return toLatLng(p[0], p[1]); });
      var layer;
      if (shape.kind === 'circle') {
        layer = new (rotation ? TurnedCircle : L.Circle)(points[0], Object.assign({ radius: shape.radius }, style));
      } else if (shape.kind === 'area') {
        layer = L.polygon(points, style);
      } else {
        layer = L.polyline(points, style);
      }
      layer.addTo(map);
      // A circle's bounds need the map's view, which isn't set yet: work them out here.
      if (shape.kind === 'circle') {
        bounds.extend(data.image_only
          ? L.latLngBounds([points[0].lat - shape.radius, points[0].lng - shape.radius],
                           [points[0].lat + shape.radius, points[0].lng + shape.radius])
          : points[0].toBounds(shape.radius * 2));
      } else {
        bounds.extend(layer.getBounds());
      }
      state.shapes[shape.id] = { data: shape, layer: layer };
      var tooltip = shape.label || '';
      if (shape.link_url) { tooltip += (tooltip ? ': ' : '') + 'opens ' + shape.link_name; }
      if (tooltip) { layer.bindTooltip(escapeHtml(tooltip), { sticky: true }); }
      if (edit && (data.can.change_shape || data.can.delete_shape)) {
        var html = '<strong>' + escapeHtml(shape.label || shape.kind) + '</strong><br>';
        var links = [];
        if (data.can.change_shape) {
          links.push('<a href="#" data-nbm-reshape="' + shape.id + '">' + (shape.kind === 'circle' ? 'Move or resize' : 'Edit points') + '</a>');
          links.push('<a href="' + shape.edit_url + '">Label, color, link</a>');
        }
        if (data.can.delete_shape) { links.push('<a href="#" data-nbm-delete-shape="' + shape.id + '">Delete</a>'); }
        layer.bindPopup(html + links.join(' · '));
      } else if (shape.link_url) {
        // A shape linked to another map opens it, like a map marker.
        layer.on('click', function () { window.location.href = shape.link_url; });
      }
    });

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
    if (!data.image_only) { placeSearch(map, data.tiles.geocoder_url).addTo(map); }
    if (rotation) { northArrow(rotation).addTo(map); }

    // Names under the markers. Added once the view is set: a label that is
    // always shown needs the map's position to draw itself.
    Object.keys(state.markers).forEach(function (id) { addLabel(state.markers[id]); });
    state.ready = true;

    // The element may have been sized after the map started (cards, tabs).
    setTimeout(function () { map.invalidateSize(); }, 0);

    if (edit) { startEditor(state, options.toolbar); }
    return map;
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
    var drawing = null;   // { kind, points, preview }

    function stopTool() {
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
        startTool({ draw: kind }, kind === 'circle'
          ? 'Click the center, then a point on the edge.'
          : 'Click the points, then Finish (or double-click the last point).');
        drawing = { kind: kind, points: [], preview: null };
        map.doubleClickZoom.disable();
        if (kind !== 'circle') {
          toolbar.querySelectorAll('[data-nbm-finish], [data-nbm-undo]').forEach(function (b) { b.classList.remove('d-none'); });
        }
      });
    });

    function saveShape(kind, points, radius) {
      var label = window.prompt('Label for the ' + kind + ' (optional):', '');
      if (label === null) { stopTool(); return; }
      api('POST', data.api.shapes, {
        map: data.id, kind: kind, label: label, points: points, radius: radius,
      }).then(reload, failed);
    }

    function finishDrawing() {
      if (!drawing) { return; }
      // A double-click adds its point twice; drop repeats.
      drawing.points = drawing.points.filter(function (p, i, all) { return i === 0 || !p.equals(all[i - 1]); });
      var least = drawing.kind === 'area' ? 3 : 2;
      if (drawing.points.length < least) {
        say('A ' + drawing.kind + ' needs at least ' + least + ' points.');
        return;
      }
      saveShape(drawing.kind, drawing.points.map(function (p) { return [p.lng, p.lat]; }), null);
    }

    toolbar.querySelectorAll('[data-nbm-finish]').forEach(function (button) {
      button.addEventListener('click', finishDrawing);
    });

    // Take back the last point while drawing.
    function undoPoint() {
      if (!drawing || !drawing.points.length) { return; }
      drawing.points.pop();
      redrawPreview();
    }
    toolbar.querySelectorAll('[data-nbm-undo]').forEach(function (button) {
      button.addEventListener('click', undoPoint);
    });

    function redrawPreview() {
      if (drawing.preview) { map.removeLayer(drawing.preview); }
      var style = { color: '#2196f3', dashArray: '4 4', weight: 2 };
      drawing.preview = drawing.kind === 'area' && drawing.points.length > 2
        ? L.polygon(drawing.points, style) : L.polyline(drawing.points, style);
      drawing.preview.addTo(map);
    }

    map.on('click', function (event) {
      var tool = state.tool;
      if (!tool) { return; }
      var point = fromLatLng(event.latlng);
      if (tool.place) {
        api('PATCH', data.api.markers + tool.place + '/', point).then(reload, failed);
        stopTool();
      } else if (tool.add) {
        window.location.href = data.add_marker_url + '&x=' + point.x + '&y=' + point.y;
      } else if (tool.draw === 'circle') {
        drawing.points.push(event.latlng);
        if (drawing.points.length === 2) {
          var center = drawing.points[0];
          // Meters on a world map, map units (pixels) on an image-only one.
          var radius = data.image_only
            ? Math.hypot(event.latlng.lat - center.lat, event.latlng.lng - center.lng)
            : map.distance(center, event.latlng);
          saveShape('circle', [[center.lng, center.lat]], radius);
        }
      } else if (tool.draw) {
        drawing.points.push(event.latlng);
        redrawPreview();
      }
    });

    map.on('dblclick', function () {
      if (state.tool && state.tool.draw && state.tool.draw !== 'circle') { finishDrawing(); }
    });

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
    say(kind === 'circle'
      ? 'Drag the middle to move the circle, the edge handle to resize it. Click the map when done.'
      : 'Drag points to move them, a small midpoint to add one, right-click a point to remove it. Click the map when done.');

    function handle(latlng, small) {
      var h = L.marker(latlng, { draggable: true, icon: handleIcon(small ? 'mid' : 'corner') }).addTo(map);
      handles.push(h);
      return h;
    }

    function save(fields) {
      api('PATCH', data.api.shapes + shape.data.id + '/', fields).catch(failed);
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

    function latlngs() {
      var points = layer.getLatLngs();
      return closed ? points[0] : points;
    }
    function apply(points) { layer.setLatLngs(points); }
    function savePoints() {
      save({ points: latlngs().map(function (p) { return [p.lng, p.lat]; }) });
    }

    function build() {
      clear();
      var points = latlngs().slice();
      points.forEach(function (point, i) {
        var h = handle(point);
        h.on('drag', function () {
          var now = latlngs().slice();
          now[i] = h.getLatLng();
          apply(now);
        });
        h.on('dragend', function () { savePoints(); build(); });
        h.on('contextmenu', function (event) {
          L.DomEvent.stop(event);
          var now = latlngs().slice();
          if (now.length <= least) { say('A ' + kind + ' needs at least ' + least + ' points.'); return; }
          now.splice(i, 1);
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
          var mid = handle(L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2), true);
          mid.on('drag', function () {
            var now = points.slice();
            now.splice(i + 1, 0, mid.getLatLng());
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

    // A search box listing matching objects from NetBox's REST API.
    function search(kind, point) {
      var source = data.search[kind];
      menu.innerHTML = '<input type="search" class="form-control form-control-sm" placeholder="Search ' + kind + 's">' +
        '<div class="nbm-results list-group list-group-flush mt-1"></div>';
      var input = menu.querySelector('input');
      var results = menu.querySelector('.nbm-results');
      var timer = null;

      function load() {
        var url = source.url + (source.url.indexOf('?') < 0 ? '?' : '&') + 'limit=12&brief=1&q=' + encodeURIComponent(input.value);
        api('GET', url).then(function (json) {
          results.innerHTML = '';
          json.results.forEach(function (obj) {
            var key = source.type + ':' + obj.id;
            var placed = data.markers.some(function (m) { return m.object === key; });
            var item = document.createElement('button');
            item.type = 'button';
            item.className = 'list-group-item list-group-item-action py-1 px-2';
            item.disabled = placed;
            item.textContent = obj.display + (placed ? ' (on this map)' : '');
            item.addEventListener('click', function () {
              create({ object_type: source.type, object_id: obj.id, x: point.x, y: point.y });
            });
            results.appendChild(item);
          });
          if (!json.results.length) { results.innerHTML = '<div class="text-secondary small p-1">Nothing found</div>'; }
        }).catch(failed);
      }
      input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(load, 250); });
      input.focus();
      load();
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
      menu = L.DomUtil.create('div', 'nbm-menu card shadow p-1', map.getContainer());
      menu.style.left = event.containerPoint.x + 'px';
      menu.style.top = event.containerPoint.y + 'px';
      // Clicks and scrolling inside the menu must not move the map.
      L.DomEvent.disableClickPropagation(menu);
      L.DomEvent.disableScrollPropagation(menu);
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
