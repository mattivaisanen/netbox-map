/*
 * Saves a map as a file: PNG, SVG or PDF, as it is shown on the screen.
 *
 * NetBoxMapExport.control(map, name) adds the button for it (map.js calls
 * it for every map). The file is built from what Leaflet has drawn:
 *
 * - background tiles and overlay images become <image> elements, read
 *   into the file itself, so it opens anywhere without the tile server;
 * - areas, circles and lines (Leaflet's own SVG) are copied with the
 *   colors and widths the page gives them;
 * - markers, names and the copyright line (HTML) are drawn again as
 *   boxes and text.
 *
 * That makes the SVG. The PNG is the SVG drawn at twice the size, and the
 * PDF is a one-page PDF holding the PNG's pixels. No libraries.
 */
(function () {
  'use strict';

  // PNG and PDF have this many pixels per screen pixel, for sharp prints.
  var SCALE = 2;
  // A PDF page measures 72 points per inch, a screen 96 pixels.
  var POINTS_PER_PIXEL = 72 / 96;
  // Leaflet panes that are left out: open popups, and tooltips that only
  // show while the mouse is on something.
  var SKIPPED_PANES = ['leaflet-popup-pane', 'leaflet-tooltip-pane'];
  // Editor handles (overlay corners, line points) are not part of the map.
  var SKIPPED_CLASSES = ['nbm-handle'];
  // Styles copied onto the shapes and lines, which get them from map.css
  // (colors are copied separately).
  var SHAPE_STYLES = [
    'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap',
    'stroke-linejoin', 'fill-opacity', 'fill-rule', 'opacity',
  ];

  function escapeXml(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c];
    });
  }

  function number(value) { return Math.round(value * 1000) / 1000; }

  //
  // Colors and positions
  //

  // Any CSS color (including color-mix() and color()) as {hex, alpha},
  // read back from a one-pixel canvas so that every SVG viewer knows it.
  var colorCanvas = null;
  var colorCache = {};
  function solidColor(css) {
    if (!css || css === 'none' || css === 'transparent') { return null; }
    if (colorCache[css] !== undefined) { return colorCache[css]; }
    if (!colorCanvas) {
      colorCanvas = document.createElement('canvas');
      colorCanvas.width = colorCanvas.height = 1;
    }
    var ctx = colorCanvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    var p = ctx.getImageData(0, 0, 1, 1).data;
    var color = p[3] === 0 ? null : {
      hex: '#' + [p[0], p[1], p[2]].map(function (v) { return (v + 0x100).toString(16).slice(1); }).join(''),
      alpha: number(p[3] / 255),
    };
    colorCache[css] = color;
    return color;
  }

  // fill="…" fill-opacity="…" (or stroke) for a CSS color; '' for none.
  function paint(attribute, css) {
    var color = solidColor(css);
    if (!color) { return ''; }
    var text = ' ' + attribute + '="' + color.hex + '"';
    if (color.alpha < 1) { text += ' ' + attribute + '-opacity="' + color.alpha + '"'; }
    return text;
  }

  // How `element` is turned and scaled on the screen: its own CSS
  // transforms and those of everything around it, without the moves.
  function turnAndScale(element, root) {
    var m = new DOMMatrix();
    for (var node = element; node && node !== root; node = node.parentElement) {
      var transform = getComputedStyle(node).transform;
      if (transform && transform !== 'none') {
        var own = new DOMMatrix(transform);
        own.e = own.f = 0;
        m = own.multiply(m);
      }
    }
    return m;
  }

  // The SVG transform that puts a w × h box where `element` is shown. An
  // element's middle is the middle of its box on the screen, however it is
  // turned, so: move to that middle, turn and scale, go back half the size.
  function placement(element, root, origin, w, h, box) {
    box = box || element.getBoundingClientRect();
    var m = turnAndScale(element, root)
      .preMultiplySelf(new DOMMatrix().translateSelf(box.left + box.width / 2 - origin.left, box.top + box.height / 2 - origin.top))
      .translateSelf(-w / 2, -h / 2);
    return 'matrix(' + [m.a, m.b, m.c, m.d, m.e, m.f].map(number).join(' ') + ')';
  }

  // How see-through `element` is, counting everything around it.
  function opacityOf(element, root) {
    var opacity = 1;
    for (var node = element; node && node !== root; node = node.parentElement) {
      opacity *= parseFloat(getComputedStyle(node).opacity);
    }
    return number(opacity);
  }

  // CSS filters on `element` and the elements around it (a vector
  // background's gray, for one), as one filter.
  function filterOf(element, root) {
    var filters = [];
    for (var node = element; node && node !== root; node = node.parentElement) {
      var filter = getComputedStyle(node).filter;
      if (filter && filter !== 'none') { filters.push(filter); }
    }
    return filters.join(' ');
  }

  function onScreen(box, origin) {
    return box.width > 0 && box.height > 0 && box.right > origin.left && box.left < origin.right &&
      box.bottom > origin.top && box.top < origin.bottom;
  }

  //
  // Images, read into the file
  //

  // Resolves with a data: address of the image at `url`, with a CSS filter
  // (a gray map, say) painted in, or with null when the server doesn't
  // allow reading it (no CORS headers).
  function readImage(url, filter) {
    if (url.indexOf('data:') === 0 && !filter) { return Promise.resolve(url); }
    return fetch(url, {
      mode: 'cors', credentials: 'same-origin', referrerPolicy: 'strict-origin-when-cross-origin',
    }).then(function (response) {
      if (!response.ok) { throw new Error(response.status); }
      return response.blob();
    }).then(function (blob) {
      return filter ? filtered(blob, filter) : dataUrl(blob);
    }).catch(function () { return null; });
  }

  function dataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.onload = function () { resolve(image); };
      image.onerror = function () { reject(new Error('The picture could not be drawn.')); };
      image.src = src;
    });
  }

  // SVG viewers don't all know CSS filters, so they are painted into the picture.
  function filtered(blob, filter) {
    var url = URL.createObjectURL(blob);
    return loadImage(url).then(function (image) {
      var canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      var ctx = canvas.getContext('2d');
      ctx.filter = filter;
      ctx.drawImage(image, 0, 0);
      return canvas.toDataURL('image/png');
    }).finally(function () { URL.revokeObjectURL(url); });
  }

  //
  // Fonts
  //
  // A picture made from an SVG can't use the page's fonts, and markers
  // draw their icons with an icon font, so the fonts that the text uses
  // are put into the file.

  function familyName(family) { return family.split(',')[0].trim().replace(/^["']|["']$/g, ''); }

  // The page's @font-face rules, from the style sheets it may read.
  function fontFaces() {
    var faces = [];
    function walk(rules, base) {
      Array.prototype.forEach.call(rules, function (rule) {
        if (rule.cssRules) { walk(rule.cssRules, base); }
        if (rule.type !== CSSRule.FONT_FACE_RULE) { return; }
        var src = rule.style.getPropertyValue('src');
        var urls = [];
        src.replace(/url\(\s*["']?([^"')]+)["']?\s*\)\s*(?:format\(\s*["']?([^"')]+)["']?\s*\))?/g, function (all, url, format) {
          urls.push({ url: new URL(url, base).href, format: format || '' });
        });
        // woff2 is the smallest; any other kind the browser can read will do.
        urls.sort(function (a, b) { return (b.format === 'woff2') - (a.format === 'woff2'); });
        if (!urls.length) { return; }
        faces.push({
          family: familyName(rule.style.getPropertyValue('font-family')),
          weight: rule.style.getPropertyValue('font-weight') || '400',
          style: rule.style.getPropertyValue('font-style') || 'normal',
          range: rule.style.getPropertyValue('unicode-range'),
          url: urls[0].url,
        });
      });
    }
    Array.prototype.forEach.call(document.styleSheets, function (sheet) {
      try { walk(sheet.cssRules, sheet.href || document.baseURI); } catch (e) { /* another site's style sheet */ }
    });
    return faces;
  }

  // True when a face's weight ("400", "bold" or a range such as "100 900") covers `weight`.
  function weightCovers(face, weight) {
    var named = { normal: 400, bold: 700 };
    var parts = face.split(/\s+/).map(function (w) { return named[w] || parseInt(w, 10); });
    return weight >= parts[0] && weight <= (parts[1] || parts[0]);
  }

  // True when a face's unicode-range covers `code`; a face without one covers everything.
  function rangeCovers(range, code) {
    if (!range) { return true; }
    return range.split(',').some(function (part) {
      var m = part.trim().replace(/^u\+/i, '').split('-');
      var from = parseInt(m[0].replace(/\?/g, '0'), 16);
      var to = parseInt((m[1] || m[0]).replace(/\?/g, 'f'), 16);
      return code >= from && code <= to;
    });
  }

  // <style> with the faces the text in the file uses, read into it.
  function fontStyle(used) {
    var wanted = fontFaces().filter(function (face) {
      var uses = used[face.family];
      return uses && uses.some(function (use) {
        return weightCovers(face.weight, use.weight) && face.style === use.style && rangeCovers(face.range, use.code);
      });
    });
    return Promise.all(wanted.map(function (face) {
      return readImage(face.url).then(function (data) {
        if (!data) { return ''; }
        return '@font-face{font-family:"' + face.family + '";font-weight:' + face.weight + ';font-style:' + face.style +
          (face.range ? ';unicode-range:' + face.range : '') + ';src:url(' + data + ')}';
      });
    })).then(function (rules) {
      rules = rules.filter(Boolean);
      return rules.length ? '<style>' + rules.join('') + '</style>' : '';
    });
  }

  //
  // Building the SVG
  //

  function Drawing(map) {
    this.root = map.getContainer();
    this.origin = this.root.getBoundingClientRect();
    this.width = Math.round(this.origin.width);
    this.height = Math.round(this.origin.height);
    this.parts = [];      // SVG text, or promises of it (images), in drawing order
    this.fonts = {};      // family: [{weight, style, code}], for fontStyle()
    this.missing = 0;     // images the servers didn't let us read
  }

  // Everything in `element`, bottom first, as the browser stacks it.
  Drawing.prototype.walk = function (element) {
    var style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) { return; }
    if (SKIPPED_CLASSES.some(function (c) { return element.classList.contains(c); })) { return; }
    var tag = element.tagName.toLowerCase();
    if (tag === 'img') { return this.image(element, style); }
    if (tag === 'svg') { return this.shapes(element); }
    if (tag === 'canvas') { return this.canvas(element); }
    this.box(element, style);
    this.glyph(element);
    var self = this;
    stacked(element.childNodes).forEach(function (child) {
      if (child.nodeType === Node.TEXT_NODE) { self.text(child); }
      if (child.nodeType === Node.ELEMENT_NODE) { self.walk(child); }
    });
  };

  // Child nodes in stacking order: by z-index, ties in page order.
  function stacked(nodes) {
    return Array.prototype.map.call(nodes, function (node, i) {
      var z = node.nodeType === Node.ELEMENT_NODE ? parseInt(getComputedStyle(node).zIndex, 10) || 0 : 0;
      return { node: node, z: z, i: i };
    }).sort(function (a, b) { return a.z - b.z || a.i - b.i; }).map(function (e) { return e.node; });
  }

  // A tile or an overlay image.
  Drawing.prototype.image = function (img, style) {
    var box = img.getBoundingClientRect();
    if (!img.complete || !img.naturalWidth || !onScreen(box, this.origin)) { return; }
    var w = img.offsetWidth;
    var h = img.offsetHeight;
    var where = placement(img, this.root, this.origin, w, h, box);
    var opacity = opacityOf(img, this.root);
    var filter = style.filter && style.filter !== 'none' ? style.filter : '';
    var self = this;
    this.parts.push(readImage(img.currentSrc || img.src, filter).then(function (data) {
      if (!data) { self.missing += 1; return ''; }
      return '<image transform="' + where + '" width="' + number(w) + '" height="' + number(h) + '"' +
        (opacity < 1 ? ' opacity="' + opacity + '"' : '') + ' preserveAspectRatio="none" xlink:href="' + data + '"/>';
    }));
  };

  // Leaflet's SVG with the areas, circles and lines: copied, with the
  // styles that come from style sheets written onto each shape.
  Drawing.prototype.shapes = function (svg) {
    var w = parseFloat(svg.getAttribute('width'));
    var h = parseFloat(svg.getAttribute('height'));
    if (!w || !h) { return; }
    var copy = svg.cloneNode(true);
    var originals = svg.querySelectorAll('*');
    var copies = copy.querySelectorAll('*');
    for (var i = originals.length - 1; i >= 0; i--) {
      var computed = getComputedStyle(originals[i]);
      var shape = copies[i];
      if (computed.display === 'none' || computed.visibility === 'hidden' ||
          (SHAPE_TAGS.test(shape.tagName) && !visibleShape(computed))) {
        shape.remove();
        continue;
      }
      writeStyles(shape, computed);
    }
    ['class', 'style', 'pointer-events'].forEach(function (name) { copy.removeAttribute(name); });
    var opacity = opacityOf(svg, this.root);
    this.parts.push('<g transform="' + placement(svg, this.root, this.origin, w, h) + '"' +
      (opacity < 1 ? ' opacity="' + opacity + '"' : '') + '>' + new XMLSerializer().serializeToString(copy) + '</g>');
  };

  var SHAPE_TAGS = /^(path|circle|ellipse|rect|line|polyline|polygon)$/i;

  // The see-through lines that only take the mouse are left out.
  function visibleShape(computed) {
    var strokes = solidColor(computed.stroke) && parseFloat(computed.strokeOpacity) > 0 && parseFloat(computed.strokeWidth) > 0;
    var fills = solidColor(computed.fill) && parseFloat(computed.fillOpacity) > 0;
    return !!(strokes || fills);
  }

  // Writes the page's styles onto a copied shape as plain SVG attributes.
  function writeStyles(shape, computed) {
    SHAPE_STYLES.forEach(function (name) {
      var value = computed.getPropertyValue(name);
      if (value && value !== 'none' && value !== 'normal') { shape.setAttribute(name, value.replace(/px/g, '')); }
    });
    // Colors in the form every viewer knows; a see-through color adds to the opacity.
    ['stroke', 'fill'].forEach(function (name) {
      var color = solidColor(computed.getPropertyValue(name));
      shape.setAttribute(name, color ? color.hex : 'none');
      if (color && color.alpha < 1) {
        shape.setAttribute(name + '-opacity', number(parseFloat(computed.getPropertyValue(name + '-opacity')) * color.alpha));
      }
    });
    ['class', 'style', 'pointer-events'].forEach(function (name) { shape.removeAttribute(name); });
  }

  Drawing.prototype.canvas = function (canvas) {
    var box = canvas.getBoundingClientRect();
    if (!onScreen(box, this.origin)) { return; }
    var w = canvas.offsetWidth;
    var h = canvas.offsetHeight;
    var filter = filterOf(canvas, this.root);
    var source = canvas;
    if (filter) {
      // Drawn once more with the filter, which an SVG file wouldn't keep.
      source = document.createElement('canvas');
      source.width = canvas.width;
      source.height = canvas.height;
      var ctx = source.getContext('2d');
      ctx.filter = filter;
      ctx.drawImage(canvas, 0, 0);
    }
    this.parts.push('<image transform="' + placement(canvas, this.root, this.origin, w, h, box) + '" width="' + w +
      '" height="' + h + '" preserveAspectRatio="none" xlink:href="' + source.toDataURL('image/png') + '"/>');
  };

  // An HTML element's background and border (a marker's pin, a name's backing).
  Drawing.prototype.box = function (element, style) {
    var fill = solidColor(style.backgroundColor);
    var borderWidth = parseFloat(style.borderTopWidth) || 0;
    var border = borderWidth && style.borderTopStyle !== 'none' ? solidColor(style.borderTopColor) : null;
    if (!fill && !border) { return; }
    var box = element.getBoundingClientRect();
    if (!onScreen(box, this.origin)) { return; }
    var w = element.offsetWidth;
    var h = element.offsetHeight;
    var radius = style.borderTopLeftRadius.split(' ');
    function length(value, size) { return /%$/.test(value) ? size * parseFloat(value) / 100 : parseFloat(value) || 0; }
    var rx = Math.min(length(radius[0], w), w / 2);
    var ry = Math.min(length(radius[1] || radius[0], h), h / 2);
    var opacity = opacityOf(element, this.root);
    // The border is drawn inside the box, as CSS draws it.
    var inset = border ? borderWidth / 2 : 0;
    this.parts.push('<rect transform="' + placement(element, this.root, this.origin, w, h, box) + '" x="' + number(inset) +
      '" y="' + number(inset) + '" width="' + number(w - 2 * inset) + '" height="' + number(h - 2 * inset) + '"' +
      (rx ? ' rx="' + number(Math.max(rx - inset, 0)) + '" ry="' + number(Math.max(ry - inset, 0)) + '"' : '') +
      (fill ? paint('fill', style.backgroundColor) : ' fill="none"') +
      (border ? paint('stroke', style.borderTopColor) + ' stroke-width="' + number(borderWidth) + '"' : '') +
      (opacity < 1 ? ' opacity="' + opacity + '"' : '') + '/>');
  };

  // An icon from an icon font: a character the style sheet puts before the element.
  Drawing.prototype.glyph = function (element) {
    var before = getComputedStyle(element, '::before');
    var content = before.content;
    if (!content || content === 'none' || content === 'normal' || !/^["']/.test(content)) { return; }
    var text = content.slice(1, -1).replace(/\\(.)/g, '$1');
    if (!text) { return; }
    this.write(text, element, before, element.getBoundingClientRect());
  };

  // A piece of text: a name, a link in the copyright line.
  Drawing.prototype.text = function (node) {
    var text = node.textContent.replace(/\s+/g, ' ').trim();
    if (!text || !node.parentElement) { return; }
    var range = document.createRange();
    range.selectNodeContents(node);
    this.write(text, node.parentElement, getComputedStyle(node.parentElement), range.getBoundingClientRect());
  };

  // Text in the middle of `box`, in the element's font, turned with it.
  Drawing.prototype.write = function (text, element, style, box) {
    if (!onScreen(box, this.origin)) { return; }
    var color = solidColor(style.color);
    if (!color) { return; }
    var family = familyName(style.fontFamily);
    var weight = parseInt(style.fontWeight, 10) || 400;
    (this.fonts[family] = this.fonts[family] || []).push({ weight: weight, style: style.fontStyle, code: text.codePointAt(0) });
    var opacity = opacityOf(element, this.root);
    // Turned with the element, about the middle of the text.
    var m = turnAndScale(element, this.root);
    var where = 'matrix(' + [m.a, m.b, m.c, m.d, box.left + box.width / 2 - this.origin.left,
      box.top + box.height / 2 - this.origin.top].map(number).join(' ') + ')';
    this.parts.push('<text transform="' + where + '" text-anchor="middle" dominant-baseline="central"' +
      ' font-family="' + escapeXml(style.fontFamily) + '" font-size="' + number(parseFloat(style.fontSize)) + '"' +
      ' font-weight="' + weight + '"' + (style.fontStyle !== 'normal' ? ' font-style="' + style.fontStyle + '"' : '') +
      paint('fill', style.color) + (opacity < 1 ? ' opacity="' + opacity + '"' : '') + '>' + escapeXml(text) + '</text>');
  };

  // The whole SVG file, as text. Resolves with {svg, width, height, missing}.
  function buildSvg(map) {
    var drawing = new Drawing(map);
    var root = drawing.root;
    var background = getComputedStyle(root).backgroundColor;
    drawing.parts.push('<rect width="100%" height="100%"' + (paint('fill', background) || ' fill="#fff"') + '/>');
    // Panes bottom up: tiles, overlays, areas, lines, markers, names.
    var panes = Array.prototype.filter.call(root.querySelectorAll('.leaflet-map-pane > .leaflet-pane'), function (pane) {
      return !SKIPPED_PANES.some(function (c) { return pane.classList.contains(c); });
    });
    stacked(panes).forEach(function (pane) { drawing.walk(pane); });
    // The north arrow of a turned map, and the copyright line the tile servers ask for.
    root.querySelectorAll('.nbm-north, .leaflet-control-attribution').forEach(function (control) { drawing.walk(control); });
    return Promise.all(drawing.parts).then(function (parts) {
      return fontStyle(drawing.fonts).then(function (fonts) {
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1"' +
          ' width="' + drawing.width + '" height="' + drawing.height + '" viewBox="0 0 ' + drawing.width + ' ' + drawing.height + '">' +
          fonts + parts.join('') + '</svg>';
        return { svg: svg, width: drawing.width, height: drawing.height, missing: drawing.missing };
      });
    });
  }

  //
  // PNG and PDF
  //

  // The SVG drawn on a canvas, SCALE times its size.
  function drawSvg(result) {
    var url = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml' }));
    return loadImage(url).then(function (image) {
      var canvas = document.createElement('canvas');
      canvas.width = result.width * SCALE;
      canvas.height = result.height * SCALE;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas;
    }).finally(function () { URL.revokeObjectURL(url); });
  }

  function canvasBlob(canvas, type) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) { return blob ? resolve(blob) : reject(new Error('The picture is too large.')); }, type);
    });
  }

  // Squeezes bytes the way PDF's FlateDecode reads them (zlib).
  function deflate(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Response(stream).arrayBuffer().then(function (buffer) { return new Uint8Array(buffer); });
  }

  // A PDF text string, in UTF-16 so that any name works.
  function pdfText(text) {
    var hex = 'FEFF';
    for (var i = 0; i < text.length; i++) { hex += (text.charCodeAt(i) + 0x10000).toString(16).slice(1).toUpperCase(); }
    return '<' + hex + '>';
  }

  // A one-page PDF: the canvas's pixels as one image filling the page,
  // which is the size the map has on the screen.
  function pdfBlob(canvas, title) {
    var w = canvas.width;
    var h = canvas.height;
    var pixels = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    var rgb = new Uint8Array(w * h * 3);
    for (var p = 0, q = 0; p < pixels.length; p += 4) {
      rgb[q++] = pixels[p];
      rgb[q++] = pixels[p + 1];
      rgb[q++] = pixels[p + 2];
    }
    return deflate(rgb).then(function (image) {
      var pageW = number(w / SCALE * POINTS_PER_PIXEL);
      var pageH = number(h / SCALE * POINTS_PER_PIXEL);
      var drawImage = 'q ' + pageW + ' 0 0 ' + pageH + ' 0 0 cm /Map Do Q';
      var objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageW + ' ' + pageH + '] /Resources << /XObject << /Map 4 0 R >> >> /Contents 5 0 R >>',
        [
          '<< /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h +
            ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ' + image.length + ' >>',
          image,
        ],
        ['<< /Length ' + drawImage.length + ' >>', drawImage],
        '<< /Title ' + pdfText(title) + ' /Producer (NetBox Map) >>',
      ];
      var encoder = new TextEncoder();
      var chunks = [];
      var size = 0;
      function add(part) {
        var bytes = typeof part === 'string' ? encoder.encode(part) : part;
        chunks.push(bytes);
        size += bytes.length;
      }
      var offsets = [];
      add('%PDF-1.4\n%âãÏÓ\n');
      objects.forEach(function (object, i) {
        offsets.push(size);
        add((i + 1) + ' 0 obj\n');
        if (Array.isArray(object)) {
          add(object[0] + '\nstream\n');
          add(object[1]);
          add('\nendstream');
        } else {
          add(object);
        }
        add('\nendobj\n');
      });
      var xref = size;
      add('xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n');
      offsets.forEach(function (offset) { add((offset + 1e10).toString().slice(1) + ' 00000 n \n'); });
      add('trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R /Info 6 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
      return new Blob(chunks, { type: 'application/pdf' });
    });
  }

  //
  // Saving
  //

  function save(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  // The map's name as a file name.
  function fileName(name, extension) {
    var base = String(name || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'map';
    return base + '.' + extension;
  }

  // Makes the file and saves it. `format` is 'png', 'svg' or 'pdf'.
  function exportMap(map, name, format) {
    return buildSvg(map).then(function (result) {
      var made;
      if (format === 'svg') {
        made = Promise.resolve(new Blob([result.svg], { type: 'image/svg+xml' }));
      } else {
        made = drawSvg(result).then(function (canvas) {
          return format === 'pdf' ? pdfBlob(canvas, name || 'Map') : canvasBlob(canvas, 'image/png');
        });
      }
      return made.then(function (blob) {
        save(blob, fileName(name, format));
        return result.missing;
      });
    });
  }

  var FORMATS = [
    ['png', 'PNG image', 'mdi-file-image-outline'],
    ['svg', 'SVG drawing', 'mdi-svg'],
    ['pdf', 'PDF document', 'mdi-file-pdf-box'],
  ];

  // A button under the others on the map's left, with a menu of the three kinds of file.
  function control(map, name) {
    var Control = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        var bar = L.DomUtil.create('div', 'leaflet-bar nbm-export');
        var button = L.DomUtil.create('a', 'nbm-export-button', bar);
        button.href = '#';
        button.title = 'Save the map as a file';
        button.setAttribute('role', 'button');
        button.setAttribute('aria-label', button.title);
        button.setAttribute('aria-haspopup', 'menu');
        button.innerHTML = '<i class="mdi mdi-download"></i>';
        var menu = L.DomUtil.create('div', 'dropdown-menu nbm-export-menu', bar);
        menu.setAttribute('role', 'menu');
        FORMATS.forEach(function (format) {
          var item = L.DomUtil.create('button', 'dropdown-item', menu);
          item.type = 'button';
          item.setAttribute('role', 'menuitem');
          item.dataset.format = format[0];
          item.innerHTML = '<i class="mdi ' + format[2] + ' me-1"></i>' + format[1];
        });
        L.DomEvent.disableClickPropagation(bar);
        L.DomEvent.disableScrollPropagation(bar);

        function close() { menu.classList.remove('show'); }
        L.DomEvent.on(button, 'click', function (event) {
          L.DomEvent.preventDefault(event);
          if (bar.classList.contains('nbm-busy')) { return; }
          menu.classList.toggle('show');
        });
        map.on('click movestart', close);
        document.addEventListener('click', function (event) { if (!bar.contains(event.target)) { close(); } });

        L.DomEvent.on(menu, 'click', function (event) {
          L.DomEvent.preventDefault(event);
          var item = event.target.closest('[data-format]');
          if (!item) { return; }
          close();
          bar.classList.add('nbm-busy');
          button.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i>';
          exportMap(map, name, item.dataset.format).then(function (missing) {
            if (missing) {
              window.alert(missing + ' background pictures could not be read from their server and are missing from the file.');
            }
          }).catch(function (error) {
            window.alert('Saving the map failed: ' + error.message);
          }).finally(function () {
            bar.classList.remove('nbm-busy');
            button.innerHTML = '<i class="mdi mdi-download"></i>';
          });
        });
        return bar;
      },
    });
    return new Control();
  }

  window.NetBoxMapExport = { control: control, exportMap: exportMap, buildSvg: buildSvg };
})();
