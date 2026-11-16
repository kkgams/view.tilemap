# Tilemap Views

Tilemap painting, map settings and tile extraction for [GAMS](https://github.com/kkgams/gams).

| View | Source → ZIP entry | Screenshot | License | Original work |
| --- | --- | --- | --- | --- |
| Tilemap editor (`view-tilemap`) | `src/views/view-tilemap.js` → `views/view-tilemap.js` | Not available | [Apache-2.0](LICENSE), [notice](NOTICE) | GAMS contributors |
| Settings (`tilemap-settings`) | `src/views/tilemap-settings.js` → `views/tilemap-settings.js` | Not available | [Apache-2.0](LICENSE), [notice](NOTICE) | GAMS contributors |
| Tile extractor (`view-tile-extractor`) | `src/views/view-tile-extractor.js` → `views/view-tile-extractor.js` | Not available | [Apache-2.0](LICENSE), [notice](NOTICE) | GAMS contributors |

## Development

Requires Make, Node.js 24 (dependency-free syntax checks), Python 3, curl, unzip,
zip and shasum. Local launch requires macOS Apple Silicon and network access on
first use; it uses canonical local sources and pinned released supporting Units,
not neighboring checkouts. The editor starts empty; use New or Open.

| Command | Purpose |
| --- | --- |
| `make open` | Download the released Host if absent, then open local `gams.json`. |
| `make check` | Check JavaScript syntax. |
| `make test` | Run native tile-extractor save-format regression tests. |
| `make package` | Build three independent, stable-name ZIPs and `SHA256SUMS` under `build.nosync/`. |
| `make serve-docs DOCS_PORT=8080` | Preview documentation with pinned wiki v1.4.0. |
| `make validate-docs` | Validate documentation. |
| `make docs` | Build `build.nosync/site/`. |
| `make clean` | Remove `build.nosync/`, downloaded `tools/gams.app`, its `tools/gams-release-notices/` and identified configured downloads in `gams_modules/`; preserve supplied Units and refuse tracked files or symlinked deletion paths. |

Tile extraction accepts PNG/QOI backend input. Save the QOI tileset first, then
save the tilemap JSON to include its Project-relative atlas reference. Tilemap
JSON uses object properties and square `tileSize` cells for the editor;
rectangular extraction can be saved as a QOI tileset, not an editor map.

Host downloads are preserved until explicitly cleaned; launch never updates an
existing app or bypasses Gatekeeper. `dev-assets/` is optional user input and is
not packaged or cleaned. See [runtime requirements](docs/index.md#runtime-requirements).
