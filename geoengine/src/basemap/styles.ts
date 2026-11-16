import DARK from "./dark.json" with { type: "json" }
import LIBERTY from "./liberty.json" with { type: "json" }

/**
 * What the styles point at, read through the module's `tile` and `sprite`: the maps that draw them fetch through this
 * scheme, which desktop/packages/ui/src/geocode/basemapClient.ts reads as BASEMAP_SCHEME and RESOURCE; change them
 * together. A tile is `tile/<layer>/{z}/{x}/{y}`, an icon file `sprite/<sprite>.json` and the like.
 */
export const SCHEME = "geocode-basemap"

/** A layer's or a sprite's name in the scheme; basemapClient.ts holds the same pattern, change both together. */
export const NAME = /^[a-z0-9][a-z0-9._-]*$/

export type Theme = "light" | "dark"
export type Locale = "en" | "zh-CN" | "zh-TW"

/**
 * The names a label shows in each interface language, the first one a place has; the local name last, as every
 * place has one. Road numbers and other labels that are no name keep the style's own text. By the tiles' schema:
 * VersaTiles' Shortbread names places in English and German alone.
 */
const NAMES = {
  openmaptiles: {
    en: ["name:en", "name:latin", "name"],
    "zh-CN": ["name:zh-Hans", "name:zh", "name"],
    "zh-TW": ["name:zh-Hant", "name:zh", "name"],
  },
  shortbread: { en: ["name_en", "name"], "zh-CN": ["name"], "zh-TW": ["name"] },
}

export type Schema = keyof typeof NAMES

export type Json = Record<string, unknown>

export const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** As text, whatever the map would read as markup: a credit the user writes is shown, not run. */
export const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

/** The style's layers with their place names in `locale`. */
const localized = (layers: unknown, schema: Schema, locale: Locale): unknown[] => {
  const text = ["coalesce", ...NAMES[schema][locale].map((key) => ["get", key])]
  return (Array.isArray(layers) ? layers : []).map((layer) => {
    if (!isRecord(layer) || !isRecord(layer.layout)) return layer
    const field = JSON.stringify(layer.layout["text-field"] ?? null)
    return /"\{?name/.test(field) ? { ...layer, layout: { ...layer.layout, "text-field": text } } : layer
  })
}

/** The offline basemap's credit, which the data's licence asks for. */
const OFFLINE_CREDIT = "© OpenMapTiles © OpenStreetMap contributors"

/** The offline basemap: OpenFreeMap's Liberty or Dark over the files the app holds, its names in `locale`. */
export const offline = (theme: Theme, locale: Locale) => {
  const base = theme === "dark" ? DARK : LIBERTY
  const { glyphs: _, ...rest } = base
  return {
    ...rest,
    // No glyphs: MapLibre draws the labels with the system's fonts, which cover every script the names are in.
    sprite: `${SCHEME}://sprite/ofm`,
    sources: {
      openmaptiles: {
        type: "vector",
        tiles: [`${SCHEME}://tile/vector/{z}/{x}/{y}`],
        maxzoom: 6,
        attribution: OFFLINE_CREDIT,
      },
      ne2_shaded: { ...base.sources.ne2_shaded, tiles: [`${SCHEME}://tile/relief/{z}/{x}/{y}`] },
    },
    layers: localized(base.layers, "openmaptiles", locale),
  }
}

/** Where the scheme's names lead online: a layer's tiles, as a template, and a sprite's files, less their suffix. */
export interface Upstream {
  readonly tiles: Readonly<Record<string, string>>
  readonly sprites: Readonly<Record<string, string>>
}

/** The addresses of the TileJSON that `style`'s sources name in place of their tiles. */
export const tilejsonOf = (style: Json): string[] =>
  Object.values(isRecord(style.sources) ? style.sources : {}).flatMap((source) =>
    isRecord(source) && typeof source.url === "string" ? [source.url] : [],
  )

/** A name of the scheme for what `provider` calls `name`. */
const named = (provider: string, name: string) => `${provider}.${name.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`

/**
 * A provider's own style as the maps draw it: its sources and icons named by the scheme, and what those names lead to;
 * no glyphs, projection or sky; its names in `locale`; one credit, `credit`, in place of the style's own. `tilejson` holds the TileJSON
 * of each source the style names by `url`.
 */
export const online = (
  provider: string,
  style: Json,
  tilejson: Readonly<Record<string, Json>>,
  options: { readonly schema: Schema; readonly locale: Locale; readonly credit: string },
): { style: Json; upstream: Upstream } => {
  const tiles: Record<string, string> = {}
  const sprites: Record<string, string> = {}
  const sources: Record<string, Json> = {}
  let credited = false
  for (const [id, raw] of Object.entries(isRecord(style.sources) ? style.sources : {})) {
    if (!isRecord(raw)) continue
    const { url, tiles: given, attribution: _, ...source } = raw
    const described = typeof url === "string" ? tilejson[url] : undefined
    const template = [described?.tiles, given]
      .map((list) => (Array.isArray(list) ? list[0] : undefined))
      .find((first) => typeof first === "string")
    if (typeof template !== "string") throw new Error(`${provider}'s source ${id} names no tiles`)
    const name = named(provider, id)
    tiles[name] = template
    const zooms = described ? { minzoom: described.minzoom ?? 0, maxzoom: described.maxzoom ?? 22 } : {}
    sources[id] = {
      ...zooms,
      ...source,
      tiles: [`${SCHEME}://tile/${name}/{z}/{x}/{y}`],
      ...(credited ? {} : { attribution: options.credit }),
    }
    credited = true
  }
  // Named by the id a list of sprites gives each, which is unique in the style, or by the end of a lone one's address.
  const spriteOf = (url: unknown, id: unknown) => {
    if (typeof url !== "string") throw new Error(`${provider}'s style names a sprite by no address`)
    const name = named(provider, typeof id === "string" ? id : (url.split("/").pop() ?? "sprite"))
    sprites[name] = url
    return `${SCHEME}://sprite/${name}`
  }
  const sprite = Array.isArray(style.sprite)
    ? style.sprite.map((entry) => (isRecord(entry) ? { ...entry, url: spriteOf(entry.url, entry.id) } : entry))
    : style.sprite === undefined
      ? undefined
      : spriteOf(style.sprite, undefined)
  // Nor a projection, nor the sky drawn around a globe: VersaTiles' styles draw the world as one, and the map's projection
  // is the page's to choose, kept as it is when the basemap changes under it.
  const { glyphs: _, projection: _projection, sky: _sky, ...rest } = style
  return {
    style: {
      ...rest,
      ...(sprite === undefined ? {} : { sprite }),
      sources,
      layers: localized(style.layers, options.schema, options.locale),
    },
    upstream: { tiles, sprites },
  }
}

/** A raster layer of a basemap drawn by its provider: the scheme's name for it and its deepest zoom. */
export interface Raster {
  readonly name: string
  readonly maxzoom: number
}

/**
 * A basemap of raster layers, drawn in order, the credit `credit` under the first, as text; none when it is empty.
 * Escaped here, where every credit passes: MapLibre shows one as markup, and the user writes a custom basemap's.
 */
export const raster = (layers: readonly Raster[], credit: string) => ({
  version: 8,
  sources: Object.fromEntries(
    layers.map((layer, index) => [
      layer.name,
      {
        type: "raster",
        tiles: [`${SCHEME}://tile/${layer.name}/{z}/{x}/{y}`],
        tileSize: 256,
        maxzoom: layer.maxzoom,
        ...(index === 0 && credit ? { attribution: escape(credit) } : {}),
      },
    ]),
  ),
  layers: layers.map((layer) => ({ id: layer.name, type: "raster", source: layer.name })),
})
