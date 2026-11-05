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
    if (marker.object && cardUrl(state, 'marker', marker.id)) { hoverCard(state, layer, cardUrl(state, 'marker', marker.id)); }
    state.markers[marker.id] = layer;
    state.bounds.extend(layer.getLatLng());
    if (state.ready) { addLabel(layer); }
    return layer;
  }

  // The card shown when the mouse rests on a marker with an object, or on a
  // line drawn as a cable's or circuit's route. NetBox renders it (cards.py);
  // it is fetched on the first hover and kept. The mouse can move onto the
  // card to follow its links: it closes a moment after the mouse leaves both.
  function hoverCard(state, layer, url) {
    var timer = null;
    layer.on('mouseover', function (event) {
      cancelHide(state);
      // Markers anchor the card at their point, lines where the mouse is.
      var anchor = layer.getLatLng ? layer.getLatLng() : event.latlng;
      clearTimeout(timer);
      timer = setTimeout(function () { showCard(state, layer, url, anchor); }, 200);
    });
    layer.on('mouseout', function () { clearTimeout(timer); hideSoon(state); });
    layer.on('click dragstart', function () { clearTimeout(timer); hideCard(state); });
  }

  function cardUrl(state, kind, id) {
    var base = state.data[kind + '_card_url'];
    return base ? base.replace('/0/', '/' + id + '/') : null;
  }

  function showCard(state, layer, url, anchor) {
    if (!state.card) {
      state.card = L.DomUtil.create('div', 'nbm-hover', state.map.getContainer());
      L.DomEvent.disableClickPropagation(state.card);
      L.DomEvent.disableScrollPropagation(state.card);
      L.DomEvent.on(state.card, 'mouseenter', function () { cancelHide(state); });
      L.DomEvent.on(state.card, 'mouseleave', function () { hideSoon(state); });
      state.map.on('movestart zoomstart', function () { hideCard(state); });
    }
    state.cardFor = layer;
    function fill(html) {
      if (state.cardFor !== layer || !html) { return; }
      state.card.innerHTML = html;
      state.card.style.display = 'block';
      placeCard(state, anchor);
      // A rack elevation changes the card's size once it has loaded.
      state.card.querySelectorAll('img').forEach(function (img) {
        img.addEventListener('load', function () { placeCard(state, anchor); });
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
  }

  function render(element, data, options) {
    options = options || {};
    var edit = !!options.edit;
    csrfToken = data.csrf_token || csrfToken;
    var layers = data.image_only ? [] : data.tiles.layers;
    // World maps zoom in whole steps: between steps tiles are stretched and
    // look blurred. Image-only maps can go in quarter steps.
    var mapOptions = { zoomSnap: data.image_only ? 0.25 : 1, attributionControl: !data.image_only };
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
      baseLayers[layer.name] = new (rotation ? TurnedTileLayer : L.TileLayer)(layer.url, tileOptions);
    });

    // Everything placed on the map, for fitting the view to it.
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

    // Shapes.
    data.shapes.forEach(function (shape) {
      var style = { color: shape.color, weight: 3, fillOpacity: 0.2, className: shape.link_url ? 'nbm-shape-link' : '' };
      if (shape.object) {
        // A cable or circuit route: the cable's own color, or else its
        // status color (as a class, so it follows NetBox's theme).
        style.weight = 5;
        style.color = shape.route_color || '#6c757d';
        if (!shape.route_color && shape.status) { style.className = 'nbm-route nbm-route-' + shape.status; }
      }
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
      if (shape.object && cardUrl(state, 'shape', shape.id)) {
        // Routes show their cable's or circuit's card instead of a tooltip.
        hoverCard(state, layer, cardUrl(state, 'shape', shape.id));
      } else if (tooltip) {
        layer.bindTooltip(escapeHtml(tooltip), { sticky: true });
      }
      if (edit && (data.can.change_shape || data.can.delete_shape)) {
        var html = '<strong>' + escapeHtml(shape.label || shape.route_name || shape.kind) + '</strong><br>';
        var links = [];
        if (data.can.change_shape) {
          links.push('<a href="#" data-nbm-reshape="' + shape.id + '">' + (shape.kind === 'circle' ? 'Move or resize' : 'Edit points') + '</a>');
          links.push('<a href="' + shape.edit_url + '">' + (shape.kind === 'line' ? 'Label, color, link, route' : 'Label, color, link') + '</a>');
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
      var points = drawing.points.map(function (p) { return [p.lng, p.lat]; });
      if (drawing.kind === 'cable') {
        // A cable route is a line tied to a cable, bundle or circuit.
        state.tool = null;
        say('Pick what this route is for.');
        pickRoute(state, drawing.points[drawing.points.length - 1], function (type, id) {
          api('POST', data.api.shapes, {
            map: data.id, kind: 'line', points: points, object_type: type, object_id: id,
          }).then(reload, failed);
        }, stopTool);
        return;
      }
      saveShape(drawing.kind, points, null);
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
