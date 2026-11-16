---
title: Tilemap Views
status: reference
---

# Tilemap Views

Tilemap painting, map settings and tile extraction for [GAMS](https://github.com/kkgams/gams).

| View | Source → ZIP entry | Screenshot | Original work |
| --- | --- | --- | --- |
| Tilemap editor (`view-tilemap`) | `src/views/view-tilemap.js` → `views/view-tilemap.js` | Not available | GAMS contributors |
| Settings (`tilemap-settings`) | `src/views/tilemap-settings.js` → `views/tilemap-settings.js` | Not available | GAMS contributors |
| Tile extractor (`view-tile-extractor`) | `src/views/view-tile-extractor.js` → `views/view-tile-extractor.js` | Not available | GAMS contributors |

## Development

Requires Make, Node.js 24, Python 3, curl, zip, unzip and shasum. Launch requires
macOS Apple Silicon. Supporting Units are pinned in `gams.json`; no sibling
checkout is needed. Use New or Open to load a map; settings and extraction use
the local companion Views. File selection and properties use released Views;
tile detection uses the released plugin.

| Command | Purpose |
| --- | --- |
| `make open` | Open local sources in the released Host with explicit `GAMS_APP_CWD` and `GAMS_CONFIG`. |
| `make check` | Check JavaScript syntax without dependencies. |
| `make test` | Run native tile-extractor save-format regression tests. |
| `make package` | Build `view.tilemap.zip`, `view.tilemap-settings.zip`, `view.tile-extractor.zip` and `SHA256SUMS` under `build.nosync/`. |
| `make serve-docs DOCS_PORT=8080` | Preview this wiki with pinned justgook/wiki v1.4.0. |
| `make validate-docs` | Validate wiki content. |
| `make docs` | Build `build.nosync/site/`. |
| `make clean` | Delete generated `build.nosync/`, downloaded Host and notices under `tools/`, and identified configured downloads in `gams_modules/`; preserve supplied Units and refuse tracked files and symlinked deletion paths. |

First launch needs network access and preserves notices beside `tools/gams.app`.
Existing downloads are not updated implicitly and Gatekeeper is not bypassed.
User inputs in `dev-assets/` are neither packaged nor cleaned. JavaScript loads
directly from `src/views/`; there is no compilation step.

## Extracted output

The detection backend accepts PNG and QOI source bytes. Save the QOI tileset
first, then save the tilemap JSON to include that atlas's Project-relative path.
The map uses object-valued properties and the editor's square `tileSize` cells.
Rectangular extraction can be exported as a QOI tileset; saving it as an editor
map fails explicitly rather than silently using an incorrect square size.

## Runtime requirements

The original integration contract targets GAMS 2.0.3. Views require browser DOM,
custom elements, Host semantic CSS and configured plugin/service providers.
Missing required APIs, configuration or schemas are errors, not optional features.
The local Project supplies filesystem, layout and tile-detection plugins, UI
Services, file chooser and properties Views through explicit released pins.

| View | Host-owned imports |
| --- | --- |
| Tilemap | `/core/runtime.js`, `/util/tilemap-render.js`, `/util/undo.js`, `/util/view-canvas-base.js`, `/util/view-plugin.js` |
| Settings | `/core/runtime.js`, `/util/view-plugin.js` |
| Tile extractor | `/core/runtime.js`, `/util/qoi/decode.js`, `/util/view-canvas-base.js` |

These Host helpers are not bundled. Settings retains its JSON-schema validation
TODO; schema conformance is not claimed. Syntax checks do not verify painting,
undo, settings validation or extraction in the native GUI.
