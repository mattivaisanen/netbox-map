# Vendored libraries

The map pages load these files from the plugin itself, so NetBox needs no
internet access for them. Each is the unchanged file from the package's
npm release; only Leaflet's `sourceMappingURL` comment was removed.

| File | Library | Version | Source | Licence |
|---|---|---|---|---|
| `leaflet.js`, `leaflet.css` | Leaflet | 1.9.4 | npm `leaflet@1.9.4`, `dist/` | BSD-2-Clause, `LICENSE-leaflet.txt` |
| `maplibre-gl.js`, `maplibre-gl.css` | MapLibre GL JS | 5.24.0 | npm `maplibre-gl@5.24.0`, `dist/` | BSD-3-Clause, `LICENSE-maplibre.txt` |

To update one, replace its files with the new release's `dist/` files,
update the version here, and check the map pages and the export.
