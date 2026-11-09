export * as Plan from "./plan.ts"

import fsp from "node:fs/promises"
import path from "node:path"
import { Catalog } from "./catalog.ts"
import { Doc } from "./doc.ts"
import type { Reader } from "./reader.ts"

/** The types of the parameters whose value may name a file QGIS reads. */
const INPUT_TYPES = new Set(["source", "vector", "raster", "layer", "multilayer", "file", "mesh"])

/** The input types QGIS opens as one vector layer, typed by its first feature. */
const LAYER_TYPES = new Set(["source", "vector", "layer", "multilayer"])

/** Values that name no file: QGIS's temporary output and GDAL's virtual paths. QGIS matches them by case. */
const NOT_FILES = ["TEMPORARY_OUTPUT", "/vsi"]

/**
 * A data source, which QGIS reads from the text before a colon, such as "postgis:" or "memory:", as GDAL does with
 * "PG:"; a URL is one too. Only an "ogr:" connection names a file.
 */
const SOURCE = /^[^|]{2,}?:/

/** Outputs gone when the run ends: QGIS's memory layers and GDAL's in-memory files. */
const LOST = ["memory:", "/vsimem/"]

/** What names the database a connection writes to, for an output that is no file. */
const DATABASE_KEYS = ["service", "host", "port", "dbname"]

/** The output types QGIS writes as vector files. */
const VECTOR_OUTPUTS = new Set(["sink", "vectorDestination"])

/** A value in a QGIS connection string: quoted, where a backslash escapes the next character, or bare. */
const VALUE = String.raw`(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([^\s'"]+))`

const DBNAME = new RegExp(String.raw`(?<=^ogr:|\s)dbname=${VALUE}`, "d")

const TABLE = new RegExp(String.raw`(?<=^ogr:|\s)table=${VALUE}`, "d")

/** The files of a Shapefile: any one of them left behind makes the name taken. */
const SHAPEFILE = [".shp", ".shx", ".dbf", ".prj", ".cpg", ".qix", ".sbn", ".sbx", ".fix", ".qmd", ".shp.xml"]

/** An example file for an output written nowhere, by the output's type. */
const EXAMPLES: Readonly<Record<string, string>> = {
  sink: "result.gpkg",
  vectorDestination: "result.gpkg",
  rasterDestination: "result.tif",
}

const KINDS = {
  point: ["points", "|geometrytype=MultiPoint"],
  line: ["lines", "|geometrytype=MultiLineString"],
  polygon: ["polygons", "|geometrytype=MultiPolygon"],
  collection: ["geometry collections", "|geometrytype=GeometryCollection"],
} as const

export type Kind = keyof typeof KINDS

export interface Request {
  readonly algorithm: string
  readonly parameters: Readonly<Record<string, unknown>>
}

/** A file named in a parameter's value; the text around it is QGIS's and is kept as it is. */
export interface Slot {
  readonly parameter: Catalog.Parameter
  /** Its position in a list of values; undefined for a value of its own. */
  readonly index: number | undefined
  /** The value as GeoAgent wrote it. */
  readonly value: string
  readonly before: string
  readonly file: string
  readonly after: string
  /** The quote around the file in an `ogr:` connection, inside which it is escaped. */
  readonly quote?: "'" | '"'
}

export type Located =
  | { readonly kind: "refused"; readonly text: string }
  | { readonly kind: "located"; readonly algorithm: Catalog.Algorithm; readonly slots: readonly Slot[] }

/** The algorithm and the files its parameters name, or why it is not run; needs only the catalog. */
export const locate = (catalog: Catalog.Catalog, request: Request): Located => {
  const algorithm = catalog.algorithms.find((candidate) => candidate.id === request.algorithm)
  if (!algorithm) return { kind: "refused", text: header(catalog, undefined, [absent(catalog, request.algorithm)]) }
  const reasons = [...unknown(algorithm, request.parameters), ...temporary(algorithm, request.parameters)]
  if (reasons.length) return { kind: "refused", text: header(catalog, algorithm, reasons) }
  return { kind: "located", algorithm, slots: slots(algorithm, request.parameters, catalog.vectorExtensions) }
}

/** The parameters with each file replaced by its resolution, in the order `locate` found them. */
export const substitute = (
  parameters: Readonly<Record<string, unknown>>,
  found: readonly Slot[],
  files: readonly string[],
) => {
  const next: Record<string, unknown> = { ...parameters }
  const placed = found.map((slot, index) => ({ ...slot, file: files[index]! }))
  for (const slot of placed) put(next, slot)
  return { parameters: next, slots: placed }
}

/** What the data must be asked before a run: the layers whose geometry is not declared, the GeoPackages added to. */
export const survey = (found: readonly Slot[]) => {
  const layers = found.filter(surveyed)
  const tables = found.filter((slot) => slot.parameter.destination && slot.before.startsWith("ogr:"))
  return {
    layers,
    tables,
    request: {
      layers: layers.map((slot) => {
        const options = optionsOf(slot.after)
        const name = options.get("layername")
        const id = Number(options.get("layerid"))
        return name !== undefined
          ? { path: slot.file, name }
          : Number.isInteger(id)
            ? { path: slot.file, id }
            : { path: slot.file }
      }),
      tables: tables.map((slot) => slot.file),
    },
  }
}

/** Why a run is refused for its layers that mix kinds of geometry; empty when none do. */
export const mixed = (layers: readonly Slot[], kinds: Reader.Inspection["layers"]) =>
  layers.flatMap((slot, index) => {
    const found = new Set(kinds[index] ?? [])
    if (found.size < 2) return []
    const named = Object.entries(KINDS).flatMap(([kind, words]) => (found.has(kind as Kind) ? [words] : []))
    return [
      `${slot.value} mixes ${both(named.map(([word]) => word))} in one layer, so nothing was run: QGIS would treat every feature as the geometry type of the first one.\n` +
        `Take one kind by adding ${either(named.map(([, option]) => option))} to the path, and run once for each kind you need. Features without geometry are left out.`,
    ]
  })

/** The values given for coordinate reference systems, which QGIS must be asked whether it reads. */
export const coordinateSystems = (algorithm: Catalog.Algorithm, parameters: Readonly<Record<string, unknown>>) =>
  algorithm.parameters.flatMap((parameter) => {
    const value = parameters[parameter.name]
    return parameter.type === "crs" && value !== null && value !== undefined && value !== ""
      ? [{ parameter, value }]
      : []
  })

/** Why a run is refused for the values QGIS does not read as a CRS, with what QGIS says it accepts; empty if none. */
export const unread = (given: ReturnType<typeof coordinateSystems>, read: readonly boolean[]) =>
  given.flatMap(({ parameter, value }, index) => {
    if (read[index] !== false) return []
    const shown = typeof value === "string" ? `"${value}"` : JSON.stringify(value)
    const accepted = parameter.accepted.length
      ? `\nQGIS accepts:\n${parameter.accepted.map((form) => `- ${form}`).join("\n")}`
      : ""
    return [
      `${parameter.name} is ${shown}, which QGIS does not read as a coordinate reference system, so nothing was run: QGIS would run as if it were not given.${accepted}`,
    ]
  })

/** A refusal: the facts of the run, then why nothing was run. */
export const refusal = (catalog: Catalog.Catalog, algorithm: Catalog.Algorithm, reasons: readonly string[]) =>
  header(catalog, algorithm, reasons)

export interface Numbered {
  readonly slots: readonly Slot[]
  /** The names taken, to hold until the run ends. */
  readonly claimed: readonly string[]
}

/**
 * Moves each output that would overwrite something, file, table or a folder holding files, to the first free name:
 * `_1`, `_2` and on. Compared without case.
 */
export const number = async (
  found: readonly Slot[],
  tables: ReadonlyMap<string, readonly string[] | null>,
  reserved: ReadonlySet<string>,
): Promise<Numbered> => {
  const taken = new Set(reserved)
  const slots: Slot[] = []
  for (const slot of found) {
    if (slot.parameter.type === "folderDestination") {
      // An algorithm writes its own names into it, over the files of an earlier run; an empty folder is used as it is.
      let chosen = slot.file
      for (let count = 1; await filled(chosen, taken); count++) chosen = sibling(slot.file, count)
      taken.add(chosen.toLowerCase())
      slots.push({ ...slot, file: chosen })
      continue
    }
    if (!renamable(slot)) {
      slots.push(slot)
      continue
    }
    if (slot.before.startsWith("ogr:")) {
      const table = tableOf(slot)
      const existing = new Set((tables.get(slot.file) ?? []).map((name) => name.toLowerCase()))
      const free = (name: string) => !existing.has(name.toLowerCase()) && !taken.has(tableKey(slot.file, name))
      let chosen = table.name
      for (let count = 1; !free(chosen); count++) chosen = `${table.name}_${count}`
      taken.add(tableKey(slot.file, chosen))
      slots.push(chosen === table.name ? slot : table.renamed(chosen))
      continue
    }
    let chosen = slot.file
    for (let count = 1; await occupied(chosen, taken); count++) chosen = sibling(slot.file, count)
    taken.add(chosen.toLowerCase())
    slots.push({ ...slot, file: chosen })
  }
  return { slots, claimed: claims(slots) }
}

/** The names a run's outputs hold while it runs: their files and folders, or the tables they add to a GeoPackage. */
export const claims = (found: readonly Slot[]) =>
  found.flatMap((slot) => {
    if (slot.parameter.type === "folderDestination") return [slot.file.toLowerCase()]
    if (!renamable(slot)) return []
    if (!slot.before.startsWith("ogr:")) return [slot.file.toLowerCase()]
    return [tableKey(slot.file, tableOf(slot).name)]
  })

export interface Entry {
  readonly name: string
  readonly value: unknown
}

export interface Output extends Entry {
  /** The files or the folder written, absolute; none for an output that is no file, such as a database. */
  readonly files: readonly string[]
  readonly folder: boolean
  /** Where an output that is no file writes: the database its connection names, or else its value. */
  readonly place?: string
}

/** What the kernel asks the user about and runs, and the first lines of the answer. */
export interface Plan {
  readonly header: string
  /** The lines of the header after the algorithm's, which the interface shows. */
  readonly notes: readonly string[]
  readonly parameters: Readonly<Record<string, unknown>>
  readonly algorithm: {
    readonly id: string
    readonly name: string
    readonly description: string
    readonly translations: NonNullable<Catalog.Algorithm["translations"]>
  }
  readonly inputs: readonly Entry[]
  readonly outputs: readonly Output[]
  readonly options: readonly Entry[]
}

export const plan = (
  catalog: Catalog.Catalog,
  algorithm: Catalog.Algorithm,
  request: Request,
  numbered: Numbered,
): Plan => {
  const parameters: Record<string, unknown> = { ...request.parameters }
  for (const slot of numbered.slots) put(parameters, slot)
  const fallback = defaults(algorithm, request.parameters)
  const notes = fallback ? [fallback] : []
  const given = algorithm.parameters.filter((parameter) => parameter.name in parameters)
  return {
    header: header(catalog, algorithm, [], notes),
    notes,
    parameters,
    algorithm: {
      id: algorithm.id,
      name: algorithm.name,
      description: algorithm.description,
      translations: algorithm.translations ?? {},
    },
    inputs: given
      .filter((parameter) => !parameter.destination && INPUT_TYPES.has(parameter.type))
      .map((parameter) => ({ name: parameter.name, value: parameters[parameter.name] })),
    outputs: given
      .filter((parameter) => parameter.destination)
      .map((parameter) => {
        const value = parameters[parameter.name]
        const files = numbered.slots.filter((slot) => slot.parameter === parameter).map((slot) => slot.file)
        return {
          name: parameter.name,
          value,
          files,
          folder: parameter.type === "folderDestination",
          ...(typeof value === "string" && value && !files.length ? { place: placeOf(value) } : {}),
        }
      }),
    options: given
      .filter((parameter) => !parameter.destination && !INPUT_TYPES.has(parameter.type))
      .map((parameter) => ({ name: parameter.name, value: parameters[parameter.name] })),
  }
}

/**
 * Makes the output folders that are not there, and the folders output files go into: some algorithms, as gdal:retile,
 * fail on a missing output folder, as a numbered one is, and QGIS makes none for a file it writes.
 */
export const folders = (found: readonly Slot[]) =>
  Promise.all(
    found
      .filter((slot) => slot.parameter.destination)
      .map((slot) => (slot.parameter.type === "folderDestination" ? slot.file : path.dirname(slot.file)))
      // One that cannot be made, the algorithm reports.
      .map((folder) => fsp.mkdir(folder, { recursive: true }).catch(() => {})),
  )

/** Which of the files and output folders a run's outputs write, and what those folders hold, are there already. */
export const present = async (found: readonly Slot[]) => {
  const paths = [...outputFiles(found).flatMap(made), ...outputFolders(found)]
  const there = await Promise.all(paths.map(exists))
  const held = await Promise.all(outputFolders(found).map(entries))
  return new Set([...paths.filter((_, index) => there[index]), ...held.flat()])
}

/**
 * Removes what a run that did not finish made, which may be half written: its output files, output folders and what it
 * put in an output folder that was there, each that was not there before it. Returns the outputs still there, which
 * may be incomplete, among them every GeoPackage it added a table to: a table cannot be taken out of one, and one the
 * run made may hold the table another run added meanwhile.
 */
export const discard = async (found: readonly Slot[], before: ReadonlySet<string>) => {
  const files = outputFiles(found)
  const folders = outputFolders(found)
  const tables = databases(found)
  // One that cannot be removed is reported as still there.
  await Promise.all([
    ...files
      .flatMap(made)
      .filter((file) => !before.has(file))
      .map(remove),
    ...folders.map(async (folder) =>
      before.has(folder)
        ? Promise.all((await entries(folder)).filter((entry) => !before.has(entry)).map(remove))
        : remove(folder),
    ),
  ])
  const left = await Promise.all([
    ...files.map(async (file) => ((await exists(file)) ? [file] : [])),
    // A folder there before is reported for what the run left in it; one it made, for anything in it.
    ...folders.map(async (folder) => ((await entries(folder)).some((entry) => !before.has(entry)) ? [folder] : [])),
    ...tables.map(async (slot) => ((await exists(slot.file)) ? [`${slot.file} (table ${tableOf(slot).name})`] : [])),
  ])
  return [...new Set(left.flat())]
}

/** The end of a run's answer. */
export const finished = (ms: number, outputs: Readonly<Record<string, unknown>>) => {
  const entries = Object.entries(outputs)
  const listed = entries.map(
    ([name, value]) => `- ${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  )
  return [`Finished in ${seconds(ms)}.`, ...(listed.length ? ["Outputs:", ...listed] : [])].join("\n")
}

/** A failure says what the parameters QGIS names in its errors are. */
export const failed = (ms: number, algorithm: Catalog.Algorithm, names: ReadonlySet<string>, left: readonly string[]) =>
  [
    `Failed after ${seconds(ms)}.`,
    ...algorithm.parameters.filter((p) => names.has(p.name)).map(describe),
    ...incomplete(left),
  ].join("\n")

/** The parameters an error of QGIS's names, by whole word. */
export const named = (algorithm: Catalog.Algorithm, error: string) =>
  algorithm.parameters
    .filter((parameter) => new RegExp(`\\b${parameter.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(error))
    .map((parameter) => parameter.name)

export const crashed = (ms: number, left: readonly string[]) =>
  [`QGIS exited unexpectedly after ${seconds(ms)}.`, ...incomplete(left)].join("\n")

/**
 * Whole seconds, or tenths below one, as the kernel writes the durations of its own answers
 * (kernel/packages/core/src/geocode/answer.ts) and the interface shows them (desktop/packages/ui/src/geocode/runLines.ts).
 */
const seconds = (ms: number) =>
  ms < 1000 ? `${Math.max(1, Math.round(ms / 100)) / 10} s` : `${Math.round(ms / 1000)} s`

function incomplete(left: readonly string[]) {
  return left.length ? ["These outputs may be incomplete:", ...left.map((file) => `- ${file}`)] : []
}

function header(
  catalog: Catalog.Catalog,
  algorithm: Catalog.Algorithm | undefined,
  reasons: readonly string[],
  notes: readonly string[] = [],
) {
  const facts = [`QGIS ${catalog.qgis}`, ...(algorithm ? [Doc.line(algorithm)] : []), ...notes].join("\n")
  return [facts, ...reasons].join("\n\n")
}

/** An algorithm that is not offered, or not there, with the IDs it may have meant. */
function absent(catalog: Catalog.Catalog, id: string) {
  const resolution = Catalog.resolve(catalog, id)
  if (resolution.kind === "excluded") return `${resolution.id} is not available.`
  const similar = Catalog.similar(catalog, id)
  const listed = similar.length
    ? `\nSimilar IDs:\n${similar.map((algorithm) => Doc.line(algorithm, true)).join("\n")}`
    : ""
  return `There is no algorithm "${id}".${listed}\nFind algorithms with qgisdoc (action "search").`
}

/** QGIS ignores a parameter it does not know and runs on the default instead. */
function unknown(algorithm: Catalog.Algorithm, parameters: Readonly<Record<string, unknown>>) {
  const names = algorithm.parameters.map((parameter) => parameter.name)
  const wrong = Object.keys(parameters).filter((name) => !names.includes(name))
  if (!wrong.length) return []
  const lines = [`${algorithm.id} has no parameter ${either(wrong)}, so nothing was run.`]
  for (const name of wrong) {
    const meant = names.find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    if (meant) lines.push(`${name} is written ${meant}.`)
  }
  lines.push(names.length ? `Its parameters are ${names.join(", ")}.` : "It has no parameters.")
  return [lines.join("\n")]
}

/** A vector written to memory is gone with the run; a raster is left in the system's temporary folder. */
function temporary(algorithm: Catalog.Algorithm, parameters: Readonly<Record<string, unknown>>) {
  return algorithm.parameters.flatMap((parameter) => {
    const value = parameters[parameter.name]
    if (!parameter.destination || typeof value !== "string") return []
    if (value !== "TEMPORARY_OUTPUT" && !LOST.some((prefix) => value.startsWith(prefix))) return []
    const example = EXAMPLES[parameter.type]
    const instead =
      parameter.type === "folderDestination"
        ? "Write it to a folder."
        : example
          ? `Write it to a file, such as "${example}".`
          : "Write it to a file."
    return [`${parameter.name} is ${value}, which is lost when the run ends, so nothing was run. ${instead}`]
  })
}

/** By the type of each parameter, never its name: a field named "build.geojson" is a field. */
function slots(
  algorithm: Catalog.Algorithm,
  parameters: Readonly<Record<string, unknown>>,
  extensions: readonly string[],
): Slot[] {
  return algorithm.parameters.flatMap((parameter) => {
    if (!parameter.destination && !INPUT_TYPES.has(parameter.type)) return []
    const value = parameters[parameter.name]
    const values: (readonly [unknown, number | undefined])[] = Array.isArray(value)
      ? value.map((item, index) => [item, index] as const)
      : [[value, undefined]]
    return values.flatMap(([item, index]) => {
      const parts = typeof item === "string" ? split(item) : undefined
      if (!parts) return []
      // Named as QGIS will name it, so the name checked is the name written.
      const unknown =
        VECTOR_OUTPUTS.has(parameter.type) &&
        parts.before === "" &&
        !extensions.some((extension) => parts.file.toLowerCase().endsWith(`.${extension.toLowerCase()}`))
      return [{ parameter, index, value: item as string, ...parts, ...(unknown ? { file: `${parts.file}.gpkg` } : {}) }]
    })
  })
}

/**
 * Where an output that is no file writes, by which "always allow" goes: a connection by the database it names, so
 * that its tables are one place; anything else by its value.
 */
function placeOf(value: string) {
  const source = SOURCE.exec(value)
  if (!source) return value
  const connection = value.slice(source[0].length)
  const named = DATABASE_KEYS.flatMap((key) => {
    const found = captured(new RegExp(String.raw`(?<=^|\s)${key}=${VALUE}`, "d"), connection)
    return found ? [`${key}=${found.value}`] : []
  })
  const provider = source[0].slice(0, -1).toLowerCase()
  // QGIS takes "postgis:" for "postgres:", and GDAL's "PG:" is the same database.
  const kind = provider === "postgis" || provider === "pg" ? "postgres" : provider
  return named.length ? `${kind}: ${named.join(" ")}` : value
}

/** The file in a value: before QGIS's `|` options, or the `dbname` of an `ogr:` connection. */
function split(value: string) {
  if (!value || NOT_FILES.some((prefix) => value.startsWith(prefix))) return undefined
  if (value.startsWith("ogr:")) {
    const found = captured(DBNAME, value)
    if (!found) return undefined
    // Unquoted, a resolved path with a space in it would end at the space: it goes back quoted.
    const quote: Slot["quote"] = found.group === 2 ? '"' : "'"
    const added = found.group === 3 ? quote : ""
    return {
      before: value.slice(0, found.start) + added,
      file: found.value,
      after: added + value.slice(found.end),
      quote,
    }
  }
  if (SOURCE.test(value)) return undefined
  const bar = value.indexOf("|")
  const file = bar < 0 ? value : value.slice(0, bar)
  return file ? { before: "", file, after: bar < 0 ? "" : value.slice(bar) } : undefined
}

function put(parameters: Record<string, unknown>, slot: Slot) {
  const text = slot.before + (slot.quote ? escaped(slot.file, slot.quote) : slot.file) + slot.after
  const name = slot.parameter.name
  if (slot.index === undefined) {
    parameters[name] = text
    return
  }
  const list = [...(parameters[name] as unknown[])]
  list[slot.index] = text
  parameters[name] = list
}

/** A vector input QGIS takes whole, with no geometry type chosen after the path. */
function surveyed(slot: Slot) {
  return (
    !slot.parameter.destination &&
    LAYER_TYPES.has(slot.parameter.type) &&
    slot.before === "" &&
    !optionsOf(slot.after).has("geometrytype")
  )
}

/** QGIS's options after a path, such as `|layername=roads`, by lower-case key. */
function optionsOf(after: string) {
  return new Map(
    after
      .split("|")
      .slice(1)
      .map((pair) => {
        const at = pair.indexOf("=")
        return at < 0
          ? ([pair.toLowerCase(), ""] as const)
          : ([pair.slice(0, at).toLowerCase(), pair.slice(at + 1)] as const)
      }),
  )
}

/** The files a run's outputs write: not folders, nor GeoPackages it adds a table to. */
function outputFiles(found: readonly Slot[]) {
  return found.filter((slot) => renamable(slot) && !slot.before.startsWith("ogr:")).map((slot) => slot.file)
}

function outputFolders(found: readonly Slot[]) {
  return found.filter((slot) => slot.parameter.type === "folderDestination").map((slot) => slot.file)
}

/** The outputs that add a table to a GeoPackage, through an `ogr:` connection. */
function databases(found: readonly Slot[]) {
  return found.filter((slot) => renamable(slot) && slot.before.startsWith("ogr:"))
}

function remove(target: string) {
  return fsp.rm(target, { recursive: true, force: true }).catch(() => {})
}

/** What a folder holds, as paths; none when it is not there. */
function entries(folder: string) {
  return fsp.readdir(folder).then(
    (names) => names.map((name) => path.join(folder, name)),
    () => [] as string[],
  )
}

/** What writing a file makes: a Shapefile's parts, or the file with the journals SQLite keeps beside it. */
function made(file: string) {
  if (!file.toLowerCase().endsWith(".shp")) return [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]
  const stem = file.slice(0, -".shp".length)
  return SHAPEFILE.map((extension) => stem + extension)
}

function exists(file: string) {
  return fsp.stat(file).then(
    () => true,
    () => false,
  )
}

/** An output written to a file of its own, which a folder is not. */
function renamable(slot: Slot) {
  return slot.parameter.destination && slot.parameter.type !== "folderDestination"
}

function tableKey(file: string, table: string) {
  return `${file.toLowerCase()}|${table.toLowerCase()}`
}

/**
 * The table an `ogr:` connection adds, named before the file or after it, or else the one QGIS names after the file;
 * with the slot that adds it under another name.
 */
function tableOf(slot: Slot) {
  for (const part of ["before", "after"] as const) {
    const found = captured(TABLE, slot[part])
    if (!found) continue
    const quote = found.group === 2 ? '"' : "'"
    const text = slot[part]
    return {
      name: found.value,
      renamed: (name: string): Slot => ({
        ...slot,
        [part]: text.slice(0, found.start) + (found.group === 3 ? name : escaped(name, quote)) + text.slice(found.end),
      }),
    }
  }
  return {
    name: path.parse(slot.file).name,
    // Right after the quote that ends the file.
    renamed: (name: string): Slot => ({
      ...slot,
      after: `${slot.after.slice(0, 1)} table="${escaped(name, '"')}"${slot.after.slice(1)}`,
    }),
  }
}

/**
 * The first group a pattern of `VALUE`'s alternatives captured, its value with the escapes read, and where it sits;
 * by its own offsets, never by searching.
 */
function captured(pattern: RegExp, text: string) {
  const match = pattern.exec(text)
  const group = match ? [1, 2, 3].find((index) => match[index] !== undefined) : undefined
  const at = group === undefined ? undefined : match?.indices?.[group]
  if (group === undefined || !at) return undefined
  const raw = match![group]!
  return { group, value: group === 3 ? raw : raw.replace(/\\(.)/g, "$1"), start: at[0], end: at[1] }
}

/** Text for inside a quoted value, as QGIS reads it back. */
function escaped(text: string, quote: "'" | '"') {
  return text.replace(/\\/g, "\\\\").replaceAll(quote, `\\${quote}`)
}

/** Taken by a file there, or by a checked run writing it or adding a table to it. */
async function occupied(file: string, taken: ReadonlySet<string>) {
  const key = file.toLowerCase()
  if (taken.has(key) || [...taken].some((name) => name.startsWith(`${key}|`))) return true
  const names = new Set(
    (await fsp.readdir(path.dirname(file)).catch(() => [] as string[])).map((name) => name.toLowerCase()),
  )
  const base = path.basename(file).toLowerCase()
  if (!base.endsWith(".shp")) return names.has(base)
  const stem = base.slice(0, -".shp".length)
  return SHAPEFILE.some((extension) => names.has(stem + extension))
}

async function filled(folder: string, taken: ReadonlySet<string>) {
  if (taken.has(folder.toLowerCase())) return true
  return fsp.readdir(folder).then(
    (names) => names.length > 0,
    () => false,
  )
}

function sibling(file: string, count: number) {
  const extension = path.extname(file)
  return path.join(path.dirname(file), `${path.basename(file, extension)}_${count}${extension}`)
}

function defaults(algorithm: Catalog.Algorithm, parameters: Readonly<Record<string, unknown>>) {
  const used = algorithm.parameters.flatMap((parameter) => {
    if (parameter.destination || parameter.name in parameters) return []
    const text = shown(parameter, parameter.default)
    return text === undefined ? [] : [`${parameter.name}=${text}`]
  })
  return used.length ? `Defaults used: ${used.join(", ")}` : undefined
}

/** A value as QGIS takes it, with the option an enum's number stands for. */
function shown(parameter: Catalog.Parameter, value: unknown) {
  if (value === null || value === undefined || value === "") return undefined
  if (Array.isArray(value) && value.length === 0) return undefined
  const option = (item: unknown) =>
    parameter.options && !parameter.static && typeof item === "number" ? parameter.options[item] : undefined
  if (typeof value === "number") {
    const label = option(value)
    return label === undefined ? String(value) : `${value} (${label})`
  }
  if (typeof value === "string" || typeof value === "boolean") return String(value)
  if (Array.isArray(value) && value.every((item) => option(item) !== undefined)) {
    return `${value.join(",")} (${value.map(option).join(", ")})`
  }
  return JSON.stringify(value)
}

function describe(parameter: Catalog.Parameter) {
  const fallback = shown(parameter, parameter.default)
  return `${parameter.name}: ${parameter.description} (${parameter.type}${fallback === undefined ? "" : `, default ${fallback}`})`
}

function either(words: readonly string[]) {
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`
}

function both(words: readonly string[]) {
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`
}
