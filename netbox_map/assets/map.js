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
    state.markers[marker.id] = layer;
    state.bounds.extend(layer.getLatLng());
    if (state.ready) { addLabel(layer); }
    return layer;
  }

  function addLabel(layer) {
    layer.bindTooltip(escapeHtml(layer.nbmLabel), { permanent: true, direction: 'bottom', className: 'nbm-label' });
  }

  // A button under + and − that brings the whole map back into view.
  function fitButton(fitAll) {
    var Control = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        var bar = L.DomUtil.create('div', 'leaflet-bar');
        var button = L.DomUtil.create('a', 'nbm-fit', bar);
        button.href = '#';
        button.title = 'Show the whole map';
        button.setAttribute('role', 'button');
        button.setAttribute('aria-label', 'Show the whole map');
        button.innerHTML = '<i class="mdi mdi-fit-to-screen-outline"></i>';
        L.DomEvent.disableClickPropagation(button);
        L.DomEvent.on(button, 'click', function (event) { L.DomEvent.preventDefault(event); fitAll(); });
        return bar;
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
      mapOptions.maxZoom = 6;
    } else {
      mapOptions.maxZoom = data.tiles.max_zoom;
    }
    var map = L.map(element, mapOptions);
    if (map.attributionControl) { map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>'); }
    if (!data.image_only && data.tiles.url) {
      // NetBox (Django) tells browsers to send no Referer to other sites, and
      // OpenStreetMap's tile servers refuse requests without one. Send just
      // NetBox's address (no page path) with tile requests.
      L.tileLayer(data.tiles.url, {
        attribution: data.tiles.attribution,
        maxZoom: data.tiles.max_zoom,
        referrerPolicy: 'strict-origin-when-cross-origin',
      }).addTo(map);
    }

    // Everything placed on the map, for fitting the view to it.
    var bounds = L.latLngBounds([]);
    var state = { map: map, data: data, overlays: {}, markers: {}, tool: null, bounds: bounds };

    // Overlays, lowest weight first. On an image-only map an overlay that
    // isn't placed yet sits at its own pixel size from the bottom-left corner.
    data.overlays.slice().sort(function (a, b) { return a.weight - b.weight; }).forEach(function (overlay) {
      var corners = overlay.bounds;
      if (!corners && data.image_only) { corners = [[0, 0], [overlay.height || 1000, overlay.width || 1000]]; }
      if (!corners) { return; }
      var layer = L.imageOverlay(overlay.url, corners, {
        opacity: overlay.opacity / 100, zIndex: overlay.weight, interactive: false,
      }).addTo(map);
      state.overlays[overlay.id] = { data: overlay, layer: layer };
      bounds.extend(layer.getBounds());
    });

    // Shapes.
    data.shapes.forEach(function (shape) {
      var style = { color: shape.color, weight: 3, fillOpacity: 0.2 };
      var points = shape.points.map(function (p) { return toLatLng(p[0], p[1]); });
      var layer;
      if (shape.kind === 'circle') {
        layer = L.circle(points[0], Object.assign({ radius: shape.radius }, style));
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
      if (shape.label) { layer.bindTooltip(escapeHtml(shape.label), { sticky: true }); }
      if (edit && (data.can.change_shape || data.can.delete_shape)) {
        var html = '<strong>' + escapeHtml(shape.label || shape.kind) + '</strong><br>';
        var links = [];
        if (data.can.change_shape) { links.push('<a href="' + shape.edit_url + '">Edit</a>'); }
        if (data.can.delete_shape) { links.push('<a href="#" data-nbm-delete-shape="' + shape.id + '">Delete</a>'); }
        layer.bindPopup(html + links.join(' · '));
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
    fitAll();
    var focus = data.highlight && state.markers[data.highlight];
    if (focus && bounds.isValid()) {
      // Closer in than the whole map, centered on the highlighted marker.
      var zoom = data.image_only ? map.getZoom() + 1 : Math.max(map.getZoom(), Math.min(17, data.tiles.max_zoom));
      map.setView(focus.getLatLng(), zoom);
    }
    fitButton(fitAll).addTo(map);

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

    // Delete links in shape popups.
    map.on('popupopen', function (event) {
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
      map.doubleClickZoom.enable();
      toolbar.querySelectorAll('[data-nbm-finish]').forEach(function (b) { b.classList.add('d-none'); });
      say('');
    }

    function startTool(tool, text) {
      stopTool();
      state.tool = tool;
      map.getContainer().style.cursor = 'crosshair';
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
          toolbar.querySelectorAll('[data-nbm-finish]').forEach(function (b) { b.classList.remove('d-none'); });
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
    });
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
