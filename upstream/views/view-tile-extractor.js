import { runtime, unwrap } from "/core/runtime.js"
import { ViewCanvasBase } from "/util/view-canvas-base.js"
import { decode as decodeQoi } from "/util/qoi/decode.js"

const TEXT_INPUT_ATTRS = 'autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"'
const TILE_COLORS = [
    "rgba(230,25,75,0.30)",
    "rgba(60,180,75,0.30)",
    "rgba(255,225,25,0.30)",
    "rgba(67,99,216,0.30)",
    "rgba(245,130,49,0.30)",
    "rgba(145,30,180,0.30)",
    "rgba(70,240,240,0.30)",
    "rgba(240,50,230,0.30)",
]

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

function basename(path) {
    const parts = String(path || "")
        .split("/")
        .filter(Boolean)
    return parts.length > 0 ? parts[parts.length - 1] : "extracted"
}

function stem(path) {
    return basename(path).replace(/\.[^.]+$/u, "") || "extracted"
}

function getExtension(path) {
    const name = basename(path)
    const parts = name.split(".")
    if (parts.length <= 1) return ""
    return parts.pop().toLowerCase()
}

function mimeTypeForPath(path) {
    const ext = getExtension(path)
    if (ext === "png") return "image/png"
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg"
    if (ext === "webp") return "image/webp"
    if (ext === "gif") return "image/gif"
    if (ext === "bmp") return "image/bmp"
    return "application/octet-stream"
}

function createCanvasFromQoi(bytes) {
    const decoded = decodeQoi(bytes.buffer, bytes.byteOffset, bytes.byteLength, 4)
    const pixels = new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength)
    const canvas = document.createElement("canvas")
    canvas.width = decoded.width
    canvas.height = decoded.height
    const ctx = canvas.getContext("2d")
    assert(ctx, "view-tile-extractor qoi canvas requires 2d context")
    ctx.putImageData(new ImageData(pixels, decoded.width, decoded.height), 0, 0)
    return canvas
}

export class ViewTileExtractor extends ViewCanvasBase {
    static get observedAttributes() {
        return ["data-source"]
    }

    constructor() {
        super()
        this.sourcePath = ""
        this.tilesetPath = ""
        this.tilemapPath = ""
        this.tileW = 16
        this.tileH = 16
        this.tolerance = 0
        this.skipNthPixel = 1
        this.showGrid = true
        this.highlightDuplicates = true
        this.sourceImage = null
        this.sourceBytes = null
        this.sourceWidth = 0
        this.sourceHeight = 0
        this.extractOutput = null
        this.hoveredTile = { x: -1, y: -1 }
        this.hoverTooltipTileKey = ""
        this.hoverTooltipId = 0
        this.statusElement = null
        this.resultElement = null
        this.previewBody = null
    }

    connectedCallback() {
        if (this.dataset.ready) return
        this.dataset.ready = "1"

        this.sourcePath = String(this.popupProps?.path || this.getAttribute("data-source") || "").trim()

        this.innerHTML = `
      <canvas data-element="canvas"></canvas>
      <aside data-element="settings">
        <fieldset>
          <legend>Tile size</legend>
          <label>Width
            <input type="number" min="1" step="1" data-field="tile-w" value="${this.tileW}" ${TEXT_INPUT_ATTRS}>
          </label>
          <label>Height
            <input type="number" min="1" step="1" data-field="tile-h" value="${this.tileH}" ${TEXT_INPUT_ATTRS}>
          </label>
          <button type="button" data-action="detect-size">Auto detect size</button>
          <label>Tolerance
            <input type="number" min="0" step="1" data-field="tolerance" value="${this.tolerance}" ${TEXT_INPUT_ATTRS}>
          </label>
          <label>Sample every Nth pixel
            <input type="number" min="1" step="1" data-field="skip-nth-pixel" value="${this.skipNthPixel}" ${TEXT_INPUT_ATTRS}>
          </label>
        </fieldset>
        <fieldset>
          <legend>Display</legend>
          <label><input type="checkbox" data-field="show-grid" checked> Show grid</label>
          <label><input type="checkbox" data-field="highlight-duplicates" checked> Highlight duplicate tiles</label>
        </fieldset>
        <table data-element="tilebank">
          <caption>Top duplicate tiles</caption>
          <thead><tr><th>ID</th><th>Uses</th><th>Source</th><th>Hash</th></tr></thead>
          <tbody></tbody>
        </table>
      </aside>
      <footer data-element="footer">
        <output data-element="status">Ready</output>
        <output data-element="result">No extraction performed</output>
      </footer>
    `

        this.statusElement = this.querySelector('[data-element="status"]')
        this.resultElement = this.querySelector('[data-element="result"]')
        this.previewBody = this.querySelector('[data-element="tilebank"] tbody')
        assert(this.statusElement instanceof HTMLOutputElement, "view-tile-extractor missing status output")
        assert(this.resultElement instanceof HTMLOutputElement, "view-tile-extractor missing result output")
        assert(this.previewBody instanceof HTMLTableSectionElement, "view-tile-extractor missing tilebank table body")

        this.bindControls()
        super.connectedCallback()
        this.updateSaveButtons()

        if (this.sourcePath) void this.loadSourceImage()
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (oldValue === newValue) return
        if (name === "data-source") {
            this.sourcePath = String(newValue || "").trim()
            if (this.dataset.ready) {
                this.resetOutputPaths()
                if (this.sourcePath) void this.loadSourceImage()
            }
            return
        }
    }

    createViewPluginMethods() {
        return {
            reload: async () => {
                await this.loadSourceImage()
                return { ok: true }
            },
            extract: async () => {
                await this.extractTiles()
                return { ok: true }
            },
            open: async () => {
                await this.open()
                return { ok: true }
            },
            save: async () => {
                await this.saveTilemapJson()
                return { ok: true }
            },
            saveAs: async () => {
                await this.saveTilemapJsonAs()
                return { ok: true }
            },
            saveTileset: async () => {
                await this.saveTileset()
                return { ok: true }
            },
            saveTilesetAs: async () => {
                await this.saveTilesetAs()
                return { ok: true }
            },
            zoomIn: () => this.zoomIn(),
            zoomOut: () => this.zoomOut(),
            zoomFit: () => this.zoomFit(),
        }
    }

    createHeaderControlsElement() {
        const controls = document.createElement("div")
        controls.dataset.element = "toolbar"
        controls.innerHTML = `
      <div role="buttongroup" data-element="file-actions">
        <button type="button" data-action="open" aria-label="Open source image" title="Open source image"><i aria-hidden="true">folder_open</i></button>
        <button type="button" data-action="save-tileset" aria-label="Save tileset QOI" title="Save tileset QOI" disabled><i aria-hidden="true">image</i></button>
        <button type="button" data-action="save-tileset-as" aria-label="Save tileset QOI as" title="Save tileset QOI as" disabled><i aria-hidden="true">image_arrow_up</i></button>
        <button type="button" data-action="save" aria-label="Save tilemap JSON" title="Save tilemap JSON" disabled><i aria-hidden="true">save</i></button>
        <button type="button" data-action="save-as" aria-label="Save tilemap JSON as" title="Save tilemap JSON as" disabled><i aria-hidden="true">save_as</i></button>
        <button type="button" data-action="reload" aria-label="Reload" title="Reload"><i aria-hidden="true">refresh</i></button>
      </div>
      <div role="buttongroup" data-element="tool-actions">
        <button type="button" data-action="extract" aria-label="Extract tiles" title="Extract tiles"><i aria-hidden="true">play_arrow</i></button>
      </div>
      <div role="buttongroup" data-element="view-actions">
        <button type="button" data-action="zoom-in" aria-label="Zoom in" title="Zoom in"><i aria-hidden="true">zoom_in</i></button>
        <button type="button" data-action="zoom-fit" aria-label="Fit" title="Fit"><i aria-hidden="true">fit_screen</i></button>
        <button type="button" data-action="zoom-out" aria-label="Zoom out" title="Zoom out"><i aria-hidden="true">zoom_out</i></button>
      </div>
    `
        controls.querySelector('[data-action="open"]').addEventListener("click", () => this.open())
        controls.querySelector('[data-action="save-tileset"]').addEventListener("click", () => this.saveTileset())
        controls.querySelector('[data-action="save-tileset-as"]').addEventListener("click", () => this.saveTilesetAs())
        controls.querySelector('[data-action="reload"]').addEventListener("click", () => this.loadSourceImage())
        controls.querySelector('[data-action="save"]').addEventListener("click", () => this.saveTilemapJson())
        controls.querySelector('[data-action="save-as"]').addEventListener("click", () => this.saveTilemapJsonAs())
        controls.querySelector('[data-action="extract"]').addEventListener("click", () => this.extractTiles())
        controls.querySelector('[data-action="zoom-in"]').addEventListener("click", () => this.zoomIn())
        controls.querySelector('[data-action="zoom-fit"]').addEventListener("click", () => this.zoomFit())
        controls.querySelector('[data-action="zoom-out"]').addEventListener("click", () => this.zoomOut())
        return controls
    }

    bindControls() {
        this.bindNumberField("tile-w", (value) => {
            this.tileW = value
            this.draw()
        })
        this.bindNumberField("tile-h", (value) => {
            this.tileH = value
            this.draw()
        })
        this.bindNumberField("tolerance", (value) => {
            this.tolerance = value
        })
        this.bindNumberField("skip-nth-pixel", (value) => {
            this.skipNthPixel = value
        })

        this.requiredInput('[data-field="show-grid"]').addEventListener("change", (event) => {
            this.showGrid = event.target.checked
            this.draw()
        })
        this.requiredInput('[data-field="highlight-duplicates"]').addEventListener("change", (event) => {
            this.highlightDuplicates = event.target.checked
            this.draw()
        })

        this.requiredButton("detect-size").addEventListener("click", () => this.autoDetectSize())
    }

    bindNumberField(field, apply) {
        const input = this.requiredInput(`[data-field="${field}"]`)
        input.addEventListener("change", () => {
            const value = Number(input.value)
            assert(Number.isInteger(value) && value >= Number(input.min || 0), `invalid ${field}`)
            apply(value)
        })
    }

    requiredInput(selector) {
        const input = this.querySelector(selector)
        assert(input instanceof HTMLInputElement, `view-tile-extractor missing input ${selector}`)
        return input
    }

    requiredButton(action) {
        const button = this.querySelector(`button[data-action="${action}"]`)
        assert(button instanceof HTMLButtonElement, `view-tile-extractor missing button ${action}`)
        return button
    }

    setStatus(message, tone = null) {
        assert(this.statusElement instanceof HTMLOutputElement, "view-tile-extractor status not initialized")
        this.statusElement.textContent = message
        this.statusElement.classList.remove("accent", "success", "warning", "danger", "info")
        if (tone) this.statusElement.classList.add(tone)
    }

    setResult(message) {
        assert(this.resultElement instanceof HTMLOutputElement, "view-tile-extractor result not initialized")
        this.resultElement.textContent = message
    }

    async open() {
        const selection = await this.chooseSourceImage()
        if (selection.cancelled) return
        this.sourcePath = selection.path
        this.resetOutputPaths()
        await this.loadSourceImage()
    }

    async chooseSourceImage() {
        const payload = unwrap(
            await runtime.call("ui.popup.open", {
                title: "Open Source Image",
                size: "medium",
                tag: "view-files",
                props: {
                    mode: "chooser",
                    filter: "*.png,*.qoi,*.jpg,*.jpeg,*.webp,*.gif,*.bmp",
                },
            }),
            "view-tile-extractor open source image",
        )
        if (!payload || payload.cancelled) return { cancelled: true }
        const selection = Array.isArray(payload.selection) ? payload.selection[0] : payload.selection
        assert(selection?.path, "view-tile-extractor open requires selected image path")
        return { cancelled: false, path: selection.path }
    }

    async loadSourceImage() {
        assert(this.sourcePath, "view-tile-extractor requires source path")
        this.extractOutput = null
        this.renderTilebankPreview()
        this.updateSaveButtons()
        this.setStatus(`Loading ${this.sourcePath}...`, "info")
        try {
            const bytes = new Uint8Array(unwrap(await runtime.invoke("fs/fs::read-file", this.sourcePath), this.sourcePath))
            const source =
                getExtension(this.sourcePath) === "qoi" ? createCanvasFromQoi(bytes) : await createImageBitmap(new Blob([bytes], { type: mimeTypeForPath(this.sourcePath) }))
            this.sourceImage = source
            this.sourceBytes = bytes
            this.sourceWidth = source.width
            this.sourceHeight = source.height
            this.hoveredTile = { x: -1, y: -1 }
            this.setData({ width: source.width, height: source.height }, { autoFit: true })
            this.setStatus(`Loaded ${source.width} × ${source.height}`, "success")
            this.setResult("No extraction performed")
        } catch (error) {
            this.sourceImage = null
            this.sourceBytes = null
            this.sourceWidth = 0
            this.sourceHeight = 0
            this.setData(null, { autoFit: false })
            this.setStatus(`Load failed: ${error?.message || error}`, "danger")
            throw error
        }
    }

    async autoDetectSize() {
        assert(this.sourcePath, "view-tile-extractor requires source path")
        const { id: progressId } = unwrap(
            await runtime.call("ui.toast.progressStart", { message: "Detecting tile size..." }),
            "tile size detection progress start",
        )
        this.setStatus("Detecting tile size...", "info")
        try {
            if (!this.sourceBytes) {
                await runtime.call("ui.toast.progressUpdate", {
                    id: progressId,
                    message: "Loading source image...",
                })
                await this.loadSourceImage()
                await runtime.call("ui.toast.progressUpdate", {
                    id: progressId,
                    message: "Detecting tile size...",
                })
            }
            assert(this.sourceBytes, "view-tile-extractor requires loaded source bytes")
            const output = unwrap(
                await runtime.invoke("tile-detect/tile-detect::detect-size", Array.from(this.sourceBytes), 4, 128),
                "tile size detection",
            )
            this.tileW = Number(output["tile-w"])
            this.tileH = Number(output["tile-h"])
            this.requiredInput('[data-field="tile-w"]').value = String(this.tileW)
            this.requiredInput('[data-field="tile-h"]').value = String(this.tileH)
            this.setStatus(`Detected ${this.tileW} × ${this.tileH}`, "success")
            this.setResult(`Confidence ${(Number(output.confidence) * 100).toFixed(0)}%`)
            this.draw()
            await runtime.call("ui.toast.progressSuccess", {
                id: progressId,
                message: `Detected tile size ${this.tileW} × ${this.tileH}`,
            })
        } catch (error) {
            const message = `Tile size detection failed: ${error?.message || error}`
            this.setStatus(`Detect failed: ${error?.message || error}`, "danger")
            await runtime.call("ui.toast.progressError", { id: progressId, message })
            throw error
        }
    }

    async extractTiles() {
        assert(this.sourcePath, "view-tile-extractor requires source path")
        const { id: progressId } = unwrap(
            await runtime.call("ui.toast.progressStart", { message: "Extracting tiles..." }),
            "tile extraction progress start",
        )
        this.setStatus("Extracting tiles...", "info")
        try {
            if (!this.sourceImage) {
                await runtime.call("ui.toast.progressUpdate", {
                    id: progressId,
                    message: "Loading source image...",
                })
                await this.loadSourceImage()
                await runtime.call("ui.toast.progressUpdate", {
                    id: progressId,
                    message: "Extracting tiles...",
                })
            }
            assert(this.sourceBytes, "view-tile-extractor requires loaded source bytes")
            const output = unwrap(
                await runtime.invoke("tile-detect/tile-detect::extract", {
                    "source-data": Array.from(this.sourceBytes),
                    "tile-w": this.tileW,
                    "tile-h": this.tileH,
                    tolerance: this.tolerance,
                    "skip-nth-pixel": this.skipNthPixel,
                }),
                "tile extraction",
            )
            this.extractOutput = output
            this.renderTilebankPreview()
            this.updateSaveButtons()
            this.draw()
            this.setStatus("Extraction complete", "success")
            const result = `${output.tilemap.width} × ${output.tilemap.height} map, ${output.tilebank.length} unique tiles`
            this.setResult(result)
            await runtime.call("ui.toast.progressSuccess", {
                id: progressId,
                message: `Extraction complete: ${result}`,
            })
        } catch (error) {
            const message = `Tile extraction failed: ${error?.message || error}`
            this.setStatus(`Extraction failed: ${error?.message || error}`, "danger")
            await runtime.call("ui.toast.progressError", { id: progressId, message })
            throw error
        }
    }

    async saveTileset() {
        assert(this.tilesetPath, "view-tile-extractor save requires tileset path")
        await this.saveTilesetToPath(this.tilesetPath)
    }

    async saveTilesetAs() {
        assert(this.extractOutput, "view-tile-extractor requires extraction before saving tileset")
        const path = await this.chooseOutputPath({
            title: "Save Tileset QOI As",
            filter: "*.tileset.qoi,*.qoi",
            defaultName: `${stem(this.sourcePath)}.tileset.qoi`,
        })
        if (!path) return
        await this.saveTilesetToPath(path)
        this.tilesetPath = path
        this.updateSaveButtons()
    }

    async saveTilesetToPath(path) {
        assert(this.extractOutput, "view-tile-extractor requires extraction before saving tileset")
        this.setStatus(`Saving ${path}...`, "info")
        try {
            assert(this.sourceBytes, "view-tile-extractor requires loaded source bytes")
            const output = unwrap(
                await runtime.invoke("tile-detect/tile-detect::export-tileset", {
                    tilebank: this.extractOutput.tilebank,
                    "source-data": Array.from(this.sourceBytes),
                    "source-cols": this.extractOutput.tilemap.width,
                    "tile-w": this.tileW,
                    "tile-h": this.tileH,
                }),
                "tileset export",
            )
            unwrap(await runtime.invoke("fs/fs::write-file", path, output.data), path)
            this.setStatus(`Saved ${path}`, "success")
            this.setResult(`Tileset ${output.width} × ${output.height}, ${output.cols} × ${output.rows} tiles`)
        } catch (error) {
            this.setStatus(`Save failed: ${error?.message || error}`, "danger")
            throw error
        }
    }

    async saveTilemapJson() {
        assert(this.tilemapPath, "view-tile-extractor save requires tilemap path")
        await this.saveTilemapJsonToPath(this.tilemapPath)
    }

    async saveTilemapJsonAs() {
        assert(this.extractOutput, "view-tile-extractor requires extraction before saving tilemap")
        const path = await this.chooseOutputPath({
            title: "Save Tilemap JSON As",
            filter: "*.tilemap.json,*.json",
            defaultName: `${stem(this.sourcePath)}.tilemap.json`,
        })
        if (!path) return
        await this.saveTilemapJsonToPath(path)
        this.tilemapPath = path
        this.updateSaveButtons()
    }

    async saveTilemapJsonToPath(path) {
        assert(this.extractOutput, "view-tile-extractor requires extraction before saving tilemap")
        this.setStatus(`Saving ${path}...`, "info")
        try {
            const tilemap = unwrap(await runtime.invoke("tile-detect/tile-detect::to-tilemap", this.extractOutput), "tilemap conversion")
            unwrap(await runtime.invoke("fs/fs::write-text", path, `${JSON.stringify(tilemap, null, 2)}\n`), path)
            this.setStatus(`Saved ${path}`, "success")
            this.setResult(`Tilemap saved to ${path}`)
        } catch (error) {
            this.setStatus(`Save failed: ${error?.message || error}`, "danger")
            throw error
        }
    }

    async chooseOutputPath({ title, filter, defaultName }) {
        const payload = unwrap(
            await runtime.call("ui.popup.open", {
                title,
                size: "medium",
                tag: "view-files",
                props: { mode: "saver", filter, defaultName },
            }),
            title,
        )
        if (!payload || payload.cancelled) return ""
        const path = typeof payload.path === "string" ? payload.path.trim() : ""
        assert(path, `view-tile-extractor ${title} requires output path`)
        return path
    }

    resetOutputPaths() {
        this.tilesetPath = ""
        this.tilemapPath = ""
        this.updateSaveButtons()
    }

    updateSaveButtons() {
        const hasExtraction = this.extractOutput !== null
        const headerSave = this.queryHeaderControl('[data-action="save"]')
        if (headerSave instanceof HTMLButtonElement) headerSave.disabled = !hasExtraction || !this.tilemapPath
        const headerSaveAs = this.queryHeaderControl('[data-action="save-as"]')
        if (headerSaveAs instanceof HTMLButtonElement) headerSaveAs.disabled = !hasExtraction
        const headerSaveTileset = this.queryHeaderControl('[data-action="save-tileset"]')
        if (headerSaveTileset instanceof HTMLButtonElement) headerSaveTileset.disabled = !hasExtraction || !this.tilesetPath
        const headerSaveTilesetAs = this.queryHeaderControl('[data-action="save-tileset-as"]')
        if (headerSaveTilesetAs instanceof HTMLButtonElement) headerSaveTilesetAs.disabled = !hasExtraction
    }

    renderTilebankPreview() {
        assert(this.previewBody instanceof HTMLTableSectionElement, "view-tile-extractor preview not initialized")
        this.previewBody.textContent = ""
        if (!this.extractOutput) return

        const counts = new Map()
        for (const tileId of this.extractOutput.tilemap.data) {
            const id = Number(tileId)
            if (id <= 0) continue
            counts.set(id, (counts.get(id) || 0) + 1)
        }

        const tilesById = new Map(this.extractOutput.tilebank.map((tile) => [Number(tile.id), tile]))
        const topDuplicates = [...counts.entries()]
            .map(([id, uses]) => ({ id, uses, tile: tilesById.get(id) }))
            .filter((entry) => entry.tile)
            .sort((a, b) => b.uses - a.uses || a.id - b.id)
            .slice(0, 10)

        for (const entry of topDuplicates) {
            const row = document.createElement("tr")
            row.innerHTML = `<td>${entry.id}</td><td>${entry.uses}</td><td>${Number(entry.tile["source-index"])}</td><td>${String(entry.tile.hash)}</td>`
            this.previewBody.appendChild(row)
        }
    }

    calculateContentBounds(data) {
        if (!data) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
        return { minX: 0, minY: 0, maxX: data.width, maxY: data.height }
    }

    drawContent(ctx) {
        if (!this.sourceImage) return
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(this.sourceImage, 0, 0)
        if (this.highlightDuplicates && this.extractOutput) this.drawDuplicateHighlights(ctx)
        if (this.showGrid) this.drawGrid(ctx)
        if (this.hoveredTile.x >= 0 && this.hoveredTile.y >= 0) {
            ctx.strokeStyle = "rgba(255,204,102,0.95)"
            ctx.lineWidth = 2 / this.scale
            ctx.strokeRect(this.hoveredTile.x * this.tileW, this.hoveredTile.y * this.tileH, this.tileW, this.tileH)
        }
    }

    drawGrid(ctx) {
        const cols = Math.floor(this.sourceWidth / this.tileW)
        const rows = Math.floor(this.sourceHeight / this.tileH)
        ctx.strokeStyle = "rgba(255,255,255,0.30)"
        ctx.lineWidth = 1 / this.scale
        for (let x = 0; x <= cols; x += 1) {
            ctx.beginPath()
            ctx.moveTo(x * this.tileW, 0)
            ctx.lineTo(x * this.tileW, rows * this.tileH)
            ctx.stroke()
        }
        for (let y = 0; y <= rows; y += 1) {
            ctx.beginPath()
            ctx.moveTo(0, y * this.tileH)
            ctx.lineTo(cols * this.tileW, y * this.tileH)
            ctx.stroke()
        }
    }

    drawDuplicateHighlights(ctx) {
        const tilemap = this.extractOutput.tilemap
        for (let y = 0; y < tilemap.height; y += 1) {
            for (let x = 0; x < tilemap.width; x += 1) {
                const tileId = Number(tilemap.data[y * tilemap.width + x])
                if (tileId <= 0) continue
                ctx.fillStyle = TILE_COLORS[tileId % TILE_COLORS.length]
                ctx.fillRect(x * this.tileW, y * this.tileH, this.tileW, this.tileH)
            }
        }
    }

    onCanvasMouseMove(event) {
        if (!this.sourceImage) return
        const world = this.getWorldPoint(event.clientX, event.clientY)
        const tileX = Math.floor(world.x / this.tileW)
        const tileY = Math.floor(world.y / this.tileH)
        const cols = Math.floor(this.sourceWidth / this.tileW)
        const rows = Math.floor(this.sourceHeight / this.tileH)
        if (tileX < 0 || tileY < 0 || tileX >= cols || tileY >= rows) {
            this.hoveredTile = { x: -1, y: -1 }
            this.closeTileTip()
            this.draw()
            return
        }
        if (this.hoveredTile.x === tileX && this.hoveredTile.y === tileY) return
        this.hoveredTile = { x: tileX, y: tileY }
        this.openTileTip(tileX, tileY, event)
        this.draw()
    }

    onCanvasMouseLeave() {
        this.hoveredTile = { x: -1, y: -1 }
        this.closeTileTip()
        this.draw()
    }

    openTileTip(tileX, tileY, event) {
        const key = `${tileX},${tileY}`
        if (this.hoverTooltipTileKey === key) return
        this.closeTileTip()
        this.hoverTooltipTileKey = key
        const content = this.tileTipContent(tileX, tileY)
        const rect = this.canvas.getBoundingClientRect()
        const scaleX = rect.width / Math.max(1, this.canvas.width)
        const scaleY = rect.height / Math.max(1, this.canvas.height)
        const track = {
            kind: "aabb",
            x: rect.left + (tileX * this.tileW * this.scale + this.offsetX) * scaleX,
            y: rect.top + (tileY * this.tileH * this.scale + this.offsetY) * scaleY,
            width: this.tileW * this.scale * scaleX,
            height: this.tileH * this.scale * scaleY,
        }
        void runtime
            .call("ui.tooltip.tip", {
                anchor: { kind: "point", x: event.clientX, y: event.clientY },
                track,
                trackPadding: 2,
                followPointer: true,
                pointerOffsetX: 14,
                pointerOffsetY: 18,
                content,
                minWidth: 180,
            })
            .then((result) => {
                const payload = unwrap(result, "ui.tooltip.tip")
                if (this.hoverTooltipTileKey === key) {
                    this.hoverTooltipId = Number(payload.id)
                    return
                }
                void runtime.call("ui.tooltip.close", { id: payload.id, reason: "stale-hover" })
            })
    }

    tileTipContent(tileX, tileY) {
        const lines = [`tile: ${tileX}, ${tileY}`]
        if (this.extractOutput) {
            const tilemap = this.extractOutput.tilemap
            if (tileX >= 0 && tileY >= 0 && tileX < tilemap.width && tileY < tilemap.height) {
                const tileId = tilemap.data[tileY * tilemap.width + tileX]
                lines.push(`id: ${tileId}`)
            }
        }
        return lines.join("\n")
    }

    closeTileTip() {
        if (!this.hoverTooltipTileKey && this.hoverTooltipId <= 0) return
        const tooltipId = this.hoverTooltipId
        this.hoverTooltipTileKey = ""
        this.hoverTooltipId = 0
        if (tooltipId > 0) void runtime.call("ui.tooltip.close", { id: tooltipId, reason: "view-tile-extractor-hover" })
    }
}

if (!customElements.get("view-tile-extractor")) {
    customElements.define("view-tile-extractor", ViewTileExtractor)
}
