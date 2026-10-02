import { runtime, unwrap } from "/core/runtime.js"
import { registerViewPlugin, unregisterViewPlugin } from "/util/view-plugin.js"

const DEFAULT_TILE_SIZE = 16
const DEFAULT_MAP_WIDTH = 32
const DEFAULT_MAP_HEIGHT = 32

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

function basename(path) {
    const normalized = String(path || "").trim()
    const parts = normalized.split("/").filter(Boolean)
    return parts.length > 0 ? parts[parts.length - 1] : normalized
}

function parsePositiveInt(value, label) {
    const parsed = Number.parseInt(String(value), 10)
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
    return parsed
}

export class TilemapSettings extends HTMLElement {
    static get observedAttributes() {
        return ["data-source", "data-mode", "data-title"]
    }

    constructor() {
        super()
        this.nameInput = null
        this.choosePathButton = null
        this.tileSizeInput = null
        this.widthInput = null
        this.heightInput = null
        this.statusElement = null
        this.formElement = null
        this.legendElement = null
        this.saveButton = null
        this.tilemap = null
    }

    connectedCallback() {
        registerViewPlugin(this)
        if (this.dataset.ready) return
        this.dataset.ready = "1"
        this.style.display = "contents"

        this.innerHTML = `
      <form data-element="form" novalidate>
        <fieldset>
          <legend data-element="legend">Tilemap Settings</legend>
          <label>Path<input type="text" data-field="name" readonly autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Choose a tilemap file…"></label>
          <button type="button" data-action="choose-path">Choose path…</button>
          <label>Tile size<input type="number" min="1" step="1" data-field="tile-size" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></label>
          <label>Map width <input id="tilemap-settings-map-width" type="number" min="1" step="1" data-field="map-width" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></label>
          <label>Map height <input type="number" min="1" step="1" data-field="map-height" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></label>
        </fieldset>

        <footer>
          <output data-element="status"></output>
          <button type="button" data-action="cancel">Cancel</button>
          <button type="submit" data-action="save" class="accent">Save</button>
        </footer>
      </form>
    `

        this.formElement = this.querySelector('[data-element="form"]')
        this.legendElement = this.querySelector('[data-element="legend"]')
        this.nameInput = this.querySelector('[data-field="name"]')
        this.choosePathButton = this.querySelector('[data-action="choose-path"]')
        this.tileSizeInput = this.querySelector('[data-field="tile-size"]')
        this.widthInput = this.querySelector('[data-field="map-width"]')
        this.heightInput = this.querySelector('[data-field="map-height"]')
        this.statusElement = this.querySelector('[data-element="status"]')
        this.saveButton = this.querySelector('[data-action="save"]')

        assert(this.formElement instanceof HTMLFormElement, "tilemap-settings missing form")
        assert(this.legendElement instanceof HTMLLegendElement, "tilemap-settings missing legend")
        assert(this.nameInput instanceof HTMLInputElement, "tilemap-settings missing name input")
        assert(this.choosePathButton instanceof HTMLButtonElement, "tilemap-settings missing choose path button")
        assert(this.tileSizeInput instanceof HTMLInputElement, "tilemap-settings missing tile size input")
        assert(this.widthInput instanceof HTMLInputElement, "tilemap-settings missing map width input")
        assert(this.heightInput instanceof HTMLInputElement, "tilemap-settings missing map height input")
        assert(this.statusElement instanceof HTMLOutputElement, "tilemap-settings missing status output")
        assert(this.saveButton instanceof HTMLButtonElement, "tilemap-settings missing save button")

        this.applyModeText()

        this.querySelector('[data-action="cancel"]').addEventListener("click", async () => {
            unwrap(
                await runtime.call("ui.popup.close", {
                    reload: false,
                    cancelled: true,
                }),
            )
        })

        this.choosePathButton.addEventListener("click", async () => {
            await this.choosePath()
        })

        this.formElement.addEventListener("submit", async (event) => {
            event.preventDefault()
            await this.save()
        })

        void this.load()
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (oldValue === newValue) return
        if (!this.dataset.ready) return
        if (name === "data-source" || name === "data-mode") void this.load()
        if (name === "data-title" || name === "data-mode") this.applyModeText()
    }

    get mode() {
        const mode = String(this.getAttribute("data-mode") || "edit").trim()
        assert(mode === "create" || mode === "edit", `tilemap-settings unsupported data-mode ${mode}`)
        return mode
    }

    applyModeText() {
        const title = String(
            this.getAttribute("data-title") || (this.mode === "create" ? "Create Tilemap" : "Tilemap Settings"),
        ).trim()
        this.legendElement.textContent = title
        this.saveButton.textContent = this.mode === "create" ? "Create" : "Save"
    }

    dataSourcePath() {
        const value = String(this.getAttribute("data-source") || "").trim()
        assert(value.length > 0, "tilemap-settings requires data-source path")
        return value
    }

    async load() {
        try {
            if (this.mode === "create") {
                this.tilemap = this.createDefaultTilemap()
                this.renderTilemap(this.tilemap)
                this.setStatus("Choose tilemap path and settings", "info")
                queueMicrotask(() => this.choosePathButton.focus())
                return
            }

            const path = this.dataSourcePath()
            this.setStatus(`Loading ${path}…`, "info")
            this.tilemap = await this.loadTilemap(path)
            this.renderTilemap(this.tilemap)
            this.setStatus(`Loaded ${path}`, "success")
            queueMicrotask(() => this.choosePathButton.focus())
        } catch (error) {
            this.setStatus(`Error: ${error.message}`, "danger")
        }
    }

    createDefaultTilemap() {
        return {
            path: "",
            data: {
                props: { tileSize: String(DEFAULT_TILE_SIZE) },
                layers: [
                    {
                        width: DEFAULT_MAP_WIDTH,
                        data: new Array(DEFAULT_MAP_WIDTH * DEFAULT_MAP_HEIGHT).fill(0),
                        props: { name: "Layer 0" },
                    },
                ],
            },
        }
    }

    async loadTilemap(path) {
        const data = JSON.parse(unwrap(await runtime.invoke("fs/fs::read-text", path)))
        this.validateStorageData(data)
        return { path, data }
    }

    validateStorageData(data) {
        console.warn("update tilemap data validation to json-schema")
        assert(data && typeof data === "object" && !Array.isArray(data), "tilemap storage data must be object JSON")
        assert(Array.isArray(data.layers), "tilemap storage data.layers must be array")
        assert(data.layers.length > 0, "tilemap storage must contain at least one layer")
        for (const [index, layer] of data.layers.entries()) {
            assert(layer && typeof layer === "object" && !Array.isArray(layer), `tilemap layer ${index} must be object`)
            assert(
                Number.isInteger(layer.width) && layer.width > 0,
                `tilemap layer ${index}.width must be positive integer`,
            )
            assert(Array.isArray(layer.data), `tilemap layer ${index}.data must be array`)
        }
    }

    renderTilemap(tilemap) {
        const props =
            tilemap.data.props && typeof tilemap.data.props === "object" && !Array.isArray(tilemap.data.props)
                ? tilemap.data.props
                : {}
        this.nameInput.value = tilemap.path
        this.tileSizeInput.value = String(parsePositiveInt(props.tileSize ?? DEFAULT_TILE_SIZE, "Tile size"))
        this.widthInput.value = String(Math.max(...tilemap.data.layers.map((layer) => layer.width)))
        this.heightInput.value = String(
            Math.max(...tilemap.data.layers.map((layer) => Math.ceil(layer.data.length / layer.width))),
        )
    }

    async choosePath() {
        const currentPath = this.nameInput.value.trim()
        const payload = unwrap(
            await runtime.call("ui.popup.open", {
                title: this.mode === "create" ? "Create Tilemap" : "Save Tilemap As",
                size: "medium",
                tag: "view-files",
                props: {
                    mode: "saver",
                    filter: "*.tilemap.json,*.json",
                    defaultName: basename(currentPath || this.dataSourcePathOrDefault()),
                },
            }),
        )
        if (!payload || payload.cancelled) return
        assert(payload.path, "tilemap-settings choose path requires selected file path")
        this.nameInput.value = payload.path
        this.nameInput.classList.remove("danger")
        this.setStatus(`Selected ${payload.path}`, "success")
    }

    dataSourcePathOrDefault() {
        const value = String(this.getAttribute("data-source") || "").trim()
        return value || "new.tilemap.json"
    }

    async save() {
        assert(this.tilemap, "tilemap-settings save requires loaded tilemap")
        const path = this.nameInput.value.trim()
        if (!path) {
            this.nameInput.classList.add("danger")
            this.choosePathButton.focus()
            this.setStatus("Error: Choose a tilemap path", "danger")
            return
        }
        this.nameInput.classList.remove("danger")

        const tileSize = parsePositiveInt(this.tileSizeInput.value, "Tile size")
        const width = parsePositiveInt(this.widthInput.value, "Map width")
        const height = parsePositiveInt(this.heightInput.value, "Map height")

        const data = this.updatedStorageData(this.tilemap.data, {
            tileSize,
            width,
            height,
        })
        this.setStatus("Saving…", "info")
        try {
            unwrap(await runtime.invoke("fs/fs::write-text", path, `${JSON.stringify(data, null, 2)}\n`))
            unwrap(
                await runtime.call("ui.popup.close", {
                    reload: true,
                    cancelled: false,
                    path,
                    name: basename(path),
                }),
            )
        } catch (error) {
            this.setStatus(`Error: ${error.message}`, "danger")
        }
    }

    updatedStorageData(data, settings) {
        const props =
            data.props && typeof data.props === "object" && !Array.isArray(data.props) ? { ...data.props } : {}
        props.tileSize = String(settings.tileSize)
        this.removeTilesetTileSizes(props)

        return {
            props,
            layers: data.layers.map((layer) => ({
                width: settings.width,
                data: this.resizeLayerData(layer, settings.width, settings.height),
                props:
                    layer.props && typeof layer.props === "object" && !Array.isArray(layer.props)
                        ? { ...layer.props }
                        : {},
            })),
        }
    }

    removeTilesetTileSizes(props) {
        if (typeof props.tilesets !== "string" || props.tilesets.length === 0) return
        const tilesets = JSON.parse(props.tilesets)
        assert(Array.isArray(tilesets), "tilemap settings props.tilesets must be JSON array")
        props.tilesets = JSON.stringify(
            tilesets.map((entry) => {
                assert(
                    entry && typeof entry === "object" && !Array.isArray(entry),
                    "tilemap settings tileset entry must be object",
                )
                const next = { ...entry }
                delete next.tileWidth
                delete next.tileHeight
                delete next.tw
                delete next.th
                return next
            }),
        )
    }

    resizeLayerData(layer, width, height) {
        const next = new Array(width * height).fill(0)
        const previousWidth = layer.width
        const previousHeight = Math.ceil(layer.data.length / previousWidth)
        const copyWidth = Math.min(previousWidth, width)
        const copyHeight = Math.min(previousHeight, height)
        for (let y = 0; y < copyHeight; y++) {
            for (let x = 0; x < copyWidth; x++) {
                next[y * width + x] = Number(layer.data[y * previousWidth + x] || 0)
            }
        }
        return next
    }

    setStatus(text, tone = null) {
        this.statusElement.textContent = text
        this.statusElement.classList.remove("accent", "success", "warning", "danger", "info")
        if (tone) this.statusElement.classList.add(tone)
    }

    disconnectedCallback() {
        void unregisterViewPlugin(this)
    }
}

if (!customElements.get("tilemap-settings")) {
    customElements.define("tilemap-settings", TilemapSettings)
}
