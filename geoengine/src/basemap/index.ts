export * as Basemap from "./index.ts"

import { createHash } from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Schema, Stream } from "effect"
import { PMTiles, type Source } from "pmtiles"
import { Config } from "../config.ts"
import { Engine } from "../engine.ts"
import { Geocodekit } from "../python/geocodekit.ts"
import { Status } from "../status.ts"
import { downloader, type Download, type Options } from "./download.ts"
import {
  isRecord,
  NAME,
  offline,
  online,
  raster,
  tilejsonOf,
  type Json,
  type Locale,
  type Schema as Names,
  type Theme,
  type Upstream,
} from "./styles.ts"

const DOMAIN = "basemap"

/**
 * The files of the offline basemap, as scripts/stage-basemap.mjs stages them: OpenFreeMap's styles draw the
 * OpenMapTiles vector tiles over Natural Earth's relief, with OpenFreeMap's icons.
 */
const ARCHIVES = { vector: "openmaptiles-z6.pmtiles", relief: "relief-z6.pmtiles" }
const SPRITES = ["ofm.json", "ofm.png", "ofm@2x.json", "ofm@2x.png"]

/** As the OSM tools name GeoCode to the services they ask (geoengine/src/osm/index.ts); change both together. */
const AGENT = `GeoCode/${Geocodekit.PACKAGE.version} (+https://github.com/zzhonglei/GeoCode)`

// The kinds and styles, as desktop/packages/ui/src/geocode/geoStatus.ts reads them in the status; change both together.
const SOURCES = ["offline", "openfreemap", "versatiles", "osm", "tianditu", "custom", "none"] as const
const OPENFREEMAP = ["liberty", "bright", "positron", "fiord"] as const
const VERSATILES = ["colorful", "gray", "muted"] as const
/** Tianditu's base layers, each drawn with its own labels: vector, imagery and terrain. */
const TIANDITU = { vec: "cva", img: "cia", ter: "cta" } as const
const TIANDITU_LAYERS = Object.entries(TIANDITU).flat()

type TiandituLayer = keyof typeof TIANDITU

/** The online vector basemaps: where a style is, by its name, its tiles' schema and the credit their licence asks for. */
const PROVIDERS = {
  openfreemap: {
    style: (name: string) => `https://tiles.openfreemap.org/styles/${name}`,
    fallback: "liberty",
    schema: "openmaptiles",
    credit: "OpenFreeMap © OpenMapTiles © OpenStreetMap contributors",
  },
  versatiles: {
    style: (name: string) => `https://tiles.versatiles.org/assets/styles/${name}/style.json`,
    fallback: "colorful",
    schema: "shortbread",
    credit: "© VersaTiles © OpenStreetMap contributors",
  },
} satisfies Record<string, { style: (name: string) => string; fallback: string; schema: Names; credit: string }>

type Provider = keyof typeof PROVIDERS

/** The dark style a provider draws for each of its own in a dark interface; Fiord is dark already. */
const darkOf = {
  openfreemap: (name: string) => (name === "fiord" ? name : "dark"),
  versatiles: (name: string) => `${name}-dark`,
} satisfies Record<Provider, (name: string) => string>

const OSM = { tiles: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", credit: "© OpenStreetMap contributors" }

/** Shared among t0 to t7; a tile always from the same, so the cache holds it under one address. */
const tiandituUrl = (layer: string, z: number, x: number, y: number) =>
  `https://t${(x + y) % 8}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}` +
  `&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`

/**
 * An XYZ address of the user's: http or https, with the three numbers of a tile, and `{s}` for a server among a, b and
 * c, as Leaflet writes them; no other placeholder, which would never be filled. As BasemapDetails.tsx checks it before
 * it is sent; change both together.
 */
const Template = Schema.String.check(
  Schema.isPattern(/^https?:\/\/(?=\S*\{z\})(?=\S*\{x\})(?=\S*\{y\})(?:[^\s{}]|\{[zxys]\})+$/),
)
/** Tianditu's key: letters and digits, as it goes into an address; as BasemapDetails.tsx checks it too. */
const Key = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]+$/))

const Tianditu = Schema.Struct({
  key: Schema.optionalKey(Key),
  layer: Schema.optionalKey(Schema.Literals(["vec", "img", "ter"])),
})
const Custom = Schema.Struct({ url: Template, attribution: Schema.optionalKey(Schema.String) })

/** The basemap chosen, and what each kind was last set to, kept while another is chosen. */
const Block = Schema.Struct({
  source: Schema.Literals(SOURCES),
  openfreemap: Schema.optionalKey(Schema.Literals(OPENFREEMAP)),
  versatiles: Schema.optionalKey(Schema.Literals(VERSATILES)),
  tianditu: Schema.optionalKey(Tianditu),
  custom: Schema.optionalKey(Custom),
})

type Block = typeof Block.Type

/** What `configure` changes; the rest stays as written. */
const Change = Schema.Struct({
  source: Schema.optionalKey(Schema.Literals(SOURCES)),
  openfreemap: Schema.optionalKey(Schema.Literals(OPENFREEMAP)),
  versatiles: Schema.optionalKey(Schema.Literals(VERSATILES)),
  tianditu: Schema.optionalKey(Tianditu),
  custom: Schema.optionalKey(Custom),
})

const StyleParams = Schema.Struct({
  theme: Schema.Literals(["light", "dark"]),
  locale: Schema.Literals(["en", "zh-CN", "zh-TW"]),
})

const Coordinate = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const TileParams = Schema.Struct({
  layer: Schema.String.check(Schema.isPattern(NAME)),
  z: Coordinate,
  x: Coordinate,
  y: Coordinate,
})

const SpriteParams = Schema.Struct({
  file: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]*?(?:@2x)?\.(?:json|png)$/)),
})

/**
 * The basemap the settings choose and how each kind is set; whether the app holds the offline basemap's files; `invalid`
 * while the block is written wrong. Tianditu's key is told only by its fingerprint, which changes with it.
 */
export interface State {
  readonly source: Block["source"]
  readonly openfreemap: (typeof OPENFREEMAP)[number]
  readonly versatiles: (typeof VERSATILES)[number]
  readonly tianditu: { readonly layer: TiandituLayer; readonly key?: string }
  readonly custom?: { readonly url: string; readonly attribution?: string }
  readonly available: boolean
  readonly invalid?: string
}

/** The block with `change` made to it: a kind's settings change only as far as `change` names them. */
const merged = (current: Block | undefined, change: typeof Change.Type): Block => {
  const base: Block = current ?? { source: "offline" }
  const tianditu = change.tianditu ? { ...base.tianditu, ...change.tianditu } : base.tianditu
  const custom = change.custom ?? base.custom
  const openfreemap = change.openfreemap ?? base.openfreemap
  const versatiles = change.versatiles ?? base.versatiles
  return {
    source: change.source ?? base.source,
    ...(openfreemap ? { openfreemap } : {}),
    ...(versatiles ? { versatiles } : {}),
    ...(tianditu ? { tianditu } : {}),
    ...(custom ? { custom } : {}),
  }
}

/** Why `block` cannot be drawn, if it cannot. */
const lacking = (block: Block) => {
  if (block.source === "tianditu" && !block.tianditu?.key) return "Tianditu needs a key"
  if (block.source === "custom" && !block.custom) return "a custom basemap needs the address of its tiles"
  return undefined
}

/** `template` for one tile, from one server for a tile always. */
const filled = (template: string, z: number, x: number, y: number) =>
  template
    .replaceAll("{z}", String(z))
    .replaceAll("{x}", String(x))
    .replaceAll("{y}", String(y))
    .replaceAll("{s}", "abc"[(x + y) % 3] ?? "a")

/**
 * A short fingerprint of what the user set, in the names of the layers that read it: a new key or address gives the
 * style other names, so the maps already drawn read the new tiles, and the old names are refused.
 */
const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8)

/** The kind of basemap a layer of the scheme belongs to. */
const kindOf = (name: string) => name.split(".")[0]

/**
 * Where a tile of the online `layer` is downloaded from under the settings `block`, and the name it is cached by;
 * undefined for a layer of an online vector basemap, which its style leads to. Refused for a layer of a basemap the
 * settings do not choose, as a page may name any: it would reach the network, or spend Tianditu's quota, unasked.
 */
export const onlineTile = (
  block: Block,
  layer: string,
  z: number,
  x: number,
  y: number,
): { url: string; identity?: string } | { refused: string } | undefined => {
  if (kindOf(layer) !== block.source) return { refused: `${layer} is no part of the basemap the settings choose` }
  if (layer === "osm") return { url: filled(OSM.tiles, z, x, y) }
  const custom = /^custom\.([0-9a-f]{8})$/.exec(layer)
  if (custom) {
    if (!block.custom || custom[1] !== fingerprint(block.custom.url))
      return { refused: "the custom basemap has changed" }
    return { url: filled(block.custom.url, z, x, y) }
  }
  const tianditu = /^tianditu\.([a-z]{3})\.([0-9a-f]{8})$/.exec(layer)
  if (tianditu) {
    const key = block.tianditu?.key
    if (!TIANDITU_LAYERS.includes(tianditu[1] ?? "")) return { refused: `Tianditu has no layer ${tianditu[1]}` }
    if (!key || tianditu[2] !== fingerprint(key)) return { refused: "Tianditu's key has changed" }
    const url = tiandituUrl(tianditu[1] ?? "", z, x, y)
    // Cached under the address without the key, which is the user's and changes nothing a tile shows.
    return { url: `${url}&tk=${key}`, identity: url }
  }
  if (block.source === "openfreemap" || block.source === "versatiles") return undefined
  return { refused: `the basemap has nothing named ${layer}` }
}

/** The style for raster `chosen`, its layers named with what the user set. */
const rasterStyle = (chosen: Block) => {
  if (chosen.source === "osm") return raster([{ name: "osm", maxzoom: 19 }], OSM.credit)
  if (chosen.source === "tianditu" && chosen.tianditu?.key) {
    const layer = chosen.tianditu.layer ?? "vec"
    const mark = fingerprint(chosen.tianditu.key)
    return raster(
      [layer, TIANDITU[layer]].map((name) => ({ name: `tianditu.${name}.${mark}`, maxzoom: 18 })),
      "© 天地图",
    )
  }
  if (chosen.source === "custom" && chosen.custom) {
    return raster([{ name: `custom.${fingerprint(chosen.custom.url)}`, maxzoom: 19 }], chosen.custom.attribution ?? "")
  }
  return undefined
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

/** The module, serving the offline basemap staged in `folder` and the online ones, downloaded into `cache`. */
export const capability = (folder: string, cache: string): Engine.Capability =>
  Effect.gen(function* () {
    const status = yield* Status.Service
    const config = yield* Config.Service
    const block = yield* config.block(DOMAIN, Block)
    // Staged with the app, so present or not for as long as it runs.
    const available = [...Object.values(ARCHIVES), ...SPRITES].every((file) => fs.existsSync(path.join(folder, file)))
    const stateOf = (state: Config.BlockState<Block>): State => {
      const value = state.ok ? state.value : undefined
      return {
        source: value?.source ?? "offline",
        openfreemap: value?.openfreemap ?? "liberty",
        versatiles: value?.versatiles ?? "colorful",
        tianditu: {
          layer: value?.tianditu?.layer ?? "vec",
          ...(value?.tianditu?.key ? { key: fingerprint(value.tianditu.key) } : {}),
        },
        ...(value?.custom ? { custom: value.custom } : {}),
        available,
        ...(state.ok ? {} : { invalid: state.failure.message }),
      }
    }
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
    const downloads = downloader(cache, AGENT)
    yield* Effect.forkScoped(Effect.promise(() => downloads.trim().catch(() => {})))
    // Where the online styles' names lead, from every style made since the engine started.
    const upstream = { tiles: new Map<string, string>(), sprites: new Map<string, string>() }

    const invalid = (cause: unknown) => new Engine.Failure({ code: "invalid-params", message: String(cause) })
    const unavailable = () =>
      new Engine.Failure({ code: "unavailable", message: `the basemap's files are missing from ${folder}` })
    const unreachable = (error: unknown) =>
      new Engine.Failure({ code: "unreachable", message: error instanceof Error ? error.message : String(error) })
    const download = (url: string, signal: AbortSignal, options?: Options) =>
      Effect.tryPromise({ try: () => downloads.get(url, signal, options), catch: unreachable })
    const parsed = (bytes: Uint8Array | null) => JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array()))
    const parses = (bytes: Uint8Array) => {
      try {
        parsed(bytes)
        return true
      } catch {
        return false
      }
    }
    // Checked before it is kept: a file that is no JSON would stand for the style for a week.
    const json = (url: string, signal: AbortSignal) =>
      download(url, signal, { check: parses }).pipe(
        Effect.flatMap((bytes) => Effect.try({ try: () => parsed(bytes), catch: unreachable })),
      )

    /** A provider's style named `name`, rewritten to be read through this module; what its names lead to is kept. */
    const providerStyle = (provider: Provider, name: string, locale: Locale, signal: AbortSignal) =>
      Effect.gen(function* () {
        const { style: at, schema, credit } = PROVIDERS[provider]
        const style = yield* json(at(name), signal)
        if (!isRecord(style)) return yield* unreachable(`${at(name)} holds no style`)
        const urls = tilejsonOf(style)
        const described: Record<string, Json> = Object.fromEntries(
          yield* Effect.forEach(urls, (url) =>
            json(url, signal).pipe(Effect.map((tilejson) => [url, isRecord(tilejson) ? tilejson : {}] as const)),
          ),
        )
        const made = yield* Effect.try({
          try: () => online(provider, style, described, { schema, locale, credit }),
          catch: unreachable,
        })
        remember(made.upstream)
        return made.style
      })

    const remember = (found: Upstream) => {
      for (const [name, template] of Object.entries(found.tiles)) upstream.tiles.set(name, template)
      for (const [name, url] of Object.entries(found.sprites)) upstream.sprites.set(name, url)
    }

    /** Where an online style's name leads; a style of its provider is read first when none made since named it. */
    const resolve = (map: Map<string, string>, name: string, signal: AbortSignal) =>
      Effect.gen(function* () {
        const provider = name.split(".")[0]
        if (!map.has(name) && (provider === "openfreemap" || provider === "versatiles")) {
          yield* providerStyle(provider, PROVIDERS[provider].fallback, "en", signal)
        }
        const found = map.get(name)
        if (!found) return yield* invalid(`the basemap has nothing named ${name}`)
        return found
      })

    const current = Effect.gen(function* () {
      const state = yield* block.current
      return state.ok ? (state.value ?? { source: "offline" as const }) : { source: "offline" as const }
    })

    /** The style for the settings' basemap, or null when they choose none. */
    const getStyle: Engine.Method = (raw, context) =>
      Effect.gen(function* () {
        const params = Schema.decodeUnknownExit(StyleParams)(raw)
        if (Exit.isFailure(params)) return yield* invalid(params.cause)
        const theme: Theme = params.value.theme
        const locale: Locale = params.value.locale
        const chosen: Block = yield* current
        const missing = lacking(chosen)
        if (missing) return yield* new Engine.Failure({ code: "not-ready", message: missing })
        switch (chosen.source) {
          case "none":
            return { style: null }
          case "offline":
            if (!available) return yield* unavailable()
            return { style: offline(theme, locale) }
          case "openfreemap":
          case "versatiles": {
            const name = chosen[chosen.source] ?? PROVIDERS[chosen.source].fallback
            const shown = theme === "dark" ? darkOf[chosen.source](name) : name
            return { style: yield* providerStyle(chosen.source, shown, locale, context.signal) }
          }
          case "osm":
          case "tianditu":
          case "custom":
            return { style: rasterStyle(chosen) ?? null }
        }
      })

    const tile: Engine.Method = (raw, context) =>
      Effect.gen(function* () {
        const params = Schema.decodeUnknownExit(TileParams)(raw)
        if (Exit.isFailure(params)) return yield* invalid(params.cause)
        const { layer, z, x, y } = params.value
        if (x >= 2 ** z || y >= 2 ** z) return yield* invalid(`no tile ${z}/${x}/${y}`)
        const answer = (bytes: Download) => (bytes ? { bytes } : { empty: true })
        if (layer === "vector" || layer === "relief") {
          if (!available) return yield* unavailable()
          // Decompressed: the maps take the tile as it is drawn.
          const found = yield* Effect.tryPromise({
            try: () => archives[layer].getZxy(z, x, y, context.signal),
            catch: (error) => new Engine.Failure({ code: "read-failed", message: String(error) }),
          })
          return answer(found ? new Uint8Array(found.data) : null)
        }
        const chosen: Block = yield* current
        const found = onlineTile(chosen, layer, z, x, y)
        if (found && "refused" in found) return yield* invalid(found.refused)
        if (found) return answer(yield* download(found.url, context.signal, { tile: true, identity: found.identity }))
        const template = yield* resolve(upstream.tiles, layer, context.signal)
        return answer(yield* download(filled(template, z, x, y), context.signal, { tile: true }))
      })

    const sprite: Engine.Method = (raw, context) =>
      Effect.gen(function* () {
        const params = Schema.decodeUnknownExit(SpriteParams)(raw)
        if (Exit.isFailure(params)) return yield* invalid(params.cause)
        const { file } = params.value
        if (SPRITES.includes(file)) {
          if (!available) return yield* unavailable()
          const bytes = yield* Effect.tryPromise({
            try: () => fsp.readFile(path.join(folder, file)),
            catch: (error) => new Engine.Failure({ code: "read-failed", message: String(error) }),
          })
          return { bytes: new Uint8Array(bytes) }
        }
        const [, name = "", suffix = ""] = /^(.+?)((?:@2x)?\.(?:json|png))$/.exec(file) ?? []
        if (kindOf(name) !== (yield* current).source)
          return yield* invalid(`${file} is no part of the basemap the settings choose`)
        const base = yield* resolve(upstream.sprites, name, context.signal)
        const bytes = yield* download(`${base}${suffix}`, context.signal)
        if (!bytes) return yield* new Engine.Failure({ code: "missing", message: `the basemap has no ${file}` })
        return { bytes }
      })

    const configure: Engine.Method = (raw) =>
      Effect.gen(function* () {
        const params = Schema.decodeUnknownExit(Change)(raw)
        if (Exit.isFailure(params)) return yield* invalid(params.cause)
        // Refused before the write, whose own message would carry the file's location.
        const before = yield* block.current
        if (!before.ok) {
          return yield* new Engine.Failure({
            code: "config-unreadable",
            message: "machine.json cannot be read, so it is left as it is",
          })
        }
        const missing = lacking(merged(before.value, params.value))
        if (missing) return yield* invalid(missing)
        yield* block
          .update((written) => merged(written, params.value))
          .pipe(Effect.mapError((error) => new Engine.Failure({ code: "write-failed", message: error.message })))
        return {}
      })

    return { domain: DOMAIN, methods: { style: getStyle, tile, sprite, configure } }
  })
