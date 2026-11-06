# view.tilemap

One separately installable ZIP per View, never npm/OCI. Host contract: GAMS 2.0.3.
Run npm test (Node 24, Python 3 stdlib). release.json binds package identities, deployment maps and hashes.
Absolute imports enumerated in release.json are required Host-owned runtime/util/widget APIs; missing APIs, config or schemas are bugs, not optional fallbacks.
Keep Project Config ids/tags and URLs as deployed. view-markdow spelling is deliberately unchanged.
Blend 1D retains views/view-animation-blend-spaces.js; independently installed 2D requires views/view-animation-blend-space-2d.js in Project Config. No HTML/class behavior is rewritten.
Install using scripts/release.py install (verified checksums), retain metadata under notices/project-units/<package>. Refuse all overwrite collisions.
Dependencies (plugins, sibling Views, UI Services) remain Project configured; static Host imports are documented, not vendored.
HOST-CONTRACT.json includes required dynamic widget paths and known legacy schema limits.
GUI validation pending: Tilemap painting/undo, settings validation and tile extraction. No blanket E2E claim.

## Local development and docs

Use Node.js 24, Python 3, Make, curl and unzip. `make build` checks canonical
local JavaScript and Project configuration; `make test` runs the existing tests.
`make open` opens this repository's `gams.json` in downloaded `tools/gams.app`
(macOS Apple Silicon), with explicit `GAMS_APP_CWD` and no sibling checkout.

`make serve-docs` serves `docs/` using pinned wiki v1.4.0 (`DOCS_PORT` overrides 8080).
`make validate-docs` validates it; `make docs` builds `build/site/`.
Every push to `release` publishes docs through GitHub Pages independently of
version tags. See [development details](docs/index.md) for setup and limitations.

## Publication

Pushing a matching version tag authorizes the GitHub Release; no approval digest
variables or special release branch are required. Tests, source/legal evidence,
exact LICENSE/NOTICE payloads, deterministic archives, SHA256SUMS and no-overwrite
checks remain mandatory. See `PUBLISHING.md`; this migration refreshes no evidence.
