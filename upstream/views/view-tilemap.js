import { runtime, unwrap } from "/core/runtime.js"
import { UndoHistory } from "/util/undo.js"
import { ViewCanvasBase } from "/util/view-canvas-base.js"
import { viewOk } from "/util/view-plugin.js"
import {
  DEFAULT_TILE_SIZE,
  TilemapRasterizer,
  TilemapTileset,
  collectTilesetSpecs,
  createTilemapTilesets,
  maxTileId,
  parseTilemapData,
  tileSizeForTilemap,
} from "/util/tilemap-render.js"

const TOOL = {
  SELECT: 0,
  BRUSH: 1,
  ERASE: 2,
  EYEDROPPER: 3,
  PASTE: 4,
  FILL: 5,
}

const TOOL_LABELS = new Map([
  [TOOL.SELECT, "Select"],
  [TOOL.BRUSH, "Brush"],
  [TOOL.ERASE, "Erase"],
  [TOOL.EYEDROPPER, "Eyedropper"],
  [TOOL.PASTE, "Paste"],
  [TOOL.FILL, "Fill"],
])

const SELECT_COLORS = {
  DRAG_BORDER: "rgba(122,162,255,0.95)",
  DRAG_FILL: "rgba(122,162,255,0.18)",
  ADD_BORDER: "rgba(61,220,151,0.95)",
  ADD_FILL: "rgba(61,220,151,0.22)",
  REMOVE_BORDER: "rgba(255,92,122,0.95)",
  REMOVE_FILL: "rgba(255,92,122,0.22)",
  ACTIVE_BORDER: "rgba(255,204,102,0.95)",
  ACTIVE_FILL: "rgba(255,204,102,0.18)",
}

const SELECT_MODE = {
  REPLACE: "replace",
  ADD: "add",
  REMOVE: "remove",
}

const DEFAULT_SELECT_ADD_KEY = "Shift"
const DEFAULT_SELECT_REMOVE_KEY = "Control"
const PASTE_PREVIEW_ALPHA = 0.55
const TILESET_MIN_SCALE = 0.5
const TILESET_MAX_SCALE = 3
const TILESET_ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3]

function basename(path) {
  const normalized = String(path || "").trim()
  const parts = normalized.split("/").filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : normalized
}

function tilemapNameFromPath(path) {
  const name = basename(path)
  return name.replace(/\.tilemap\.json$/i, "").replace(/\.json$/i, "")
}

function normalizeStringProps(input, label) {
  if (input == null) return {}
  assert(
    input && typeof input === "object" && !Array.isArray(input),
    `${label} must be an object`,
  )
  const props = {}
  for (const [key, value] of Object.entries(input)) {
    props[String(key)] = String(value ?? "")
  }
  return props
}

function layerDisplayName(layer) {
  assert(
    layer && typeof layer === "object" && !Array.isArray(layer),
    "tilemap layer display name requires layer",
  )
  assert(
    layer.props &&
      typeof layer.props === "object" &&
      !Array.isArray(layer.props),
    "tilemap layer display name requires props",
  )
  const name = layer.props.name
  return typeof name === "string" && name.length > 0
    ? name
    : `Layer ${layer.index}`
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

class TilemapCommand {
  constructor(label, redo, undo) {
    assert(
      typeof label === "string" && label.length > 0,
      "tilemap command label must be non-empty string",
    )
    assert(typeof redo === "function", "tilemap command redo must be function")
    assert(typeof undo === "function", "tilemap command undo must be function")
    this.label = label
    this.redo = redo
    this.undo = undo
  }
}

class TilemapState {
  constructor() {
    this.handle = 1
    this.path = ""
    this.name = ""
    this.width = 1
    this.height = 1
    this.props = {}
    this.layers = []
    this.nextLayerId = 1
    this.activeLayer = 0
    this.tool = TOOL.SELECT
    this.activeTile = 1
    this.dirty = false
    this.history = new UndoHistory()
    this.hasClipboard = false
  }

  open({ path, data }) {
    assert(
      typeof path === "string" && path.length > 0,
      "tilemap state open requires tilemap path",
    )
    assert(
      typeof data === "string" && data.length > 0,
      "tilemap state open requires tilemap data",
    )
    this.loadTilemapData(path, data)
    this.dirty = false
    this.resetHistory()
    return { handle: this.handle }
  }

  save({ path }) {
    assert(
      typeof path === "string" && path.length > 0,
      "tilemap state save requires tilemap path",
    )
    this.path = path
    this.name = tilemapNameFromPath(path)
    this.dirty = false
  }

  toStorageData() {
    return JSON.stringify({
      props: { ...this.props },
      layers: this.layers.map((layer) => ({
        width: layer.width,
        data: layer.data.slice(),
        props: { ...(layer.props || {}) },
      })),
    })
  }

  loadTilemapData(path, data) {
    const tilemap = parseTilemapData(data)
    this.nextLayerId = 1
    const layers = tilemap.layers.map((layer) => ({
      ...layer,
      id: this.allocateLayerId(),
      hidden: false,
      data: layer.data.slice(),
      props: { ...layer.props },
    }))

    this.path = path
    this.name = tilemapNameFromPath(path)
    this.width = tilemap.width
    this.height = tilemap.height
    this.props = { ...tilemap.props }
    this.layers = layers
    this.activeLayer = 0
    this.activeTile = this.findFirstTile(layers)
  }

  findFirstTile(layers) {
    for (const layer of layers) {
      const tile = layer.data.find((value) => value > 0)
      if (Number.isInteger(tile)) return tile
    }
    return 1
  }

  snapshot() {
    return {
      handle: this.handle,
      name: this.name,
      path: this.path,
      dirty: this.dirty,
      width: this.width,
      height: this.height,
      props: { ...this.props },
      layers: this.layers.map((layer, index) => ({
        ...layer,
        index,
        props: { ...layer.props },
        data: layer.data.slice(),
      })),
      activeLayer: this.activeLayer,
      tool: this.tool,
      activeTile: this.activeTile,
      canUndo: this.history.canUndo(),
      canRedo: this.history.canRedo(),
      history: this.createHistorySnapshot(),
    }
  }

  setTool(tool) {
    this.tool = tool
  }

  setActiveTile(tile) {
    this.activeTile = tile
  }

  setActiveLayer(layer) {
    this.activeLayer = layer
  }

  setTilesetSpecs(specs) {
    assert(Array.isArray(specs), "tilemap state tileset specs must be array")
    const previous = this.props.tilesets
    const next = JSON.stringify(specs)
    if (previous === next) return
    this.executeDirtyCommand(
      "Set tilesets",
      () => {
        this.props.tilesets = next
      },
      () => {
        if (previous === undefined) delete this.props.tilesets
        else this.props.tilesets = previous
      },
    )
  }

  setMapProps(props) {
    const previous = { ...this.props }
    const next = normalizeStringProps(props, "tilemap map props")
    if (JSON.stringify(previous) === JSON.stringify(next)) return
    this.executeDirtyCommand(
      "Set map properties",
      () => {
        this.props = { ...next }
      },
      () => {
        this.props = { ...previous }
      },
    )
  }

  setLayerProps(layer, props) {
    const target = this.requireLayer(layer)
    const previousProps = { ...target.props }
    const nextProps = normalizeStringProps(
      props,
      `tilemap layer ${layer}.props`,
    )
    if (JSON.stringify(previousProps) === JSON.stringify(nextProps)) return
    const label = layerDisplayName(target)
    this.executeDirtyCommand(
      `Set ${label} properties`,
      () => {
        this.requireLayer(layer).props = { ...nextProps }
      },
      () => {
        this.requireLayer(layer).props = { ...previousProps }
      },
    )
  }

  setLayerHidden(layer, hidden) {
    const target = this.requireLayer(layer)
    const previous = target.hidden
    if (previous === hidden) return
    const label = layerDisplayName(target)
    this.executeDirtyCommand(
      `Set ${label} ${hidden ? "hidden" : "visible"}`,
      () => {
        this.requireLayer(layer).hidden = hidden
      },
      () => {
        this.requireLayer(layer).hidden = previous
      },
    )
  }

  insertLayer(index) {
    assert(
      index >= 0 && index <= this.layers.length,
      "tilemap state insert layer index out of range",
    )
    const previousActiveLayer = this.activeLayer
    const insertedLayer = {
      id: this.allocateLayerId(),
      index,
      hidden: false,
      width: this.width,
      data: new Array(this.width * this.height).fill(0),
      props: { name: this.createLayerName() },
    }
    this.executeDirtyCommand(
      `Insert layer ${index}`,
      () => {
        this.layers.splice(index, 0, insertedLayer)
        this.renumberLayers()
        this.activeLayer = index
      },
      () => {
        this.layers.splice(index, 1)
        this.renumberLayers()
        this.activeLayer = previousActiveLayer
      },
    )
  }

  deleteLayer(index) {
    assert(this.layers.length > 1, "tilemap state must keep at least one layer")
    const sourceLayer = this.requireLayer(index)
    const deletedLayer = {
      ...sourceLayer,
      data: sourceLayer.data.slice(),
      props: { ...sourceLayer.props },
    }
    const previousActiveLayer = this.activeLayer
    this.executeDirtyCommand(
      `Delete ${layerDisplayName(deletedLayer)}`,
      () => {
        this.layers.splice(index, 1)
        this.renumberLayers()
        if (this.activeLayer === index) this.activeLayer = -1
        else if (this.activeLayer > index) this.activeLayer -= 1
      },
      () => {
        this.layers.splice(index, 0, {
          ...deletedLayer,
          data: deletedLayer.data.slice(),
          props: { ...deletedLayer.props },
        })
        this.renumberLayers()
        this.activeLayer = previousActiveLayer
      },
    )
  }

  moveLayer(from, to) {
    this.requireLayer(from)
    this.requireLayer(to)
    if (from === to) return
    const previousActiveLayer = this.activeLayer
    this.executeDirtyCommand(
      `Move layer ${from} to ${to}`,
      () => {
        this.moveLayerRaw(from, to)
        this.activeLayer = to
      },
      () => {
        this.moveLayerRaw(to, from)
        this.activeLayer = previousActiveLayer
      },
    )
  }

  eraseCellLive(layerIndexes, cell, changes) {
    assert(
      Array.isArray(layerIndexes),
      "tilemap state eraseCellLive layerIndexes must be array",
    )
    assert(
      Number.isInteger(cell.x) && Number.isInteger(cell.y),
      "tilemap state eraseCellLive cell must contain integer x/y",
    )
    assert(
      changes instanceof Map,
      "tilemap state eraseCellLive changes must be Map",
    )
    let changed = false

    for (const layerIndex of layerIndexes) {
      const layer = this.requireLayer(layerIndex)
      if (cell.x < 0 || cell.x >= layer.width || cell.y < 0) continue
      const tileIndex = cell.y * layer.width + cell.x
      if (tileIndex < 0 || tileIndex >= layer.data.length) continue
      const key = `${layerIndex}:${tileIndex}`
      if (changes.has(key)) continue
      const previous = layer.data[tileIndex]
      if (previous === 0) continue
      changes.set(key, { layerIndex, tileIndex, previous, next: 0 })
      layer.data[tileIndex] = 0
      changed = true
    }

    if (changed) this.dirty = true
    return changed
  }

  commitEraseChanges(changes) {
    assert(
      changes instanceof Map,
      "tilemap state commitEraseChanges changes must be Map",
    )
    return this.commitLiveTileChanges(changes, "Erase")
  }

  paintCellLive(layerIndex, cell, tile, changes) {
    assert(
      Number.isInteger(layerIndex),
      "tilemap state paintCellLive layerIndex must be integer",
    )
    assert(
      Number.isInteger(cell.x) && Number.isInteger(cell.y),
      "tilemap state paintCellLive cell must contain integer x/y",
    )
    assert(
      Number.isInteger(tile),
      "tilemap state paintCellLive tile must be integer",
    )
    assert(
      changes instanceof Map,
      "tilemap state paintCellLive changes must be Map",
    )
    const layer = this.requireLayer(layerIndex)
    if (cell.x < 0 || cell.x >= layer.width || cell.y < 0) return false
    const tileIndex = cell.y * layer.width + cell.x
    if (tileIndex < 0 || tileIndex >= layer.data.length) return false
    const previous = layer.data[tileIndex]
    if (previous === tile) return false
    const key = `${layerIndex}:${tileIndex}`
    if (!changes.has(key))
      changes.set(key, { layerIndex, tileIndex, previous, next: tile })
    layer.data[tileIndex] = tile
    this.dirty = true
    return true
  }

  commitPaintChanges(changes) {
    assert(
      changes instanceof Map,
      "tilemap state commitPaintChanges changes must be Map",
    )
    return this.commitLiveTileChanges(changes, "Paint")
  }

  fillCells(layerIndex, cells, tile) {
    assert(
      Number.isInteger(layerIndex),
      "tilemap state fillCells layerIndex must be integer",
    )
    assert(Array.isArray(cells), "tilemap state fillCells cells must be array")
    assert(
      Number.isInteger(tile),
      "tilemap state fillCells tile must be integer",
    )
    const changes = []
    for (const cell of cells) {
      assert(
        Number.isInteger(cell.x) && Number.isInteger(cell.y),
        "tilemap state fillCells cell must contain integer x/y",
      )
      const layer = this.requireLayer(layerIndex)
      if (cell.x < 0 || cell.x >= layer.width || cell.y < 0) continue
      const tileIndex = cell.y * layer.width + cell.x
      if (tileIndex < 0 || tileIndex >= layer.data.length) continue
      const previous = layer.data[tileIndex]
      if (previous === tile) continue
      changes.push({ layerIndex, tileIndex, previous, next: tile })
    }
    if (changes.length === 0) return false
    this.executeDirtyCommand(
      `Fill ${changes.length} tile${changes.length === 1 ? "" : "s"}`,
      () => {
        for (const change of changes)
          this.requireLayer(change.layerIndex).data[change.tileIndex] =
            change.next
      },
      () => {
        for (const change of changes)
          this.requireLayer(change.layerIndex).data[change.tileIndex] =
            change.previous
      },
    )
    return true
  }

  commitLiveTileChanges(changes, label) {
    assert(
      changes instanceof Map,
      "tilemap state commitLiveTileChanges changes must be Map",
    )
    assert(
      typeof label === "string" && label.length > 0,
      "tilemap state commitLiveTileChanges label must be non-empty string",
    )
    const committed = [...changes.values()]
    if (committed.length === 0) return false
    this.history.add(
      new TilemapCommand(
        `${label} ${committed.length} tile${committed.length === 1 ? "" : "s"}`,
        () => {
          for (const change of committed)
            this.requireLayer(change.layerIndex).data[change.tileIndex] =
              change.next
          this.dirty = true
        },
        () => {
          for (const change of committed)
            this.requireLayer(change.layerIndex).data[change.tileIndex] =
              change.previous
          this.dirty = true
        },
      ),
    )
    this.dirty = true
    return true
  }

  copyCells(layerIndexes, cells) {
    assert(
      Array.isArray(layerIndexes),
      "tilemap state copyCells layerIndexes must be array",
    )
    assert(Array.isArray(cells), "tilemap state copyCells cells must be array")
    assert(
      layerIndexes.length > 0,
      "tilemap state copyCells requires at least one layer",
    )
    assert(
      cells.length > 0,
      "tilemap state copyCells requires at least one cell",
    )
    const minX = Math.min(...cells.map((cell) => cell.x))
    const minY = Math.min(...cells.map((cell) => cell.y))
    const maxX = Math.max(...cells.map((cell) => cell.x))
    const maxY = Math.max(...cells.map((cell) => cell.y))
    const entries = []

    for (const layerIndex of layerIndexes) {
      const layer = this.requireLayer(layerIndex)
      const tiles = []
      for (const cell of cells) {
        assert(
          Number.isInteger(cell.x) && Number.isInteger(cell.y),
          "tilemap state copyCells cell must contain integer x/y",
        )
        const tileIndex = cell.y * layer.width + cell.x
        const tile =
          cell.x >= 0 &&
          cell.x < layer.width &&
          tileIndex >= 0 &&
          tileIndex < layer.data.length
            ? layer.data[tileIndex]
            : 0
        if (tile === 0) continue
        tiles.push({ dx: cell.x - minX, dy: cell.y - minY, tile })
      }
      entries.push({ sourceLayer: layerIndex, tiles })
    }

    return { width: maxX - minX + 1, height: maxY - minY + 1, entries }
  }

  cutCells(layerIndexes, cells) {
    const clipboard = this.copyCells(layerIndexes, cells)
    const changed = this.clearCells(layerIndexes, cells, "Cut")
    return { clipboard, changed }
  }

  deleteCells(layerIndexes, cells) {
    return this.clearCells(layerIndexes, cells, "Delete")
  }

  clearCells(layerIndexes, cells, label) {
    assert(
      Array.isArray(layerIndexes),
      "tilemap state clearCells layerIndexes must be array",
    )
    assert(Array.isArray(cells), "tilemap state clearCells cells must be array")
    assert(
      typeof label === "string" && label.length > 0,
      "tilemap state clearCells label must be non-empty string",
    )
    const changes = []
    for (const layerIndex of layerIndexes) {
      const layer = this.requireLayer(layerIndex)
      for (const cell of cells) {
        assert(
          Number.isInteger(cell.x) && Number.isInteger(cell.y),
          "tilemap state clearCells cell must contain integer x/y",
        )
        const tileIndex = cell.y * layer.width + cell.x
        if (
          cell.x < 0 ||
          cell.x >= layer.width ||
          tileIndex < 0 ||
          tileIndex >= layer.data.length
        )
          continue
        const previous = layer.data[tileIndex]
        if (previous === 0) continue
        changes.push({ layerIndex, tileIndex, previous, next: 0 })
      }
    }
    if (changes.length === 0) return false
    this.executeDirtyCommand(
      `${label} ${changes.length} tile${changes.length === 1 ? "" : "s"}`,
      () => {
        for (const change of changes)
          this.requireLayer(change.layerIndex).data[change.tileIndex] =
            change.next
      },
      () => {
        for (const change of changes)
          this.requireLayer(change.layerIndex).data[change.tileIndex] =
            change.previous
      },
    )
    return true
  }

  sampleTile(layerIndex, cell) {
    const layer = this.requireLayer(layerIndex)
    assert(
      Number.isInteger(cell.x) && Number.isInteger(cell.y),
      "tilemap state sampleTile cell must contain integer x/y",
    )
    if (cell.x < 0 || cell.x >= layer.width || cell.y < 0) return 0
    const tileIndex = cell.y * layer.width + cell.x
    if (tileIndex < 0 || tileIndex >= layer.data.length) return 0
    return layer.data[tileIndex]
  }

  pasteClipboard(clipboard, origin, targetLayerIndexes) {
    assert(
      clipboard && typeof clipboard === "object" && !Array.isArray(clipboard),
      "tilemap state pasteClipboard clipboard must be object",
    )
    assert(
      Number.isInteger(origin.x) && Number.isInteger(origin.y),
      "tilemap state pasteClipboard origin must contain integer x/y",
    )
    assert(
      Array.isArray(targetLayerIndexes),
      "tilemap state pasteClipboard targetLayerIndexes must be array",
    )
    assert(
      targetLayerIndexes.length === clipboard.entries.length,
      "tilemap state pasteClipboard target layer count must match clipboard entries",
    )
    const changes = []

    clipboard.entries.forEach((entry, entryIndex) => {
      const layerIndex = targetLayerIndexes[entryIndex]
      const layer = this.requireLayer(layerIndex)
      for (const tile of entry.tiles) {
        const x = origin.x + tile.dx
        const y = origin.y + tile.dy
        const tileIndex = y * layer.width + x
        if (
          x < 0 ||
          x >= layer.width ||
          tileIndex < 0 ||
          tileIndex >= layer.data.length
        )
          continue
        if (tile.tile === 0) continue
        const previous = layer.data[tileIndex]
        if (previous === tile.tile) continue
        changes.push({ layerIndex, tileIndex, previous, next: tile.tile })
      }
    })

    if (changes.length === 0) return false
    this.executeDirtyCommand(
      `Paste ${changes.length} tile${changes.length === 1 ? "" : "s"}`,
      () => {
        for (const change of changes)
          this.requireLayer(change.layerIndex).data[change.tileIndex] =
            change.next
      },
      () => {
        for (const change of changes)
          this.requireLayer(change.layerIndex).data[change.tileIndex] =
            change.previous
      },
    )
    return true
  }

  undo() {
    this.history.undo()
  }

  redo() {
    this.history.redo()
  }

  moveHistoryTo(index) {
    const state = this.history.toArray()[index]
    assert(state, `tilemap state missing history index ${index}`)
    this.history.moveTo(state)
    this.dirty = true
  }

  executeDirtyCommand(label, redo, undo) {
    this.history.execute(
      new TilemapCommand(
        label,
        () => {
          redo()
          this.dirty = true
        },
        () => {
          undo()
          this.dirty = true
        },
      ),
    )
  }

  moveLayerRaw(from, to) {
    const [layer] = this.layers.splice(from, 1)
    assert(layer, `tilemap state missing layer ${from}`)
    this.layers.splice(to, 0, layer)
    this.renumberLayers()
  }

  resetHistory() {
    this.history.dispose()
    this.history = new UndoHistory()
  }

  createHistorySnapshot() {
    const states = this.history.toArray()
    return states.map((state, index) => ({
      index,
      label: state.command.label,
      current: state === this.history.current,
      parentIndex: state.parent ? states.indexOf(state.parent) : -1,
    }))
  }

  renumberLayers() {
    this.layers.forEach((layer, index) => {
      layer.index = index
      assert(
        layer.props &&
          typeof layer.props === "object" &&
          !Array.isArray(layer.props),
        "tilemap layer props required while renumbering",
      )
    })
  }

  requireLayer(index) {
    const layer = this.layers[index]
    assert(layer, `tilemap state missing layer ${index}`)
    return layer
  }

  allocateLayerId() {
    const id = this.nextLayerId
    this.nextLayerId += 1
    return id
  }

  createLayerName() {
    const usedIndexes = new Set()
    let prefix = "Layer "
    for (const layer of this.layers) {
      assert(
        layer.props &&
          typeof layer.props === "object" &&
          !Array.isArray(layer.props),
        "tilemap layer props required while creating layer name",
      )
      const name = layer.props.name
      if (typeof name !== "string") continue
      const match = name.match(/^(Layer |layer_)(\d+)$/)
      if (!match) continue
      prefix = match[1]
      usedIndexes.add(Number(match[2]))
    }

    let index = 0
    while (usedIndexes.has(index)) index += 1
    return `${prefix}${index}`
  }
}

function validateSnapshot(snapshot) {
  assert(
    snapshot && typeof snapshot === "object" && !Array.isArray(snapshot),
    "view-tilemap snapshot must be an object",
  )
  assert(
    Number.isInteger(snapshot.handle) && snapshot.handle > 0,
    "view-tilemap snapshot.handle must be positive integer",
  )
  assert(
    typeof snapshot.name === "string",
    "view-tilemap snapshot.name must be string",
  )
  assert(
    typeof snapshot.path === "string",
    "view-tilemap snapshot.path must be string",
  )
  assert(
    typeof snapshot.dirty === "boolean",
    "view-tilemap snapshot.dirty must be boolean",
  )
  assert(
    Number.isInteger(snapshot.width) && snapshot.width > 0,
    "view-tilemap snapshot.width must be positive integer",
  )
  assert(
    Number.isInteger(snapshot.height) && snapshot.height > 0,
    "view-tilemap snapshot.height must be positive integer",
  )
  assert(
    Array.isArray(snapshot.layers),
    "view-tilemap snapshot.layers must be array",
  )
  assert(
    Number.isInteger(snapshot.activeLayer),
    "view-tilemap snapshot.activeLayer must be integer",
  )
  assert(
    Number.isInteger(snapshot.tool),
    "view-tilemap snapshot.tool must be integer",
  )
  assert(
    Number.isInteger(snapshot.activeTile),
    "view-tilemap snapshot.activeTile must be integer",
  )
  assert(
    typeof snapshot.canUndo === "boolean",
    "view-tilemap snapshot.canUndo must be boolean",
  )
  assert(
    typeof snapshot.canRedo === "boolean",
    "view-tilemap snapshot.canRedo must be boolean",
  )
  assert(
    Array.isArray(snapshot.history),
    "view-tilemap snapshot.history must be array",
  )
  for (const entry of snapshot.history) {
    assert(
      Number.isInteger(entry.index),
      "view-tilemap history.index must be integer",
    )
    assert(
      typeof entry.label === "string" && entry.label.length > 0,
      "view-tilemap history.label must be non-empty string",
    )
    assert(
      typeof entry.current === "boolean",
      "view-tilemap history.current must be boolean",
    )
    assert(
      Number.isInteger(entry.parentIndex),
      "view-tilemap history.parentIndex must be integer",
    )
  }
  for (const layer of snapshot.layers) {
    assert(
      Number.isInteger(layer.id) && layer.id > 0,
      "view-tilemap layer.id must be positive integer",
    )
    assert(
      Number.isInteger(layer.index),
      "view-tilemap layer.index must be integer",
    )
    assert(
      layer.props &&
        typeof layer.props === "object" &&
        !Array.isArray(layer.props),
      "view-tilemap layer.props must be object",
    )
    assert(
      typeof layer.hidden === "boolean",
      "view-tilemap layer.hidden must be boolean",
    )
    assert(
      Number.isInteger(layer.width) && layer.width > 0,
      "view-tilemap layer.width must be positive integer",
    )
    assert(Array.isArray(layer.data), "view-tilemap layer.data must be array")
  }
  return snapshot
}

class TilemapSelectionTool {
  constructor({ getAddKey, getRemoveKey }) {
    assert(
      typeof getAddKey === "function",
      "tilemap selection tool getAddKey must be function",
    )
    assert(
      typeof getRemoveKey === "function",
      "tilemap selection tool getRemoveKey must be function",
    )
    this.getAddKey = getAddKey
    this.getRemoveKey = getRemoveKey
    this.selectedCells = new Set()
    this.drag = null
  }

  clear() {
    this.selectedCells.clear()
    this.drag = null
  }

  clearDrag() {
    this.drag = null
  }

  start(cell, event) {
    const mode = this.modeFromEvent(event)
    if (mode === SELECT_MODE.REPLACE) this.selectedCells.clear()
    this.drag = {
      mode,
      startX: cell.x,
      startY: cell.y,
      endX: cell.x,
      endY: cell.y,
    }
  }

  update(cell) {
    assert(this.drag, "tilemap selection update requires active drag")
    this.drag.endX = cell.x
    this.drag.endY = cell.y
  }

  finish(cell) {
    assert(this.drag, "tilemap selection finish requires active drag")
    this.update(cell)
    const rect = this.rectFromDrag(this.drag)
    const mode = this.drag.mode
    if (rect.width === 1 && rect.height === 1 && mode === SELECT_MODE.REPLACE) {
      this.clear()
      return { status: "Selection cleared" }
    }

    this.applyRect(rect, mode)
    this.drag = null
    return { status: this.statusText(mode) }
  }

  modeFromEvent(event) {
    if (this.eventHasKey(event, this.getAddKey())) return SELECT_MODE.ADD
    if (this.eventHasKey(event, this.getRemoveKey())) return SELECT_MODE.REMOVE
    return SELECT_MODE.REPLACE
  }

  eventHasKey(event, key) {
    const normalized = String(key || "")
      .trim()
      .toLowerCase()
    assert(normalized.length > 0, "tilemap selection key must be non-empty")
    if (normalized === "shift") return event.shiftKey
    if (normalized === "control" || normalized === "ctrl") return event.ctrlKey
    if (normalized === "alt" || normalized === "option") return event.altKey
    if (
      normalized === "meta" ||
      normalized === "cmd" ||
      normalized === "command"
    )
      return event.metaKey
    throw new Error(`tilemap selection unsupported modifier key ${key}`)
  }

  rectFromDrag(selection) {
    const minX = Math.min(selection.startX, selection.endX)
    const minY = Math.min(selection.startY, selection.endY)
    const maxX = Math.max(selection.startX, selection.endX)
    const maxY = Math.max(selection.startY, selection.endY)
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
  }

  applyRect(rect, mode) {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        const key = this.key(x, y)
        if (mode === SELECT_MODE.REMOVE) this.selectedCells.delete(key)
        else this.selectedCells.add(key)
      }
    }
  }

  key(x, y) {
    return `${x},${y}`
  }

  containsCell(cell) {
    return this.selectedCells.has(this.key(cell.x, cell.y))
  }

  cells() {
    return [...this.selectedCells]
      .map((key) => this.cellFromKey(key))
      .sort((a, b) => a.y - b.y || a.x - b.x)
  }

  statusText(mode) {
    if (mode === SELECT_MODE.ADD) return "Selection added"
    if (mode === SELECT_MODE.REMOVE) return "Selection removed"
    return "Selection updated"
  }

  draw(ctx, { tileWidth, tileHeight, scale }) {
    assert(
      ctx instanceof CanvasRenderingContext2D,
      "tilemap selection draw requires 2d context",
    )
    assert(
      Number.isInteger(tileWidth) && tileWidth > 0,
      "tilemap selection tileWidth must be positive integer",
    )
    assert(
      Number.isInteger(tileHeight) && tileHeight > 0,
      "tilemap selection tileHeight must be positive integer",
    )
    assert(
      Number.isFinite(scale) && scale > 0,
      "tilemap selection scale must be positive number",
    )

    if (this.selectedCells.size > 0) {
      this.drawCells(
        ctx,
        this.selectedCells,
        tileWidth,
        tileHeight,
        scale,
        SELECT_COLORS.ACTIVE_BORDER,
        SELECT_COLORS.ACTIVE_FILL,
      )
    }

    if (this.drag) {
      const colors = this.colorsForMode(this.drag.mode)
      this.drawRect(
        ctx,
        this.rectFromDrag(this.drag),
        tileWidth,
        tileHeight,
        scale,
        colors.border,
        colors.fill,
      )
    }
  }

  colorsForMode(mode) {
    if (mode === SELECT_MODE.ADD)
      return { border: SELECT_COLORS.ADD_BORDER, fill: SELECT_COLORS.ADD_FILL }
    if (mode === SELECT_MODE.REMOVE)
      return {
        border: SELECT_COLORS.REMOVE_BORDER,
        fill: SELECT_COLORS.REMOVE_FILL,
      }
    return { border: SELECT_COLORS.DRAG_BORDER, fill: SELECT_COLORS.DRAG_FILL }
  }

  drawCells(ctx, cells, tileWidth, tileHeight, scale, border, fill) {
    ctx.save()
    ctx.fillStyle = fill
    for (const key of cells) {
      const { x, y } = this.cellFromKey(key)
      ctx.fillRect(x * tileWidth, y * tileHeight, tileWidth, tileHeight)
    }

    ctx.strokeStyle = border
    ctx.lineWidth = 2 / scale
    ctx.beginPath()
    for (const key of cells) {
      const { x, y } = this.cellFromKey(key)
      const px = x * tileWidth
      const py = y * tileHeight
      if (!cells.has(this.key(x, y - 1))) {
        ctx.moveTo(px, py)
        ctx.lineTo(px + tileWidth, py)
      }
      if (!cells.has(this.key(x + 1, y))) {
        ctx.moveTo(px + tileWidth, py)
        ctx.lineTo(px + tileWidth, py + tileHeight)
      }
      if (!cells.has(this.key(x, y + 1))) {
        ctx.moveTo(px + tileWidth, py + tileHeight)
        ctx.lineTo(px, py + tileHeight)
      }
      if (!cells.has(this.key(x - 1, y))) {
        ctx.moveTo(px, py + tileHeight)
        ctx.lineTo(px, py)
      }
    }
    ctx.stroke()
    ctx.restore()
  }

  drawRect(ctx, rect, tileWidth, tileHeight, scale, border, fill) {
    const x = rect.x * tileWidth
    const y = rect.y * tileHeight
    const width = rect.width * tileWidth
    const height = rect.height * tileHeight
    ctx.save()
    ctx.fillStyle = fill
    ctx.fillRect(x, y, width, height)
    ctx.strokeStyle = border
    ctx.lineWidth = 2 / scale
    ctx.strokeRect(x, y, width, height)
    ctx.restore()
  }

  cellFromKey(key) {
    const [xText, yText] = key.split(",")
    const x = Number(xText)
    const y = Number(yText)
    assert(
      Number.isInteger(x) && Number.isInteger(y),
      `tilemap selection invalid cell key ${key}`,
    )
    return { x, y }
  }
}

export class ViewTilemap extends ViewCanvasBase {
  static get observedAttributes() {
    return [
      "data-source",
      "data-selection-add-key",
      "data-selection-remove-key",
    ]
  }

  constructor() {
    super()
    this.state = new TilemapState()
    this.handle = 0
    this.snapshot = validateSnapshot(this.state.snapshot())
    this.sidebarElement = null
    this.statusElement = null
    this.pathElement = null
    this.dimensionsElement = null
    this.dirtyElement = null
    this.layersElement = null
    this.historyElement = null
    this.tilesetTabsElement = null
    this.tilesetPanelsElement = null
    this.activeTilesetName = ""
    this.tilesets = [TilemapTileset.createDefault()]
    this.tilesetSourceKey = ""
    this.suppressDataSourceReload = false
    this.tilesetViewports = new Map()
    this.tilesetDrag = null
    this.tilesetResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (!(entry.target instanceof HTMLCanvasElement)) continue
        this.redrawTilesetCanvas(entry.target)
      }
    })
    this.selectedLayerIndexes = new Set()
    this.selectionTool = new TilemapSelectionTool({
      getAddKey: () => this.selectionAddKey,
      getRemoveKey: () => this.selectionRemoveKey,
    })
    this.eraseDragCells = null
    this.eraseChanges = null
    this.brushDragCells = null
    this.brushChanges = null
    this.clipboard = null
    this.pastePreviewCell = null
    this.showGrid = true
    this.tilemapRender = new TilemapRender()
    this.tilesetRender = new TilesetRender()
  }

  connectedCallback() {
    if (this.dataset.ready) return
    this.dataset.ready = "1"
    this.style.display = "contents"

    this.innerHTML = `
      <canvas data-element="canvas"></canvas>
      <aside data-element="sidebar">
        <fieldset>
          <legend>Layers</legend>
          <table class="compact-actions">
            <tbody data-element="layers"></tbody>
          </table>
        </fieldset>
        <fieldset data-element="tilesets">
          <legend>Tilesets</legend>
          <div role="buttongroup" data-element="tileset-actions">
            <button type="button" data-action="reload-tilesets" title="Reload tilesets from disk"><i aria-hidden="true">refresh</i></button>
          </div>
          <div role="tablist" data-element="tileset-tabs" aria-label="Tileset files"></div>
          <div data-element="tileset-panels"></div>
        </fieldset>
        <fieldset>
          <legend>History</legend>
          <table data-element="undo-history">
            <thead>
              <tr><th>#</th><th>Command</th><th>Parent</th><th>State</th></tr>
            </thead>
            <tbody></tbody>
          </table>
        </fieldset>
      </aside>
      <footer>
        <output data-element="path"></output>
        <output data-element="dimensions"></output>
        <output data-element="dirty"></output>
        <output data-element="status">No tilemap loaded</output>
      </footer>
    `

    this.sidebarElement = this.querySelector('[data-element="sidebar"]')
    this.statusElement = this.querySelector('[data-element="status"]')
    this.pathElement = this.querySelector('[data-element="path"]')
    this.dimensionsElement = this.querySelector('[data-element="dimensions"]')
    this.dirtyElement = this.querySelector('[data-element="dirty"]')
    this.layersElement = this.querySelector('[data-element="layers"]')
    this.historyElement = this.querySelector('[data-element="undo-history"]')
    this.tilesetTabsElement = this.querySelector(
      '[data-element="tileset-tabs"]',
    )
    this.tilesetPanelsElement = this.querySelector(
      '[data-element="tileset-panels"]',
    )

    assert(
      this.sidebarElement instanceof HTMLElement,
      "view-tilemap missing sidebar",
    )
    assert(
      this.statusElement instanceof HTMLOutputElement,
      "view-tilemap missing status output",
    )
    assert(
      this.pathElement instanceof HTMLOutputElement,
      "view-tilemap missing path output",
    )
    assert(
      this.dimensionsElement instanceof HTMLOutputElement,
      "view-tilemap missing dimensions output",
    )
    assert(
      this.dirtyElement instanceof HTMLOutputElement,
      "view-tilemap missing dirty output",
    )
    assert(
      this.historyElement instanceof HTMLTableElement,
      "view-tilemap missing undo history table",
    )
    assert(
      this.tilesetTabsElement instanceof HTMLElement,
      "view-tilemap missing tileset tabs",
    )
    assert(
      this.tilesetPanelsElement instanceof HTMLElement,
      "view-tilemap missing tileset panels",
    )

    super.connectedCallback()
    this.bindEvents()
    this.setData(this.snapshot, { autoFit: false })
    this.renderSnapshot(this.snapshot)
    void this.bootstrap()
  }

  disconnectedCallback() {
    this.tilesetResizeObserver.disconnect()
    super.disconnectedCallback()
  }

  createViewPluginMethods() {
    return {
      tool_1: async () => {
        await this.setTool(TOOL.SELECT)
        return viewOk()
      },
      tool_2: async () => {
        await this.setTool(TOOL.BRUSH)
        return viewOk()
      },
      tool_3: async () => {
        await this.setTool(TOOL.ERASE)
        return viewOk()
      },
      tool_4: async () => {
        await this.setTool(TOOL.EYEDROPPER)
        return viewOk()
      },
      tool_5: async () => {
        await this.setTool(TOOL.PASTE)
        return viewOk()
      },
      tool_6: async () => {
        await this.setTool(TOOL.FILL)
        return viewOk()
      },
    }
  }

  async undo() {
    await this.command("undo", "Undo")
  }

  async redo() {
    await this.command("redo", "Redo")
  }

  createHeaderControlsElement() {
    const controls = document.createElement("div")
    controls.dataset.element = "header-controls"
    controls.innerHTML = `
      <div role="buttongroup" data-element="file-actions">
        <button type="button" data-action="new"><i aria-hidden="true">docs</i></button>
        <button type="button" data-action="open"><i aria-hidden="true">folder_open</i></button>
        <button type="button" data-action="save" class="accent"><i aria-hidden="true">save</i></button>
        <button type="button" data-action="save-as"><i aria-hidden="true">save_as</i></button>
        <button type="button" data-action="reload"><i aria-hidden="true">refresh</i></button>
      </div>
      <div role="buttongroup" data-element="tool-actions">
        <button type="button" data-action="select" data-tool="0"><i aria-hidden="true">select_all</i></button>
        <button type="button" data-action="brush" data-tool="1"><i aria-hidden="true">brush</i></button>
        <button type="button" data-action="erase" data-tool="2"><i aria-hidden="true">ink_eraser</i></button>
        <button type="button" data-action="eyedropper" data-tool="3"><i aria-hidden="true">colorize</i></button>
        <button type="button" data-action="paste-tool" data-tool="4"><i aria-hidden="true">content_paste</i></button>
        <button type="button" data-action="fill" data-tool="5"><i aria-hidden="true">format_color_fill</i></button>
      </div>
      <div role="buttongroup" data-element="edit-actions">
        <button type="button" data-action="cut"><i aria-hidden="true">content_cut</i></button>
        <button type="button" data-action="copy"><i aria-hidden="true">content_copy</i></button>
        <button type="button" data-action="undo"><i aria-hidden="true">undo</i></button>
        <button type="button" data-action="redo"><i aria-hidden="true">redo</i></button>
      </div>
      <div role="buttongroup" data-element="view-actions">
        <button type="button" data-action="grid" aria-selected="true"><i aria-hidden="true">grid_on</i></button>
        <button type="button" data-action="zoom-in"><i aria-hidden="true">zoom_in</i></button>
        <button type="button" data-action="zoom-fit"><i aria-hidden="true">fit_screen</i></button>
        <button type="button" data-action="zoom-out"><i aria-hidden="true">zoom_out</i></button>
      </div>
      <div role="buttongroup" data-element="config-actions">
        <button type="button" data-action="map-props"><i aria-hidden="true">tune</i></button>
        <button type="button" data-action="settings"><i aria-hidden="true">settings</i></button>
      </div>
    `
    return controls
  }

  bindEvents() {
    this.tilesetTabsElement.addEventListener("click", async (event) => {
      const button = event.target.closest('button[role="tab"]')
      if (!(button instanceof HTMLButtonElement)) return
      if (button.dataset.action === "tileset-add") {
        await this.addTilesetFromChooser()
        return
      }
      assert(
        button.dataset.tileset,
        "view-tilemap tileset tab requires data-tileset",
      )
      this.selectTilesetTab(button.dataset.tileset)
    })

    const reloadTilesetsButton = this.querySelector(
      '[data-action="reload-tilesets"]',
    )
    assert(
      reloadTilesetsButton instanceof HTMLButtonElement,
      "view-tilemap missing reload tilesets control",
    )
    reloadTilesetsButton.addEventListener("click", async () =>
      this.reloadTilesets(),
    )

    this.layersElement.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action]")
      if (button instanceof HTMLButtonElement) {
        await this.handleLayerAction(button)
        return
      }

      const row = event.target.closest("tr[data-layer-id]")
      if (!(row instanceof HTMLTableRowElement)) return
      await this.toggleLayerSelection(this.layerIndexFromRow(row))
    })

    this.historyElement.addEventListener("click", async (event) => {
      const row = event.target.closest("tr[data-history-index]")
      if (!(row instanceof HTMLTableRowElement)) return
      this.state.moveHistoryTo(Number(row.dataset.historyIndex))
      await this.refreshSnapshot("History state selected")
    })

    this.queryHeader('[data-action="new"]').addEventListener(
      "click",
      async () => this.new(),
    )
    this.queryHeader('[data-action="open"]').addEventListener(
      "click",
      async () => this.open(),
    )
    this.queryHeader('[data-action="save"]').addEventListener(
      "click",
      async () => this.save(),
    )
    this.queryHeader('[data-action="save-as"]').addEventListener(
      "click",
      async () => this.saveAs(),
    )
    this.queryHeader('[data-action="reload"]').addEventListener(
      "click",
      async () => this.reload(),
    )
    this.queryHeader('[data-action="select"]').addEventListener(
      "click",
      async () => this.setTool(TOOL.SELECT),
    )
    this.queryHeader('[data-action="brush"]').addEventListener(
      "click",
      async () => this.setTool(TOOL.BRUSH),
    )
    this.queryHeader('[data-action="erase"]').addEventListener(
      "click",
      async () => this.setTool(TOOL.ERASE),
    )
    this.queryHeader('[data-action="eyedropper"]').addEventListener(
      "click",
      async () => this.setTool(TOOL.EYEDROPPER),
    )
    this.queryHeader('[data-action="paste-tool"]').addEventListener(
      "click",
      async () => {
        if (!this.clipboard) return
        await this.setTool(TOOL.PASTE)
      },
    )
    this.queryHeader('[data-action="fill"]').addEventListener(
      "click",
      async () => this.setTool(TOOL.FILL),
    )
    this.queryHeader('[data-action="cut"]').addEventListener(
      "click",
      async () => this.cutSelection(),
    )
    this.queryHeader('[data-action="copy"]').addEventListener(
      "click",
      async () => this.copySelection(),
    )
    this.queryHeader('[data-action="undo"]').addEventListener(
      "click",
      async () => this.undo(),
    )
    this.queryHeader('[data-action="redo"]').addEventListener(
      "click",
      async () => this.redo(),
    )
    this.queryHeader('[data-action="grid"]').addEventListener("click", () =>
      this.toggleGrid(),
    )
    this.queryHeader('[data-action="zoom-in"]').addEventListener("click", () =>
      this.zoomIn(),
    )
    this.queryHeader('[data-action="zoom-fit"]').addEventListener("click", () =>
      this.zoomFit(),
    )
    this.queryHeader('[data-action="zoom-out"]').addEventListener("click", () =>
      this.zoomOut(),
    )
    this.queryHeader('[data-action="map-props"]').addEventListener(
      "click",
      async () => this.openMapProps(),
    )
    this.queryHeader('[data-action="settings"]').addEventListener(
      "click",
      async () => this.openSettings(),
    )
  }

  queryHeader(selector) {
    const element = this.queryHeaderControl(selector)
    assert(
      element instanceof HTMLElement,
      `view-tilemap missing header control ${selector}`,
    )
    return element
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return
    if (
      name === "data-source" &&
      this.dataset.ready &&
      !this.suppressDataSourceReload
    ) {
      const dataSource = String(newValue || "").trim()
      if (dataSource) void this.loadDataSource(dataSource)
    }
  }

  async bootstrap() {
    const dataSource = String(this.getAttribute("data-source") || "").trim()
    if (!dataSource) {
      this.setStatus("No tilemap loaded", "info")
      return
    }
    await this.loadDataSource(dataSource)
  }

  async loadDataSource(dataSource) {
    const path = this.normalizeTilemapDataSource(dataSource)
    this.setBusy(true)
    this.setStatus(`Opening ${path} tilemap…`, "info")
    try {
      await this.openPath(path, { autoFit: true })
    } catch (error) {
      this.setStatus(String(error?.message || error), "danger")
      await runtime.call("ui.toast.error", {
        message: String(error?.message || error),
      })
    } finally {
      this.setBusy(false)
    }
  }

  get selectionAddKey() {
    return String(this.dataset.selectionAddKey || DEFAULT_SELECT_ADD_KEY).trim()
  }

  get selectionRemoveKey() {
    return String(
      this.dataset.selectionRemoveKey || DEFAULT_SELECT_REMOVE_KEY,
    ).trim()
  }

  normalizeTilemapDataSource(dataSource) {
    const source = String(dataSource || "").trim()
    assert(
      source.length > 0,
      "view-tilemap data-source must be non-empty filesystem path",
    )
    return source
  }

  async openPath(path, { autoFit = true } = {}) {
    assert(
      typeof path === "string" && path.length > 0,
      "view-tilemap open requires tilemap path",
    )
    assert(
      typeof autoFit === "boolean",
      "view-tilemap open autoFit must be boolean",
    )
    const tilemap = await this.loadTilemapFile(path)
    const result = this.state.open(tilemap)
    assert(
      Number.isInteger(result.handle) && result.handle > 0,
      "view-tilemap open returned invalid handle",
    )
    this.handle = result.handle
    this.tilesetSourceKey = null
    this.selectedLayerIndexes.clear()
    this.selectedLayerIndexes.add(0)
    this.selectionTool.clear()
    this.eraseDragCells = null
    this.eraseChanges = null
    this.brushDragCells = null
    this.brushChanges = null
    this.clipboard = null
    this.pastePreviewCell = null
    await this.refreshSnapshot(`Opened ${tilemap.path}`, { autoFit })
    if (this.getAttribute("data-source") !== path) {
      this.suppressDataSourceReload = true
      try {
        this.setAttribute("data-source", path)
      } finally {
        this.suppressDataSourceReload = false
      }
    }
  }

  async handleLayerAction(button) {
    const layer = this.layerIndexFromActionButton(button)
    const action = button.dataset.action
    if (action === "layer-hidden") {
      const target = this.state.requireLayer(layer)
      this.state.setLayerHidden(layer, !target.hidden)
    } else if (action === "layer-insert") {
      const insertIndex = layer + 1
      this.state.insertLayer(insertIndex)
      this.selectedLayerIndexes.clear()
      this.selectedLayerIndexes.add(layer)
      this.state.setActiveLayer(layer)
    } else if (action === "layer-delete") {
      this.state.deleteLayer(layer)
    } else if (action === "layer-up") {
      const targetIndex = Math.min(this.state.layers.length - 1, layer + 1)
      this.state.moveLayer(layer, targetIndex)
      this.selectedLayerIndexes.clear()
      this.selectedLayerIndexes.add(targetIndex)
    } else if (action === "layer-down") {
      const targetIndex = Math.max(0, layer - 1)
      this.state.moveLayer(layer, targetIndex)
      this.selectedLayerIndexes.clear()
      this.selectedLayerIndexes.add(targetIndex)
    } else if (action === "layer-props") {
      await this.openLayerProps(layer)
      return
    } else {
      throw new Error(`view-tilemap unknown layer action ${action}`)
    }
    await this.refreshSnapshot("Layer updated")
  }

  async new() {
    const payload = unwrap(
      await runtime.call("ui.popup.open", {
        title: "Create Tilemap",
        size: "medium",
        tag: "tilemap-settings",
        attributes: {
          "data-mode": "create",
          "data-title": "Create Tilemap",
        },
      }),
    )
    if (payload?.reload) {
      await this.openPath(payload.path, { autoFit: true })
      await runtime.call("ui.toast.success", {
        message: `Created tilemap ${payload.path}`,
      })
    }
  }

  async open() {
    const selection = await this.chooseTilemapFile()
    if (selection.cancelled) return
    await this.openPath(selection.path, { autoFit: true })
  }

  async chooseTilemapFile() {
    const payload = unwrap(
      await runtime.call("ui.popup.open", this.createOpenTilemapPopupOptions()),
    )
    if (!payload || payload.cancelled) return { cancelled: true }
    const selection = Array.isArray(payload.selection)
      ? payload.selection[0]
      : payload.selection
    assert(
      selection?.path,
      "view-tilemap open requires selected tilemap file path",
    )
    return { cancelled: false, path: selection.path }
  }

  createOpenTilemapPopupOptions() {
    return {
      title: "Open Tilemap",
      size: "medium",
      tag: "view-files",
      props: {
        mode: "chooser",
        filter: "*.tilemap.json,*.json",
      },
    }
  }

  async addTilesetFromChooser() {
    assert(this.snapshot, "view-tilemap add tileset requires current snapshot")
    const payload = unwrap(
      await runtime.call("ui.popup.open", {
        title: "Choose Tileset QOI",
        size: "medium",
        tag: "view-files",
        props: {
          mode: "chooser",
          filter: "*.qoi",
        },
      }),
    )
    if (!payload || payload.cancelled) return
    const selection = Array.isArray(payload.selection)
      ? payload.selection[0]
      : payload.selection
    assert(
      selection?.path,
      "view-tilemap add tileset requires selected QOI path",
    )
    await this.addTilesetPath(selection.path)
  }

  async addTilesetPath(path) {
    assert(
      typeof path === "string" && path.length > 0,
      "view-tilemap add tileset requires path",
    )
    assert(
      path.toLowerCase().endsWith(".qoi"),
      "view-tilemap add tileset requires .qoi file",
    )
    const snapshot = this.requireSnapshot()
    const specs = this.collectTilesetSpecs(snapshot)
    specs.push({
      name: this.uniqueTilesetName(this.nameFromTilesetPath(path), specs),
      path,
      count: 0,
    })
    this.state.setTilesetSpecs(
      specs.map((spec) => ({
        name: spec.name,
        file: spec.path,
        ...(spec.count > 0 ? { count: spec.count } : {}),
      })),
    )
    this.activeTilesetName = specs[specs.length - 1].name
    await this.refreshSnapshot(`Added tileset ${this.activeTilesetName}`)
    await runtime.call("ui.toast.success", {
      message: `Added tileset ${this.activeTilesetName}`,
    })
  }

  uniqueTilesetName(name, specs) {
    assert(
      typeof name === "string" && name.length > 0,
      "view-tilemap tileset name must be non-empty string",
    )
    assert(Array.isArray(specs), "view-tilemap tileset specs must be array")
    const used = new Set(specs.map((spec) => spec.name))
    if (!used.has(name)) return name
    let index = 2
    while (used.has(`${name}-${index}`)) index += 1
    return `${name}-${index}`
  }

  async loadTilemapFile(path) {
    return {
      path,
      data: unwrap(await runtime.invoke("fs/fs::read-text", path)),
    }
  }

  async writeTilemapFile(path, data) {
    unwrap(await runtime.invoke("fs/fs::write-text", path, data))
  }

  async saveAs() {
    const payload = await this.chooseSaveTarget()
    if (payload.cancelled) return
    await this.saveToPath(payload.path)
    await this.refreshSnapshot(`Saved as ${payload.path}`)
    await runtime.call("ui.toast.success", {
      message: `Saved tilemap ${payload.path}`,
    })
  }

  async save() {
    assert(this.snapshot, "view-tilemap save requires current snapshot")
    assert(
      typeof this.snapshot.path === "string" && this.snapshot.path.length > 0,
      "view-tilemap save requires current tilemap path",
    )
    await this.saveToPath(this.snapshot.path)
    await this.refreshSnapshot("Saved")
    await runtime.call("ui.toast.success", {
      message: `Saved tilemap ${this.snapshot.path}`,
    })
  }

  async chooseSaveTarget() {
    const payload = unwrap(
      await runtime.call("ui.popup.open", this.createSaveTilemapPopupOptions()),
    )
    if (!payload || payload.cancelled) return { cancelled: true }
    assert(
      typeof payload.path === "string" && payload.path.length > 0,
      "view-tilemap save-as requires tilemap file path",
    )
    return { cancelled: false, path: payload.path }
  }

  createSaveTilemapPopupOptions() {
    return {
      title: "Save Tilemap As",
      size: "medium",
      tag: "view-files",
      props: {
        mode: "saver",
        filter: "*.tilemap.json,*.json",
        defaultName: basename(this.snapshot?.path || "new.tilemap.json"),
      },
    }
  }

  async saveToPath(path) {
    assert(
      typeof path === "string" && path.length > 0,
      "view-tilemap save requires tilemap file path",
    )
    const data = `${this.state.toStorageData()}\n`
    await this.writeTilemapFile(path, data)
    this.state.save({ path })
  }

  async reload() {
    assert(this.snapshot, "view-tilemap reload requires current snapshot")
    assert(
      typeof this.snapshot.path === "string" && this.snapshot.path.length > 0,
      "view-tilemap reload requires current tilemap path",
    )
    await this.openPath(this.snapshot.path, { autoFit: true })
    this.setStatus(`Reloaded tilemap ${this.snapshot.path}`, "success")
    await runtime.call("ui.toast.success", {
      message: `Reloaded tilemap ${this.snapshot.path}`,
    })
  }

  async reloadTilesets() {
    const snapshot = this.requireSnapshot()
    const specs = this.collectTilesetSpecs(snapshot)
    if (specs.length === 0) {
      this.setStatus("Tilemap has no file-backed tilesets to reload", "info")
      return
    }

    this.setBusy(true)
    try {
      const previousTilesets = this.tilesets
      const nextTilesets = await this.createTilesetsForSnapshot(snapshot)
      this.validateReloadedTilesets(previousTilesets, nextTilesets)
      this.tilesets = nextTilesets
      this.tilemapRender.setTilesets(this.tilesets)
      this.renderTilesets(snapshot)
      this.draw()
      this.setStatus("Reloaded tilesets from disk", "success")
      await runtime.call("ui.toast.success", {
        message: "Reloaded tilesets from disk",
      })
    } catch (error) {
      this.setStatus(String(error?.message || error), "danger")
      await runtime.call("ui.toast.error", {
        message: String(error?.message || error),
      })
    } finally {
      this.setBusy(false)
    }
  }

  validateReloadedTilesets(previousTilesets, nextTilesets) {
    assert(
      Array.isArray(previousTilesets) && previousTilesets.length > 0,
      "view-tilemap reload tilesets requires previous tilesets",
    )
    assert(
      Array.isArray(nextTilesets) && nextTilesets.length > 0,
      "view-tilemap reload tilesets requires next tilesets",
    )
    assert(
      nextTilesets.length === previousTilesets.length,
      "view-tilemap reload changed tileset count; update tilemap settings instead",
    )

    for (let index = 0; index < nextTilesets.length; index++) {
      const previous = previousTilesets[index]
      const next = nextTilesets[index]
      assert(
        next.name === previous.name,
        "view-tilemap reload changed tileset order; update tilemap settings instead",
      )
      assert(
        next.path === previous.path,
        `view-tilemap reload changed tileset path for ${previous.name}; update tilemap settings instead`,
      )
      assert(
        next.tileWidth === previous.tileWidth &&
          next.tileHeight === previous.tileHeight,
        `view-tilemap reload changed tile size for ${previous.name}; update tilemap settings instead`,
      )
      assert(
        next.firstTileId === previous.firstTileId &&
          next.tileCount === previous.tileCount,
        `view-tilemap reload changed tile id range for ${previous.name}; update tilemap settings instead`,
      )
      assert(
        next.columns === previous.columns && next.rows === previous.rows,
        `view-tilemap reload changed tile grid for ${previous.name}; update tilemap settings instead`,
      )
      assert(
        next.width === previous.width && next.height === previous.height,
        `view-tilemap reload changed image size for ${previous.name}; update tilemap settings instead`,
      )
    }
  }

  async setTool(tool) {
    if (tool === TOOL.PASTE && !this.clipboard) {
      this.setStatus("Clipboard is empty", "info")
      return
    }
    this.state.setTool(tool)
    if (tool !== TOOL.SELECT) this.selectionTool.clearDrag()
    if (tool !== TOOL.ERASE) {
      this.eraseDragCells = null
      this.eraseChanges = null
    }
    if (tool !== TOOL.BRUSH) {
      this.brushDragCells = null
      this.brushChanges = null
    }
    if (tool !== TOOL.PASTE) this.pastePreviewCell = null
    await this.refreshSnapshot(`${TOOL_LABELS.get(tool)} tool selected`)
  }

  toggleGrid() {
    const button = this.queryHeader('[data-action="grid"]')
    assert(
      button instanceof HTMLButtonElement,
      "view-tilemap grid control must be a button",
    )
    const enabled = button.getAttribute("aria-selected") !== "true"
    button.setAttribute("aria-selected", enabled ? "true" : "false")
    this.showGrid = enabled
    this.draw()
    this.setStatus(
      enabled ? "Grid preview enabled" : "Grid preview disabled",
      "info",
    )
  }

  async command(method, label) {
    const fn = this.state[method]
    assert(
      typeof fn === "function",
      `view-tilemap state missing command ${method}`,
    )
    fn.call(this.state)
    await this.refreshSnapshot(label)
  }

  async copySelection() {
    if (!this.canCopySelection()) return
    const layers = this.copyLayerIndexes()
    const cells = this.selectionTool.cells()
    this.clipboard = this.state.copyCells(layers, cells)
    this.pastePreviewCell = null
    await this.refreshSnapshot("Selection copied")
  }

  async cutSelection() {
    if (!this.canCopySelection()) return
    const layers = this.copyLayerIndexes()
    const cells = this.selectionTool.cells()
    const result = this.state.cutCells(layers, cells)
    this.clipboard = result.clipboard
    this.pastePreviewCell = null
    await this.refreshSnapshot(
      result.changed ? "Selection cut" : "Selection copied",
    )
  }

  async deleteSelected() {
    if (!this.canCopySelection()) return
    const layers = this.copyLayerIndexes()
    const cells = this.selectionTool.cells()
    const changed = this.state.deleteCells(layers, cells)
    if (!changed) {
      this.setStatus("Nothing deleted", "info")
      return
    }
    await this.refreshSnapshot("Selection deleted")
  }

  canCopySelection() {
    return (
      this.selectionTool.selectedCells.size > 0 &&
      this.copyLayerIndexes().length > 0
    )
  }

  copyLayerIndexes() {
    return [...this.selectedLayerIndexes]
      .filter((index) => Number.isInteger(index) && index >= 0)
      .sort((a, b) => a - b)
  }

  async sampleTileAt(cell) {
    const layerIndex = this.eyedropperLayerIndex()
    if (!Number.isInteger(layerIndex)) {
      this.setStatus("Select a layer before sampling", "info")
      return
    }
    const tile = this.state.sampleTile(layerIndex, cell)
    this.state.setActiveTile(tile)
    await this.refreshSnapshot(`Sampled tile ${tile} from layer ${layerIndex}`)
  }

  eyedropperLayerIndex() {
    if (this.selectedLayerIndexes.size === 0) return null
    return Math.max(...this.selectedLayerIndexes)
  }

  async pasteClipboardAt(cell) {
    if (!this.clipboard) {
      this.setStatus("Clipboard is empty", "info")
      return
    }
    const targets = this.pasteTargetLayerIndexes()
    if (targets.length === 0) {
      this.setStatus("Select a target layer before pasting", "info")
      return
    }
    const changed = this.state.pasteClipboard(this.clipboard, cell, targets)
    if (!changed) {
      this.setStatus("Nothing pasted", "info")
      return
    }
    await this.refreshSnapshot("Clipboard pasted")
  }

  pasteTargetLayerIndexes() {
    assert(this.clipboard, "view-tilemap paste target requires clipboard")
    if (this.clipboard.entries.length > 1)
      return this.clipboard.entries.map((entry) => entry.sourceLayer)
    const selected = this.copyLayerIndexes()
    return selected.length === 1 ? selected : []
  }

  async openMapProps() {
    const snapshot = this.requireSnapshot()
    const payload = unwrap(
      await runtime.call("ui.popup.open", {
        title: "Map Properties",
        size: "medium",
        tag: "view-props",
        props: {
          title: "Map Properties",
          dataSource: snapshot.props,
        },
      }),
    )
    if (!payload || payload.cancelled) return
    this.state.setMapProps(payload.data)
    await this.refreshSnapshot("Map properties updated")
  }

  async openLayerProps(layerIndex) {
    const snapshot = this.requireSnapshot()
    const layer = snapshot.layers.find((entry) => entry.index === layerIndex)
    assert(layer, `view-tilemap missing layer ${layerIndex}`)
    const label = layerDisplayName(layer)
    const payload = unwrap(
      await runtime.call("ui.popup.open", {
        title: `${label} Properties`,
        size: "medium",
        tag: "view-props",
        props: {
          title: `${label} Properties`,
          dataSource: layer.props,
        },
      }),
    )
    if (!payload || payload.cancelled) return
    this.state.setLayerProps(layerIndex, payload.data)
    await this.refreshSnapshot(`${label} properties updated`)
  }

  async openSettings() {
    assert(this.snapshot, "view-tilemap settings requires current snapshot")
    assert(
      typeof this.snapshot.path === "string" && this.snapshot.path.length > 0,
      "view-tilemap settings requires current tilemap path",
    )
    await this.saveToPath(this.snapshot.path)
    await this.refreshSnapshot("Saved before opening settings")
    const payload = unwrap(
      await runtime.call("ui.popup.open", {
        title: "Tilemap Settings",
        size: "medium",
        tag: "tilemap-settings",
        attributes: {
          "data-mode": "edit",
          "data-title": "Tilemap Settings",
          "data-source": this.snapshot.path,
        },
      }),
    )
    if (payload?.reload) {
      await this.openPath(payload.path, { autoFit: true })
      await runtime.call("ui.toast.success", {
        message: `Updated tilemap ${payload.path}`,
      })
    }
  }

  async refreshSnapshot(statusText, { autoFit = false } = {}) {
    assert(
      typeof autoFit === "boolean",
      "view-tilemap refreshSnapshot autoFit must be boolean",
    )
    const snapshot = validateSnapshot(this.state.snapshot())
    await this.syncTilesets(snapshot)
    this.applyTileSize(snapshot)
    this.snapshot = snapshot
    this.setData(snapshot, { autoFit })
    this.renderSnapshot(snapshot)
    this.setStatus(statusText, snapshot.dirty ? "warning" : "success")
  }

  async syncTilesets(snapshot) {
    const sourceKey = this.createTilesetSourceKey(snapshot)
    if (
      sourceKey === this.tilesetSourceKey &&
      this.tilesetsCoverSnapshot(snapshot)
    )
      return
    this.tilesets = await this.createTilesetsForSnapshot(snapshot)
    this.tilesetSourceKey = sourceKey
    this.tilemapRender.setTilesets(this.tilesets)
  }

  tilesetsCoverSnapshot(snapshot) {
    const maxTileId = this.maxTileId(snapshot)
    if (maxTileId === 0) return true
    return this.tilesets.some((tileset) => tileset.containsTile(maxTileId))
  }

  createTilesetSourceKey(snapshot) {
    return JSON.stringify({
      tilesets: snapshot.props?.tilesets ?? "",
      tileSize: snapshot.props?.tileSize ?? "",
    })
  }

  async createTilesetsForSnapshot(snapshot) {
    return await createTilemapTilesets(snapshot)
  }

  maxTileId(snapshot) {
    return maxTileId(snapshot)
  }

  collectTilesetSpecs(snapshot) {
    return collectTilesetSpecs(snapshot)
  }

  nameFromTilesetPath(path) {
    const clean = String(path).split("?")[0]
    const file = clean.slice(clean.lastIndexOf("/") + 1)
    return file.replace(/\.[^.]+$/, "") || "tileset"
  }

  tileSizeForSnapshot(snapshot) {
    return tileSizeForTilemap(snapshot)
  }

  applyTileSize(snapshot) {
    const tileSize = this.tileSizeForSnapshot(snapshot)
    this.tilemapRender.tileWidth = tileSize
    this.tilemapRender.tileHeight = tileSize
  }

  requireHandle() {
    assert(
      Number.isInteger(this.handle) && this.handle > 0,
      "view-tilemap requires open handle",
    )
    return this.handle
  }

  renderSnapshot(snapshot) {
    if (!this.hasLoadedMap(snapshot)) {
      this.pathElement.textContent = "No tilemap loaded"
      this.dimensionsElement.textContent = ""
      this.dirtyElement.textContent = ""
      this.dirtyElement.className = ""
    } else {
      this.pathElement.textContent = `Path: ${snapshot.path}`
      this.dimensionsElement.textContent = `Size: ${snapshot.width} × ${snapshot.height}`
      this.dirtyElement.textContent = snapshot.dirty ? "Dirty" : "Saved"
      this.dirtyElement.className = snapshot.dirty ? "warning" : "success"
    }

    this.renderHeaderControls(snapshot)
    this.renderLayers(snapshot)
    this.renderTilesets(snapshot)
    this.renderHistory(snapshot)
  }

  renderHistory(snapshot) {
    assert(
      this.historyElement instanceof HTMLTableElement,
      "view-tilemap missing undo history table",
    )
    assert(
      Array.isArray(snapshot.history),
      "view-tilemap snapshot history must be array",
    )
    const tbody = this.historyElement.querySelector("tbody")
    assert(
      tbody instanceof HTMLTableSectionElement,
      "view-tilemap missing undo history tbody",
    )
    tbody.replaceChildren()

    if (snapshot.history.length === 0) {
      const row = document.createElement("tr")
      const cell = document.createElement("td")
      cell.colSpan = 4
      cell.textContent = "No history yet"
      row.appendChild(cell)
      tbody.appendChild(row)
      return
    }

    for (const entry of snapshot.history) {
      const row = document.createElement("tr")
      row.dataset.historyIndex = String(entry.index)
      if (entry.current) row.setAttribute("aria-selected", "true")

      const indexCell = document.createElement("td")
      indexCell.textContent = String(entry.index)
      row.appendChild(indexCell)

      const labelCell = document.createElement("td")
      labelCell.textContent = entry.label
      row.appendChild(labelCell)

      const parentCell = document.createElement("td")
      parentCell.textContent =
        entry.parentIndex >= 0 ? String(entry.parentIndex) : "root"
      row.appendChild(parentCell)

      const stateCell = document.createElement("td")
      stateCell.textContent = entry.current ? "Current" : ""
      row.appendChild(stateCell)

      tbody.appendChild(row)
    }
  }

  selectTilesetTab(name) {
    assert(
      typeof name === "string" && name.length > 0,
      "view-tilemap tileset tab requires name",
    )
    assert(
      this.tilesetTabsElement instanceof HTMLElement,
      "view-tilemap missing tileset tabs",
    )
    assert(
      this.tilesetPanelsElement instanceof HTMLElement,
      "view-tilemap missing tileset panels",
    )
    this.activeTilesetName = name

    for (const button of this.tilesetTabsElement.querySelectorAll(
      'button[role="tab"][data-tileset]',
    )) {
      assert(
        button instanceof HTMLButtonElement,
        "view-tilemap tileset tab must be a button",
      )
      const selected = button.dataset.tileset === name
      button.setAttribute("aria-selected", selected ? "true" : "false")
    }

    for (const panel of this.tilesetPanelsElement.querySelectorAll(
      '[role="tabpanel"][data-tileset]',
    )) {
      assert(
        panel instanceof HTMLFieldSetElement,
        "view-tilemap tileset panel must be a fieldset",
      )
      panel.hidden = panel.dataset.tileset !== name
    }

    const canvas = this.tilesetPanelsElement.querySelector(
      `[role="tabpanel"][data-tileset="${CSS.escape(name)}"] canvas[data-element="tileset-canvas"]`,
    )
    assert(
      canvas instanceof HTMLCanvasElement,
      "view-tilemap selected tileset panel requires canvas",
    )
    this.redrawTilesetCanvas(canvas)
  }

  renderTilesets(snapshot) {
    assert(
      snapshot && typeof snapshot === "object" && !Array.isArray(snapshot),
      "view-tilemap renderTilesets snapshot must be object",
    )
    assert(
      Number.isInteger(snapshot.activeTile),
      "view-tilemap active tile must be integer",
    )
    assert(
      this.tilesetTabsElement instanceof HTMLElement,
      "view-tilemap missing tileset tabs",
    )
    assert(
      this.tilesetPanelsElement instanceof HTMLElement,
      "view-tilemap missing tileset panels",
    )
    this.tilesetResizeObserver.disconnect()
    this.tilesetTabsElement.replaceChildren()
    this.tilesetPanelsElement.replaceChildren()

    const tilesets =
      this.tilesets.length > 0
        ? this.tilesets
        : [TilemapTileset.createDefault()]
    const activeTile = this.canShowTilesetActiveTile(snapshot.tool)
      ? snapshot.activeTile
      : null
    const activeTileset = Number.isInteger(activeTile)
      ? tilesets.find((tileset) =>
          this.tilesetRender.containsTile(tileset, activeTile),
        )
      : null
    const activeName = tilesets.some(
      (tileset) => tileset.name === this.activeTilesetName,
    )
      ? this.activeTilesetName
      : activeTileset?.name || tilesets[0].name

    const addTab = document.createElement("button")
    addTab.type = "button"
    addTab.setAttribute("role", "tab")
    addTab.setAttribute("aria-selected", "false")
    addTab.dataset.action = "tileset-add"
    addTab.title = "Add tileset"
    addTab.innerHTML = '<i aria-hidden="true">add</i>'
    this.tilesetTabsElement.appendChild(addTab)

    for (const tileset of tilesets) {
      const selected = tileset.name === activeName
      const panelId = `view-tilemap-tileset-${tileset.name}`

      const tab = document.createElement("button")
      tab.type = "button"
      tab.setAttribute("role", "tab")
      tab.setAttribute("aria-selected", selected ? "true" : "false")
      tab.setAttribute("aria-controls", panelId)
      tab.dataset.action = "tileset-tab"
      tab.dataset.tileset = tileset.name
      tab.textContent = tileset.name
      this.tilesetTabsElement.appendChild(tab)

      const panel = document.createElement("fieldset")
      panel.setAttribute("role", "tabpanel")
      panel.dataset.tileset = tileset.name
      panel.id = panelId
      panel.hidden = !selected

      const legend = document.createElement("legend")
      legend.textContent = tileset.name
      panel.appendChild(legend)

      const canvas = document.createElement("canvas")
      canvas.dataset.element = "tileset-canvas"
      canvas.dataset.tileset = tileset.name
      canvas.style.width = "100%"
      canvas.style.minWidth = "0"
      canvas.style.maxWidth = "100%"
      canvas.addEventListener("wheel", (event) =>
        this.onTilesetWheel(event, tileset),
      )
      canvas.addEventListener("mousedown", (event) =>
        this.onTilesetMouseDown(event, tileset),
      )
      canvas.addEventListener("mousemove", (event) =>
        this.onTilesetMouseMove(event, tileset),
      )
      canvas.addEventListener("mouseup", (event) =>
        this.onTilesetMouseUp(event, tileset),
      )
      canvas.addEventListener("mouseleave", (event) =>
        this.onTilesetMouseLeave(event, tileset),
      )
      canvas.addEventListener("click", async (event) =>
        this.selectTileFromTileset(event, tileset),
      )
      panel.appendChild(canvas)
      this.tilesetPanelsElement.appendChild(panel)
      this.resizeTilesetCanvas(canvas, tileset)
      this.drawTilesetCanvas(canvas, tileset, snapshot)
      this.tilesetResizeObserver.observe(canvas)
    }

    this.activeTilesetName = activeName
  }

  resizeTilesetCanvas(canvas, tileset) {
    assert(
      canvas instanceof HTMLCanvasElement,
      "view-tilemap resize tileset requires canvas",
    )
    this.tilesetRender.validateTileset(tileset)
    const layoutWidth = this.tilesetRender.layoutWidth(tileset)
    const layoutHeight = this.tilesetRender.layoutHeight(tileset)
    const rect = canvas.getBoundingClientRect()
    assert(canvas.parentElement, "view-tilemap tileset canvas requires parent")
    const parentWidth = canvas.parentElement.getBoundingClientRect().width
    const measuredWidth = rect.width || parentWidth || layoutWidth
    const cssWidth = Math.max(1, Math.round(measuredWidth))
    const cssHeight = Math.max(
      1,
      Math.round(
        Math.min(cssWidth * 2, cssWidth * (layoutHeight / layoutWidth)),
      ),
    )
    canvas.style.height = `${cssHeight}px`
    canvas.width = cssWidth
    canvas.height = cssHeight
    this.constrainTilesetViewport(tileset, canvas)
  }

  drawTilesetCanvas(canvas, tileset, snapshot) {
    assert(
      canvas instanceof HTMLCanvasElement,
      "view-tilemap draw tileset requires canvas",
    )
    assert(
      snapshot && typeof snapshot === "object" && !Array.isArray(snapshot),
      "view-tilemap draw tileset requires snapshot",
    )
    const activeTile = this.canShowTilesetActiveTile(snapshot.tool)
      ? snapshot.activeTile
      : null
    const clipboardTiles =
      snapshot.tool === TOOL.PASTE ? this.clipboardTileSet() : new Set()
    const viewport = this.getTilesetViewport(tileset)
    this.tilesetRender.draw(
      canvas,
      tileset,
      activeTile,
      clipboardTiles,
      viewport,
    )
  }

  redrawTilesetCanvas(canvas) {
    assert(
      canvas instanceof HTMLCanvasElement,
      "view-tilemap redraw tileset requires canvas",
    )
    assert(
      typeof canvas.dataset.tileset === "string" &&
        canvas.dataset.tileset.length > 0,
      "view-tilemap redraw tileset requires data-tileset",
    )
    const tileset = this.tilesets.find(
      (candidate) => candidate.name === canvas.dataset.tileset,
    )
    assert(tileset, "view-tilemap redraw tileset requires known tileset")
    this.resizeTilesetCanvas(canvas, tileset)
    this.drawTilesetCanvas(canvas, tileset, this.requireSnapshot())
  }

  getTilesetViewport(tileset) {
    this.tilesetRender.validateTileset(tileset)
    let viewport = this.tilesetViewports.get(tileset.name)
    if (!viewport) {
      viewport = { scale: 1, offsetX: 0, offsetY: 0 }
      this.tilesetViewports.set(tileset.name, viewport)
    }
    return viewport
  }

  constrainTilesetViewport(tileset, canvas) {
    const viewport = this.getTilesetViewport(tileset)
    viewport.scale = Math.max(
      TILESET_MIN_SCALE,
      Math.min(TILESET_MAX_SCALE, viewport.scale),
    )
    const scaledWidth = this.tilesetRender.layoutWidth(tileset) * viewport.scale
    const scaledHeight =
      this.tilesetRender.layoutHeight(tileset) * viewport.scale

    if (scaledWidth <= canvas.width) {
      viewport.offsetX = (canvas.width - scaledWidth) / 2
    } else {
      viewport.offsetX = Math.max(
        canvas.width - scaledWidth,
        Math.min(0, viewport.offsetX),
      )
    }

    if (scaledHeight <= canvas.height) {
      viewport.offsetY = (canvas.height - scaledHeight) / 2
    } else {
      viewport.offsetY = Math.max(
        canvas.height - scaledHeight,
        Math.min(0, viewport.offsetY),
      )
    }
  }

  tilesetZoomStep(scale, direction) {
    assert(
      direction === -1 || direction === 1,
      "tileset zoom direction invalid",
    )
    if (direction > 0) {
      return (
        TILESET_ZOOM_STEPS.find((step) => step > scale) || TILESET_MAX_SCALE
      )
    }
    for (let index = TILESET_ZOOM_STEPS.length - 1; index >= 0; index--) {
      if (TILESET_ZOOM_STEPS[index] < scale) return TILESET_ZOOM_STEPS[index]
    }
    return TILESET_MIN_SCALE
  }

  zoomTilesetAt(canvas, tileset, x, y, direction) {
    const viewport = this.getTilesetViewport(tileset)
    const oldScale = viewport.scale
    const newScale = this.tilesetZoomStep(oldScale, direction)
    if (newScale === oldScale) return
    const worldX = (x - viewport.offsetX) / oldScale
    const worldY = (y - viewport.offsetY) / oldScale
    viewport.scale = newScale
    viewport.offsetX = x - worldX * newScale
    viewport.offsetY = y - worldY * newScale
    this.constrainTilesetViewport(tileset, canvas)
    this.drawTilesetCanvas(canvas, tileset, this.requireSnapshot())
  }

  onTilesetWheel(event, tileset) {
    assert(
      event.currentTarget instanceof HTMLCanvasElement,
      "view-tilemap tileset wheel requires canvas",
    )
    event.preventDefault()
    const canvas = event.currentTarget
    if (event.ctrlKey || event.metaKey) {
      const rect = canvas.getBoundingClientRect()
      this.zoomTilesetAt(
        canvas,
        tileset,
        event.clientX - rect.left,
        event.clientY - rect.top,
        event.deltaY < 0 ? 1 : -1,
      )
      return
    }
    const viewport = this.getTilesetViewport(tileset)
    viewport.offsetX -= event.deltaX
    viewport.offsetY -= event.deltaY
    this.constrainTilesetViewport(tileset, canvas)
    this.drawTilesetCanvas(canvas, tileset, this.requireSnapshot())
  }

  onTilesetMouseDown(event, tileset) {
    assert(
      event.currentTarget instanceof HTMLCanvasElement,
      "view-tilemap tileset mousedown requires canvas",
    )
    if (!this.spacePressed) return
    event.preventDefault()
    const viewport = this.getTilesetViewport(tileset)
    this.tilesetDrag = {
      canvas: event.currentTarget,
      tileset,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: viewport.offsetX,
      offsetY: viewport.offsetY,
      moved: false,
    }
    event.currentTarget.dataset.dragged = "0"
    event.currentTarget.style.cursor = "grabbing"
  }

  onTilesetMouseMove(event, tileset) {
    assert(
      event.currentTarget instanceof HTMLCanvasElement,
      "view-tilemap tileset mousemove requires canvas",
    )
    if (!this.tilesetDrag || this.tilesetDrag.canvas !== event.currentTarget)
      return
    event.preventDefault()
    const viewport = this.getTilesetViewport(tileset)
    const dx = event.clientX - this.tilesetDrag.startX
    const dy = event.clientY - this.tilesetDrag.startY
    if (Math.abs(dx) + Math.abs(dy) > 2) {
      this.tilesetDrag.moved = true
      event.currentTarget.dataset.dragged = "1"
    }
    viewport.offsetX = this.tilesetDrag.offsetX + dx
    viewport.offsetY = this.tilesetDrag.offsetY + dy
    this.constrainTilesetViewport(tileset, event.currentTarget)
    this.drawTilesetCanvas(event.currentTarget, tileset, this.requireSnapshot())
  }

  onTilesetMouseUp(event, _tileset) {
    assert(
      event.currentTarget instanceof HTMLCanvasElement,
      "view-tilemap tileset mouseup requires canvas",
    )
    if (!this.tilesetDrag || this.tilesetDrag.canvas !== event.currentTarget)
      return
    event.currentTarget.style.cursor = this.spacePressed ? "grab" : "default"
    this.tilesetDrag = null
  }

  onTilesetMouseLeave(event, _tileset) {
    assert(
      event.currentTarget instanceof HTMLCanvasElement,
      "view-tilemap tileset mouseleave requires canvas",
    )
    if (this.tilesetDrag && this.tilesetDrag.canvas === event.currentTarget)
      this.tilesetDrag = null
    event.currentTarget.style.cursor = this.spacePressed ? "grab" : "default"
  }

  canShowTilesetActiveTile(tool) {
    return (
      tool === TOOL.BRUSH ||
      tool === TOOL.EYEDROPPER ||
      tool === TOOL.PASTE ||
      tool === TOOL.FILL
    )
  }

  clipboardTileSet() {
    const tiles = new Set()
    if (!this.clipboard) return tiles
    for (const entry of this.clipboard.entries) {
      for (const tile of entry.tiles) {
        if (tile.tile !== 0) tiles.add(tile.tile)
      }
    }
    return tiles
  }

  async selectTileFromTileset(event, tileset) {
    assert(
      event.currentTarget instanceof HTMLCanvasElement,
      "view-tilemap tileset click requires canvas",
    )
    if (event.currentTarget.dataset.dragged === "1") {
      event.currentTarget.dataset.dragged = "0"
      return
    }
    const tile = this.tilesetRender.tileFromPointerEvent(
      event,
      tileset,
      this.getTilesetViewport(tileset),
    )
    if (tile === null) return
    this.state.setActiveTile(tile)
    const snapshot = this.requireSnapshot()
    if (snapshot.tool !== TOOL.BRUSH && snapshot.tool !== TOOL.FILL) {
      await this.setTool(TOOL.BRUSH)
      this.setStatus(
        `Active tile ${tile} selected from ${tileset.name}`,
        "info",
      )
      return
    }
    await this.refreshSnapshot(
      `Active tile ${tile} selected from ${tileset.name}`,
    )
  }

  renderHeaderControls(snapshot) {
    assert(
      this._headerControlsElement instanceof HTMLElement,
      "view-tilemap missing header controls",
    )
    for (const button of this._headerControlsElement.querySelectorAll(
      "button[data-tool]",
    )) {
      assert(
        button instanceof HTMLButtonElement,
        "view-tilemap tool control must be a button",
      )
      const selected = Number(button.dataset.tool) === snapshot.tool
      button.classList.toggle("accent", selected)
      if (selected) button.setAttribute("aria-selected", "true")
      else button.removeAttribute("aria-selected")
    }

    const undoButton = this.queryHeader('[data-action="undo"]')
    const redoButton = this.queryHeader('[data-action="redo"]')
    const cutButton = this.queryHeader('[data-action="cut"]')
    const copyButton = this.queryHeader('[data-action="copy"]')
    const pasteButton = this.queryHeader('[data-action="paste-tool"]')
    assert(
      undoButton instanceof HTMLButtonElement,
      "view-tilemap undo control must be a button",
    )
    assert(
      redoButton instanceof HTMLButtonElement,
      "view-tilemap redo control must be a button",
    )
    assert(
      cutButton instanceof HTMLButtonElement,
      "view-tilemap cut control must be a button",
    )
    assert(
      copyButton instanceof HTMLButtonElement,
      "view-tilemap copy control must be a button",
    )
    assert(
      pasteButton instanceof HTMLButtonElement,
      "view-tilemap paste control must be a button",
    )
    undoButton.disabled = !snapshot.canUndo
    redoButton.disabled = !snapshot.canRedo
    cutButton.disabled = !this.canCopySelection()
    copyButton.disabled = !this.canCopySelection()
    pasteButton.disabled = !this.clipboard
  }

  normalizeSelectedLayers(snapshot) {
    const available = new Set(snapshot.layers.map((layer) => layer.index))
    for (const index of [...this.selectedLayerIndexes]) {
      if (!available.has(index)) this.selectedLayerIndexes.delete(index)
    }
  }

  async toggleLayerSelection(layer) {
    if (this.selectedLayerIndexes.has(layer))
      this.selectedLayerIndexes.delete(layer)
    else this.selectedLayerIndexes.add(layer)

    await this.syncBackendActiveLayerFromSelection()
    const snapshot = this.requireSnapshot()
    this.renderLayers(snapshot)
    this.renderHeaderControls(snapshot)
    this.draw()
    this.setStatus("Layer selection updated", "info")
  }

  async syncBackendActiveLayerFromSelection() {
    if (this.selectedLayerIndexes.size === 1) {
      const [layer] = [...this.selectedLayerIndexes]
      this.state.setActiveLayer(layer)
      return
    }

    this.state.setActiveLayer(-1)
  }

  clearSelection() {
    this.selectionTool.clear()
    this.renderHeaderControls(this.requireSnapshot())
    this.draw()
    this.setStatus("Selection cleared", "info")
  }

  requireSnapshot() {
    assert(this.snapshot, "view-tilemap requires snapshot")
    return this.snapshot
  }

  hasLoadedMap(snapshot = this.snapshot) {
    return Boolean(
      snapshot && Array.isArray(snapshot.layers) && snapshot.layers.length > 0,
    )
  }

  layerIndexFromActionButton(button) {
    const row = button.closest("tr[data-layer-id]")
    assert(
      row instanceof HTMLTableRowElement,
      "view-tilemap layer action requires containing layer row",
    )
    return this.layerIndexFromRow(row)
  }

  layerIndexFromRow(row) {
    const layerId = Number(row.dataset.layerId)
    assert(
      Number.isInteger(layerId) && layerId > 0,
      "view-tilemap layer row requires positive layer id",
    )
    const layer = this.state.layers.find((entry) => entry.id === layerId)
    assert(layer, `view-tilemap missing current layer for id ${layerId}`)
    return layer.index
  }

  renderLayers(snapshot) {
    const tbody = this.layersElement
    assert(
      tbody instanceof HTMLTableSectionElement,
      "view-tilemap missing layers tbody",
    )
    tbody.replaceChildren()
    this.normalizeSelectedLayers(snapshot)

    for (const layer of snapshot.layers.toReversed()) {
      const row = document.createElement("tr")
      row.dataset.layerId = String(layer.id)
      if (this.selectedLayerIndexes.has(layer.index))
        row.setAttribute("aria-selected", "true")

      const nameCell = document.createElement("td")
      nameCell.textContent = layerDisplayName(layer)
      row.appendChild(nameCell)

      const actionsCell = document.createElement("td")
      actionsCell.appendChild(
        this.createLayerButton(
          "layer-hidden",
          layer.hidden ? "visibility_off" : "visibility",
          layer.hidden ? "0" : "1",
        ),
      )

      actionsCell.appendChild(
        this.createLayerButton("layer-up", "arrow_upward", ""),
      )
      actionsCell.appendChild(
        this.createLayerButton("layer-down", "arrow_downward", ""),
      )
      actionsCell.appendChild(this.createLayerButton("layer-insert", "add", ""))
      actionsCell.appendChild(this.createLayerButton("layer-props", "tune", ""))
      actionsCell.appendChild(
        this.createLayerButton("layer-delete", "delete", ""),
      )
      row.appendChild(actionsCell)

      tbody.appendChild(row)
    }
  }

  calculateContentBounds(data) {
    const snapshot = data || this.snapshot || this.state.snapshot()
    return this.tilemapRender.calculateContentBounds(snapshot)
  }

  drawContent(ctx, data) {
    const snapshot = data || this.snapshot
    if (!snapshot) return
    this.tilemapRender.draw(ctx, {
      snapshot,
      selectedLayerIndexes: this.selectedLayerIndexes,
      showGrid: this.showGrid,
      scale: this.scale,
    })
    this.selectionTool.draw(ctx, {
      tileWidth: this.tilemapRender.tileWidth,
      tileHeight: this.tilemapRender.tileHeight,
      scale: this.scale,
    })
    this.drawPastePreview(ctx, snapshot)
  }

  onCanvasMouseDown(event) {
    if (event.button !== 0) return
    const snapshot = this.requireSnapshot()
    if (!this.hasLoadedMap(snapshot)) {
      this.setStatus("No tilemap loaded", "info")
      return
    }
    if (snapshot.tool === TOOL.SELECT) {
      event.preventDefault()
      this.focus()
      this.selectionTool.start(
        this.cellFromPointerEvent(event, snapshot),
        event,
      )
      this.draw()
      return
    }

    if (snapshot.tool === TOOL.BRUSH) {
      if (!this.pointerInsideTilemap(event, snapshot)) return
      event.preventDefault()
      this.focus()
      this.brushDragCells = new Map()
      this.brushChanges = new Map()
      this.addBrushDragCell(this.cellFromPointerEvent(event, snapshot))
      return
    }

    if (snapshot.tool === TOOL.ERASE) {
      if (!this.pointerInsideTilemap(event, snapshot)) return
      event.preventDefault()
      this.focus()
      this.eraseDragCells = new Map()
      this.eraseChanges = new Map()
      this.addEraseDragCell(this.cellFromPointerEvent(event, snapshot))
      return
    }

    if (snapshot.tool === TOOL.EYEDROPPER) {
      if (!this.pointerInsideTilemap(event, snapshot)) return
      event.preventDefault()
      this.focus()
      void this.sampleTileAt(this.cellFromPointerEvent(event, snapshot))
      return
    }

    if (snapshot.tool === TOOL.FILL) {
      event.preventDefault()
      this.focus()
      void this.fillTiles()
      return
    }

    if (snapshot.tool === TOOL.PASTE) {
      event.preventDefault()
      this.focus()
      const cell = this.pasteCellFromPointerEvent(event, snapshot)
      this.pastePreviewCell = cell
      void this.pasteClipboardAt(cell)
    }
  }

  onCanvasMouseMove(event) {
    if (this.selectionTool.drag) {
      const snapshot = this.requireSnapshot()
      this.selectionTool.update(this.cellFromPointerEvent(event, snapshot))
      this.draw()
      return
    }

    if (this.brushDragCells) {
      const snapshot = this.requireSnapshot()
      this.addBrushDragCell(this.cellFromPointerEvent(event, snapshot))
      return
    }

    if (this.eraseDragCells) {
      const snapshot = this.requireSnapshot()
      this.addEraseDragCell(this.cellFromPointerEvent(event, snapshot))
      return
    }

    const snapshot = this.requireSnapshot()
    if (!this.hasLoadedMap(snapshot)) return
    if (snapshot.tool === TOOL.PASTE && this.clipboard) {
      this.pastePreviewCell = this.pasteCellFromPointerEvent(event, snapshot)
      this.draw()
    }
  }

  onCanvasMouseUp(event) {
    if (!this.hasLoadedMap(this.snapshot)) return
    if (this.selectionTool.drag) {
      const snapshot = this.requireSnapshot()
      const result = this.selectionTool.finish(
        this.cellFromPointerEvent(event, snapshot),
      )
      this.renderHeaderControls(snapshot)
      this.draw()
      this.setStatus(result.status, "info")
      return
    }

    if (this.brushDragCells) {
      const snapshot = this.requireSnapshot()
      this.addBrushDragCell(this.cellFromPointerEvent(event, snapshot))
      void this.finishBrushGesture(snapshot)
      return
    }

    if (this.eraseDragCells) {
      const snapshot = this.requireSnapshot()
      this.addEraseDragCell(this.cellFromPointerEvent(event, snapshot))
      void this.finishEraseGesture(snapshot)
    }
  }

  addBrushDragCell(cell) {
    assert(
      this.brushDragCells instanceof Map,
      "view-tilemap brush drag cells must be Map",
    )
    assert(
      this.brushChanges instanceof Map,
      "view-tilemap brush changes must be Map",
    )
    if (
      this.selectionTool.selectedCells.size > 0 &&
      !this.selectionTool.containsCell(cell)
    )
      return
    const layerIndex = this.brushLayerIndex()
    if (!Number.isInteger(layerIndex)) return
    this.brushDragCells.set(this.selectionTool.key(cell.x, cell.y), cell)
    const changed = this.state.paintCellLive(
      layerIndex,
      cell,
      this.requireSnapshot().activeTile,
      this.brushChanges,
    )
    if (!changed) return
    this.snapshot = validateSnapshot(this.state.snapshot())
    this.setData(this.snapshot, { autoFit: false })
  }

  async finishBrushGesture(_snapshot) {
    assert(
      this.brushDragCells instanceof Map,
      "view-tilemap finish brush requires active brush gesture",
    )
    assert(
      this.brushChanges instanceof Map,
      "view-tilemap finish brush requires active brush changes",
    )
    const draggedCellCount = this.brushDragCells.size
    const changed = this.state.commitPaintChanges(this.brushChanges)
    this.brushDragCells = null
    this.brushChanges = null
    if (!changed) {
      this.setStatus(
        draggedCellCount === 0
          ? "Nothing painted outside active selection"
          : "Nothing painted",
        "info",
      )
      return
    }
    await this.refreshSnapshot("Tiles painted")
  }

  brushLayerIndex() {
    if (this.selectedLayerIndexes.size === 0) return null
    return Math.max(...this.selectedLayerIndexes)
  }

  async fillTiles() {
    const layerIndex = this.brushLayerIndex()
    if (!Number.isInteger(layerIndex)) {
      this.setStatus("Select a layer before filling", "info")
      return
    }
    const snapshot = this.requireSnapshot()
    const cells =
      this.selectionTool.selectedCells.size > 0
        ? this.selectionTool.cells()
        : this.allTilemapCells(snapshot)
    const changed = this.state.fillCells(layerIndex, cells, snapshot.activeTile)
    if (!changed) {
      this.setStatus("Nothing filled", "info")
      return
    }
    await this.refreshSnapshot("Tiles filled")
  }

  allTilemapCells(snapshot) {
    const cells = []
    for (let y = 0; y < snapshot.height; y++) {
      for (let x = 0; x < snapshot.width; x++) cells.push({ x, y })
    }
    return cells
  }

  addEraseDragCell(cell) {
    assert(
      this.eraseDragCells instanceof Map,
      "view-tilemap erase drag cells must be Map",
    )
    assert(
      this.eraseChanges instanceof Map,
      "view-tilemap erase changes must be Map",
    )
    if (
      this.selectionTool.selectedCells.size > 0 &&
      !this.selectionTool.containsCell(cell)
    )
      return
    this.eraseDragCells.set(this.selectionTool.key(cell.x, cell.y), cell)
    const changed = this.state.eraseCellLive(
      this.eraseLayerIndexes(this.requireSnapshot()),
      cell,
      this.eraseChanges,
    )
    if (!changed) return
    this.snapshot = validateSnapshot(this.state.snapshot())
    this.setData(this.snapshot, { autoFit: false })
  }

  async finishEraseGesture(_snapshot) {
    assert(
      this.eraseDragCells instanceof Map,
      "view-tilemap finish erase requires active erase gesture",
    )
    assert(
      this.eraseChanges instanceof Map,
      "view-tilemap finish erase requires active erase changes",
    )
    const draggedCellCount = this.eraseDragCells.size
    const changed = this.state.commitEraseChanges(this.eraseChanges)
    this.eraseDragCells = null
    this.eraseChanges = null
    if (!changed) {
      this.setStatus(
        draggedCellCount === 0
          ? "Nothing erased outside active selection"
          : "Nothing erased",
        "info",
      )
      return
    }
    await this.refreshSnapshot("Tiles erased")
  }

  eraseLayerIndexes(_snapshot) {
    return [...this.selectedLayerIndexes]
      .filter((index) => Number.isInteger(index) && index >= 0)
      .sort((a, b) => a - b)
  }

  drawPastePreview(ctx, snapshot) {
    if (
      snapshot.tool !== TOOL.PASTE ||
      !this.clipboard ||
      !this.pastePreviewCell
    )
      return
    ctx.save()
    ctx.globalAlpha = PASTE_PREVIEW_ALPHA
    for (const entry of this.clipboard.entries) {
      for (const tile of entry.tiles) {
        if (tile.tile === 0) continue
        const tileset = this.tilemapRender.findTileset(tile.tile)
        if (!tileset) continue
        tileset.drawTile(
          ctx,
          tile.tile,
          (this.pastePreviewCell.x + tile.dx) * this.tilemapRender.tileWidth,
          (this.pastePreviewCell.y + tile.dy) * this.tilemapRender.tileHeight,
          this.tilemapRender.tileWidth,
          this.tilemapRender.tileHeight,
        )
      }
    }
    ctx.globalAlpha = 1
    ctx.strokeStyle = SELECT_COLORS.ACTIVE_BORDER
    ctx.lineWidth = 2 / this.scale
    ctx.strokeRect(
      this.pastePreviewCell.x * this.tilemapRender.tileWidth,
      this.pastePreviewCell.y * this.tilemapRender.tileHeight,
      this.clipboard.width * this.tilemapRender.tileWidth,
      this.clipboard.height * this.tilemapRender.tileHeight,
    )
    ctx.restore()
  }

  pointerInsideTilemap(event, snapshot) {
    const point = this.getWorldPoint(event.clientX, event.clientY)
    return (
      point.x >= 0 &&
      point.y >= 0 &&
      point.x < snapshot.width * this.tilemapRender.tileWidth &&
      point.y < snapshot.height * this.tilemapRender.tileHeight
    )
  }

  pasteCellFromPointerEvent(event, snapshot) {
    assert(this.clipboard, "view-tilemap paste pointer requires clipboard")
    const point = this.getWorldPoint(event.clientX, event.clientY)
    const x = Math.floor(point.x / this.tilemapRender.tileWidth)
    const y = Math.floor(point.y / this.tilemapRender.tileHeight)
    return {
      x: Math.max(1 - this.clipboard.width, Math.min(snapshot.width - 1, x)),
      y: Math.max(1 - this.clipboard.height, Math.min(snapshot.height - 1, y)),
    }
  }

  cellFromPointerEvent(event, snapshot) {
    const point = this.getWorldPoint(event.clientX, event.clientY)
    return {
      x: Math.max(
        0,
        Math.min(
          snapshot.width - 1,
          Math.floor(point.x / this.tilemapRender.tileWidth),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          snapshot.height - 1,
          Math.floor(point.y / this.tilemapRender.tileHeight),
        ),
      ),
    }
  }

  createLayerButton(action, icon, next) {
    const button = document.createElement("button")
    button.type = "button"
    button.dataset.action = action
    if (next) button.dataset.next = next
    const iconElement = document.createElement("i")
    iconElement.setAttribute("aria-hidden", "true")
    iconElement.textContent = icon
    button.appendChild(iconElement)
    return button
  }

  setBusy(isBusy) {
    assert(
      this._headerControlsElement instanceof HTMLElement,
      "view-tilemap missing header controls",
    )
    for (const button of this._headerControlsElement.querySelectorAll(
      "button",
    )) {
      button.disabled = isBusy
    }
    if (!isBusy && this.snapshot) this.renderHeaderControls(this.snapshot)
  }

  setStatus(text, tone = "") {
    this.statusElement.textContent = text
    this.statusElement.className = ""
    if (tone) this.statusElement.classList.add(tone)
  }
}

class TilemapRender {
  constructor({
    tileWidth = DEFAULT_TILE_SIZE,
    tileHeight = DEFAULT_TILE_SIZE,
  } = {}) {
    this.rasterizer = new TilemapRasterizer({ tileWidth, tileHeight })
  }

  get tileWidth() {
    return this.rasterizer.tileWidth
  }

  set tileWidth(value) {
    this.rasterizer.tileWidth = value
  }

  get tileHeight() {
    return this.rasterizer.tileHeight
  }

  set tileHeight(value) {
    this.rasterizer.tileHeight = value
  }

  setTilesets(tilesets) {
    this.rasterizer.setTilesets(tilesets)
  }

  calculateContentBounds(snapshot) {
    return this.rasterizer.bounds(snapshot)
  }

  findTileset(tile) {
    return this.rasterizer.findTileset(tile)
  }

  draw(ctx, { snapshot, selectedLayerIndexes, showGrid, scale }) {
    assert(
      selectedLayerIndexes instanceof Set,
      "tilemap render selectedLayerIndexes must be Set",
    )
    const widthPx = snapshot.width * this.tileWidth
    const heightPx = snapshot.height * this.tileHeight
    ctx.save()
    this.drawBackground(ctx, snapshot, widthPx, heightPx)
    this.rasterizer.draw(ctx, snapshot, {
      layerAlpha: (layer) =>
        selectedLayerIndexes.size === 0 || selectedLayerIndexes.has(layer.index)
          ? 1
          : 0.24,
    })
    if (showGrid) this.drawGrid(ctx, snapshot, widthPx, heightPx, scale)
    this.drawBounds(ctx, widthPx, heightPx, scale)
    ctx.restore()
  }

  drawBackground(ctx, snapshot, widthPx, heightPx) {
    ctx.fillStyle = "#18212b"
    ctx.fillRect(0, 0, widthPx, heightPx)
    for (let y = 0; y < snapshot.height; y++) {
      for (let x = 0; x < snapshot.width; x++) {
        ctx.fillStyle = (x + y) % 2 ? "#243244" : "#202c3b"
        ctx.fillRect(
          x * this.tileWidth,
          y * this.tileHeight,
          this.tileWidth,
          this.tileHeight,
        )
      }
    }
  }

  drawGrid(ctx, snapshot, widthPx, heightPx, scale) {
    ctx.strokeStyle = "rgba(255,255,255,0.18)"
    ctx.lineWidth = 1 / scale
    ctx.beginPath()
    for (let x = 0; x <= snapshot.width; x++) {
      ctx.moveTo(x * this.tileWidth, 0)
      ctx.lineTo(x * this.tileWidth, heightPx)
    }
    for (let y = 0; y <= snapshot.height; y++) {
      ctx.moveTo(0, y * this.tileHeight)
      ctx.lineTo(widthPx, y * this.tileHeight)
    }
    ctx.stroke()
  }

  drawBounds(ctx, widthPx, heightPx, scale) {
    ctx.strokeStyle = "#ffcc66"
    ctx.lineWidth = 2 / scale
    ctx.strokeRect(0, 0, widthPx, heightPx)
  }
}

class TilesetRender {
  draw(canvas, tileset, activeTile, highlightedTiles = new Set(), viewport) {
    assert(
      canvas instanceof HTMLCanvasElement,
      "tileset render requires canvas",
    )
    this.validateTileset(tileset)
    assert(
      activeTile === null || Number.isInteger(activeTile),
      "tileset render activeTile must be integer or null",
    )
    assert(
      highlightedTiles instanceof Set,
      "tileset render highlightedTiles must be Set",
    )
    this.validateViewport(viewport)

    const ctx = canvas.getContext("2d")
    assert(ctx, "tileset render canvas requires 2d context")
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = "#151821"
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    ctx.save()
    ctx.translate(viewport.offsetX, viewport.offsetY)
    ctx.scale(viewport.scale, viewport.scale)

    const layoutWidth = this.layoutWidth(tileset)
    const layoutHeight = this.layoutHeight(tileset)
    this.drawTransparencyBackground(ctx, 0, 0, layoutWidth, layoutHeight)

    if (tileset.canvas) {
      ctx.drawImage(tileset.canvas, 0, 0)
    }

    ctx.strokeStyle = "#888"
    ctx.fillStyle = "#ddd"
    ctx.font = "10px monospace"

    for (let tileOffset = 0; tileOffset < tileset.tileCount; tileOffset++) {
      const tile = tileset.firstTileId + tileOffset
      const x = tileOffset % tileset.columns
      const y = Math.floor(tileOffset / tileset.columns)
      const px = x * tileset.tileWidth
      const py = y * tileset.tileHeight
      if (tileset.colorOnly) {
        ctx.fillStyle = "#111"
        ctx.fillText(String(tile), px + 2, py + 11)
      }
      ctx.strokeStyle = "rgba(255,255,255,0.42)"
      ctx.lineWidth = 1 / viewport.scale
      ctx.strokeRect(px + 0.5, py + 0.5, tileset.tileWidth, tileset.tileHeight)
      if (
        (Number.isInteger(activeTile) && tile === activeTile) ||
        highlightedTiles.has(tile)
      )
        this.drawActiveTile(ctx, px, py, tileset, viewport.scale)
    }

    ctx.restore()
  }

  tileFromPointerEvent(event, tileset, viewport) {
    assert(
      event.currentTarget instanceof HTMLCanvasElement,
      "tileset render pointer event requires canvas currentTarget",
    )
    this.validateTileset(tileset)
    this.validateViewport(viewport)
    const rect = event.currentTarget.getBoundingClientRect()
    const worldX =
      (event.clientX - rect.left - viewport.offsetX) / viewport.scale
    const worldY =
      (event.clientY - rect.top - viewport.offsetY) / viewport.scale
    if (
      worldX < 0 ||
      worldY < 0 ||
      worldX >= this.layoutWidth(tileset) ||
      worldY >= this.layoutHeight(tileset)
    )
      return null
    const x = Math.floor(worldX / tileset.tileWidth)
    const y = Math.floor(worldY / tileset.tileHeight)
    const tileOffset = y * tileset.columns + x
    if (tileOffset >= tileset.tileCount) return null
    return tileset.firstTileId + tileOffset
  }

  containsTile(tileset, tile) {
    this.validateTileset(tileset)
    assert(Number.isInteger(tile), "tileset render tile must be integer")
    return tileset.containsTile(tile)
  }

  drawActiveTile(ctx, px, py, tileset, scale) {
    assert(
      Number.isFinite(scale) && scale > 0,
      "tileset render active tile scale must be positive number",
    )
    ctx.save()
    ctx.strokeStyle = "#ffcc66"
    ctx.lineWidth = 2 / scale
    ctx.strokeRect(
      px + 1,
      py + 1,
      tileset.tileWidth - 2,
      tileset.tileHeight - 2,
    )
    ctx.strokeStyle = "#111"
    ctx.lineWidth = 1 / scale
    ctx.strokeRect(
      px + 3.5,
      py + 3.5,
      tileset.tileWidth - 7,
      tileset.tileHeight - 7,
    )
    ctx.restore()
  }

  drawTransparencyBackground(ctx, x, y, width, height) {
    assert(
      ctx instanceof CanvasRenderingContext2D,
      "tileset render background requires 2d context",
    )
    const size = 8
    ctx.save()
    ctx.fillStyle = "#2b2f3a"
    ctx.fillRect(x, y, width, height)
    ctx.fillStyle = "#3b4150"
    for (let py = y; py < y + height; py += size) {
      for (let px = x; px < x + width; px += size) {
        if (((px / size + py / size) & 1) === 0) {
          ctx.fillRect(px, py, size, size)
        }
      }
    }
    ctx.restore()
  }

  layoutWidth(tileset) {
    this.validateTileset(tileset)
    return tileset.columns * tileset.tileWidth
  }

  layoutHeight(tileset) {
    this.validateTileset(tileset)
    return tileset.rows * tileset.tileHeight
  }

  validateViewport(viewport) {
    assert(
      viewport && typeof viewport === "object" && !Array.isArray(viewport),
      "tileset render viewport must be an object",
    )
    assert(
      Number.isFinite(viewport.scale) && viewport.scale > 0,
      "tileset render viewport.scale must be positive number",
    )
    assert(
      Number.isFinite(viewport.offsetX),
      "tileset render viewport.offsetX must be finite number",
    )
    assert(
      Number.isFinite(viewport.offsetY),
      "tileset render viewport.offsetY must be finite number",
    )
  }

  validateTileset(tileset) {
    assert(
      tileset && typeof tileset === "object" && !Array.isArray(tileset),
      "tileset render tileset must be an object",
    )
    assert(
      typeof tileset.name === "string" && tileset.name.length > 0,
      "tileset render tileset.name must be non-empty string",
    )
    assert(
      typeof tileset.path === "string",
      "tileset render tileset.path must be string",
    )
    assert(
      Number.isInteger(tileset.tileWidth) && tileset.tileWidth > 0,
      "tileset render tileset.tileWidth must be positive integer",
    )
    assert(
      Number.isInteger(tileset.tileHeight) && tileset.tileHeight > 0,
      "tileset render tileset.tileHeight must be positive integer",
    )
    assert(
      Number.isInteger(tileset.columns) && tileset.columns > 0,
      "tileset render tileset.columns must be positive integer",
    )
    assert(
      Number.isInteger(tileset.rows) && tileset.rows > 0,
      "tileset render tileset.rows must be positive integer",
    )
    assert(
      Number.isInteger(tileset.firstTileId),
      "tileset render tileset.firstTileId must be integer",
    )
    assert(
      Number.isInteger(tileset.tileCount) && tileset.tileCount > 0,
      "tileset render tileset.tileCount must be positive integer",
    )
  }
}

if (!customElements.get("view-tilemap")) {
  customElements.define("view-tilemap", ViewTilemap)
}
