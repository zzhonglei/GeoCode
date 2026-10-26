import path from "node:path"

// Writes python/geocodekit/osm/_data.json, the community's tagging conventions geocodekit.osm works by (docs/OSM.md,
// section 2): the iD editor's presets, deprecated tags and fields as id-tagging-schema publishes them, in English, and
// when a closed way is an area, as osm-polygon-features publishes it. Run it after changing a version below, then
// commit what it wrote.
const SCHEMA = "7.3.0"
const POLYGONS = "0.9.2"

const schema = (file: string) => `https://cdn.jsdelivr.net/npm/@openstreetmap/id-tagging-schema@${SCHEMA}/dist/${file}`

const fetchJson = async (url: string) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json()
}

type Tags = Record<string, string>

interface Preset {
  readonly tags: Tags
  readonly addTags?: Tags
  readonly geometry: readonly string[]
  readonly fields?: readonly string[]
  readonly matchScore?: number
  readonly searchable?: boolean
  readonly locationSet?: { readonly include?: readonly string[] }
}

interface Field {
  readonly key?: string
  readonly keys?: readonly string[]
}

type Names = Record<string, { name?: string; terms?: string[] | string; aliases?: string[] | string }>

/** The English translations, of which only the presets' names, terms and aliases are read. */
interface English {
  readonly en: { readonly presets: { readonly presets: Names } }
}

const [presets, fields, deprecated, english, polygons] = (await Promise.all([
  fetchJson(schema("presets.min.json")),
  fetchJson(schema("fields.min.json")),
  fetchJson(schema("deprecated.min.json")),
  fetchJson(schema("translations/en.min.json")),
  fetchJson(`https://cdn.jsdelivr.net/npm/osm-polygon-features@${POLYGONS}/polygon-features.json`),
])) as [Record<string, Preset>, Record<string, Field>, unknown[], English, unknown[]]

const names: Names = english.en.presets.presets

const list = (value: string[] | string | undefined) =>
  (Array.isArray(value) ? value : (value ?? "").split(/[,\n]/)).map((item) => item.trim()).filter(Boolean)

// Templates only lend their fields to presets; a preset for some countries alone would be offered anywhere.
const kept = Object.entries(presets).filter(
  ([id, preset]) =>
    !id.startsWith("@") &&
    (preset.locationSet?.include ?? ["001"]).some((place) => place === "001" || place === "Planet"),
)

// A field names one key, or several, as an address does.
const keysOf = (field: Field | undefined) => field?.keys ?? (field?.key ? [field.key] : [])

const entries = kept.map(([id, preset]) => {
  const keys = [...new Set((preset.fields ?? []).flatMap((field) => keysOf(fields[field])))]
  return {
    id,
    name: names[id]?.name ?? id,
    terms: [...new Set([...list(names[id]?.terms), ...list(names[id]?.aliases)])],
    tags: preset.tags,
    ...(preset.addTags ? { addTags: preset.addTags } : {}),
    geometry: preset.geometry,
    keys: keys.filter((key) => key !== "name"),
    ...(preset.matchScore === undefined ? {} : { matchScore: preset.matchScore }),
    ...(preset.searchable === false ? { searchable: false } : {}),
  }
})

// One entry a line, so a new version's changes read in a diff.
const lines = (items: readonly unknown[]) => items.map((item) => JSON.stringify(item)).join(",\n")
const text = [
  "{",
  `"versions": ${JSON.stringify({ "id-tagging-schema": SCHEMA, "osm-polygon-features": POLYGONS })},`,
  `"presets": [\n${lines(entries)}\n],`,
  `"deprecated": [\n${lines(deprecated)}\n],`,
  `"polygons": [\n${lines(polygons)}\n]`,
  "}",
  "",
].join("\n")

const target = path.resolve(import.meta.dirname, "../python/geocodekit/osm/_data.json")
await Bun.write(target, text)
console.log(`wrote ${entries.length} presets to ${target}`)
