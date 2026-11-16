export * as Basemap from "./index.ts"

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Schema, Stream } from "effect"
import { PMTiles, type Source } from "pmtiles"
import { Config } from "../config.ts"
import { Engine } from "../engine.ts"
import { Status } from "../status.ts"
import DARK from "./dark.json" with { type: "json" }
import LIBERTY from "./liberty.json" with { type: "json" }

const DOMAIN = "basemap"

/**
 * The files of the offline basemap, as scripts/stage-basemap.mjs stages them: OpenFreeMap's styles draw the
 * OpenMapTiles vector tiles over Natural Earth's relief, with OpenFreeMap's icons.
 */
const ARCHIVES = { vector: "openmaptiles-z6.pmtiles", relief: "relief-z6.pmtiles" }
const SPRITES = ["ofm.json", "ofm.png", "ofm@2x.json", "ofm@2x.png"]

/**
 * What the styles point at, read through `tile` and `sprite`: the maps that draw them fetch through this scheme, which
 * desktop/packages/ui/src/geocode/basemapClient.ts reads as BASEMAP_SCHEME and RESOURCE; change them together.
 */
const SCHEME = "geocode-basemap"

const ATTRIBUTION = "© OpenMapTiles © OpenStreetMap contributors"

/**
 * The names a label shows in each interface language, the first one a place has; the local name last, as every
 * place has one. Road numbers and other labels that are no name keep the style's own text.
 */
const NAMES = {
  en: ["name:en", "name:latin", "name"],
  "zh-CN": ["name:zh-Hans", "name:zh", "name"],
  "zh-TW": ["name:zh-Hant", "name:zh", "name"],
}

const Block = Schema.Struct({ source: Schema.Literals(["offline", "none"]) })

const StyleParams = Schema.Struct({
  theme: Schema.Literals(["light", "dark"]),
  locale: Schema.Literals(["en", "zh-CN", "zh-TW"]),
})

const Coordinate = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const TileParams = Schema.Struct({
  layer: Schema.Literals(["vector", "relief"]),
  z: Coordinate,
  x: Coordinate,
  y: Coordinate,
})

const SpriteParams = Schema.Struct({ file: Schema.Literals(SPRITES) })

type Layer = { readonly layout?: { readonly "text-field"?: unknown } }

/** The basemap the settings choose, and whether the app holds its files; `invalid` while the block is written wrong. */
export interface State {
  readonly source: (typeof Block.Type)["source"]
  readonly available: boolean
  readonly invalid?: string
}

/** A style the maps can draw as they get it: its tiles, relief and icons from this module, its names in `locale`. */
export const style = (theme: (typeof StyleParams.Type)["theme"], locale: (typeof StyleParams.Type)["locale"]) => {
  const base = theme === "dark" ? DARK : LIBERTY
  const text = ["coalesce", ...NAMES[locale].map((key) => ["get", key])]
  const { glyphs: _, ...rest } = base
  return {
    ...rest,
    // No glyphs: MapLibre draws the labels with the system's fonts, which cover every script the names are in.
    sprite: `${SCHEME}://sprite/ofm`,
    sources: {
      openmaptiles: {
        type: "vector",
        tiles: [`${SCHEME}://vector/{z}/{x}/{y}`],
        maxzoom: 6,
        attribution: ATTRIBUTION,
      },
      ne2_shaded: { ...base.sources.ne2_shaded, tiles: [`${SCHEME}://relief/{z}/{x}/{y}`] },
    },
    layers: (base.layers as readonly Layer[]).map((layer) =>
      JSON.stringify(layer.layout?.["text-field"] ?? null).includes('"name')
        ? { ...layer, layout: { ...layer.layout, "text-field": text } }
        : layer,
    ),
  }
}

/** Reads an archive by ranges from its file. */
const fileSource = (file: string): Source => ({
  getKey: () => file,
  getBytes: async (offset, length) => {
    const handle = await fsp.open(file, "r")
    try {
      const data = new Uint8Array(length)
      const { bytesRead } = await handle.read(data, 0, length, offset)
      return { data: data.buffer.slice(0, bytesRead) }
    } finally {
      await handle.close()
    }
  },
})

/** The module, serving the files staged in `folder`. */
export const capability = (folder: string): Engine.Capability =>
  Effect.gen(function* () {
    const status = yield* Status.Service
    const config = yield* Config.Service
    const block = yield* config.block(DOMAIN, Block)
    // Staged with the app, so present or not for as long as it runs.
    const available = [...Object.values(ARCHIVES), ...SPRITES].every((file) => fs.existsSync(path.join(folder, file)))
    const stateOf = (state: Config.BlockState<typeof Block.Type>): State =>
      state.ok
        ? { source: state.value?.source ?? "offline", available }
        : { source: "offline", available, invalid: state.failure.message }
    const writer = yield* status.register<State>(DOMAIN, stateOf(yield* block.current))
    yield* Effect.forkScoped(
      Stream.runForEach(block.watch, (state) =>
        Effect.gen(function* () {
          yield* writer.commit(yield* writer.claim(), stateOf(state))
        }),
      ),
    )

    const archives = {
      vector: new PMTiles(fileSource(path.join(folder, ARCHIVES.vector))),
      relief: new PMTiles(fileSource(path.join(folder, ARCHIVES.relief))),
    }

    const invalid = (cause: unknown) => new Engine.Failure({ code: "invalid-params", message: String(cause) })
    const unavailable = () =>
      new Engine.Failure({ code: "unavailable", message: `the basemap's files are missing from ${folder}` })

    /** The style for the settings' basemap, or null when they choose none. */
    const getStyle: Engine.Method = (raw) =>
      Effect.gen(function* () {
        const params = Schema.decodeUnknownExit(StyleParams)(raw)
        if (Exit.isFailure(params)) return yield* invalid(params.cause)
        if (stateOf(yield* block.current).source === "none") return { style: null }
        if (!available) return yield* unavailable()
        return { style: style(params.value.theme, params.value.locale) }
      })

    const tile: Engine.Method = (raw, context) =>
      Effect.gen(function* () {
        const params = Schema.decodeUnknownExit(TileParams)(raw)
        if (Exit.isFailure(params)) return yield* invalid(params.cause)
        if (!available) return yield* unavailable()
        const { layer, z, x, y } = params.value
        if (x >= 2 ** z || y >= 2 ** z) return yield* invalid(`no tile ${z}/${x}/${y}`)
        // Decompressed: the maps take the tile as it is drawn.
        const found = yield* Effect.tryPromise({
          try: () => archives[layer].getZxy(z, x, y, context.signal),
          catch: (error) => new Engine.Failure({ code: "read-failed", message: String(error) }),
        })
        return found ? { bytes: new Uint8Array(found.data) } : { empty: true }
      })

    const sprite: Engine.Method = (raw) =>
      Effect.gen(function* () {
        const params = Schema.decodeUnknownExit(SpriteParams)(raw)
        if (Exit.isFailure(params)) return yield* invalid(params.cause)
        if (!available) return yield* unavailable()
        const bytes = yield* Effect.tryPromise({
          try: () => fsp.readFile(path.join(folder, params.value.file)),
          catch: (error) => new Engine.Failure({ code: "read-failed", message: String(error) }),
        })
        return { bytes: new Uint8Array(bytes) }
      })

    const configure: Engine.Method = (raw) =>
      Effect.gen(function* () {
        const params = Schema.decodeUnknownExit(Block)(raw)
        if (Exit.isFailure(params)) return yield* invalid(params.cause)
        // Refused before the write, whose own message would carry the file's location.
        if (!(yield* block.current).ok) {
          return yield* new Engine.Failure({
            code: "config-unreadable",
            message: "machine.json cannot be read, so it is left as it is",
          })
        }
        yield* block
          .write(params.value)
          .pipe(Effect.mapError((error) => new Engine.Failure({ code: "write-failed", message: error.message })))
        return {}
      })

    return { domain: DOMAIN, methods: { style: getStyle, tile, sprite, configure } }
  })
