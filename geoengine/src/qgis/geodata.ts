export * as Geodata from "./geodata.ts"

import path from "node:path"
import type { Reader } from "./reader.ts"

/** The kernel cuts a tool's text past either; an answer is shortened to fit rather than cut. */
const BYTE_LIMIT = 50 * 1024
const LINE_LIMIT = 2000

/** How many common values a field or band lists, fewer as the answer grows. */
const TOPS = [10, 5, 3, 1, 0]

export interface Request {
  readonly path: string
  readonly encoding?: string
  readonly preview?: boolean
  readonly bands?: readonly number[]
}

export interface Answer {
  readonly text: string
  /** A PNG, base64. */
  readonly image?: string
}

type Report = Exclude<Reader.Report, { kind: "error" }>

export const answer = (report: Report, request: Request): Answer => {
  const file = path.basename(request.path)
  switch (report.kind) {
    case "missing":
      return { text: `There is no file or folder at ${request.path}.` }
    case "unopenable":
      return {
        text: report.directory
          ? `GDAL cannot open the folder ${request.path} as geographic data. A folder is read only when GDAL takes it as one dataset, as it does a File Geodatabase (.gdb).`
          : `GDAL cannot open ${request.path} as geographic data.${report.error ? ` GDAL says: ${report.error}` : ""}`,
      }
    case "layers":
      if (report.layers.length === 0) return { text: `${file}: ${report.driver}, with no layers.` }
      return {
        text: [
          `${file}: ${report.driver}, ${report.layers.length} layers`,
          ...report.layers.map(layerLine),
          `Read one with layer="<name>".`,
        ].join("\n"),
      }
    case "no-layer":
      return {
        text: [`${file} has no layer "${report.layer}". Its layers:`, ...report.layers.map(layerLine)].join("\n"),
      }
    case "not-geographic":
      return {
        text: `${file} has no georeferencing: no transform, control points, RPC coefficients, geolocation arrays or CRS. It is an image, not geographic data.`,
      }
    case "refused":
      return { text: refusal(report) }
    case "preview":
      return { text: previewText(report, file, request), image: report.png }
    case "vector":
    case "table": {
      const text = fitted((top, samples, fields) => vectorText(report, file, top, samples, fields))
      return { text: noted(text, unused(request, report.shapefile)) }
    }
    case "raster": {
      const text = fitted((top, _, fields) => rasterText(report, file, top, fields))
      return { text: noted(text, unused(request, false)) }
    }
  }
}

/** Parameters given that the read had no use for, so GeoAgent does not take them as applied. */
function unused(request: Request, shapefile: boolean) {
  const notes: string[] = []
  if (request.encoding !== undefined && !shapefile) notes.push("encoding was not used: it applies only to Shapefiles.")
  if (request.bands?.length && !request.preview) notes.push("bands was not used: it applies only with preview.")
  return notes
}

/** Notes go under the first line, which names what was read. */
function noted(text: string, notes: readonly string[]) {
  if (notes.length === 0) return text
  const [first, ...rest] = text.split("\n")
  return [first, ...notes, ...rest].join("\n")
}

/** The first rendering that fits: fewer common values, then fewer samples, then fewer fields or bands. */
function fitted(render: (top: number, samples: number, fields: number) => string) {
  const fits = (text: string) => Buffer.byteLength(text, "utf-8") <= BYTE_LIMIT && text.split("\n").length <= LINE_LIMIT
  for (const top of TOPS) {
    const text = render(top, Infinity, Infinity)
    if (fits(text)) return text
  }
  const sampled = render(0, 1, Infinity)
  if (fits(sampled)) return sampled
  let fields = 1000
  while (fields > 1 && !fits(render(0, 1, fields))) fields = Math.floor(fields / 2)
  return render(0, 1, fields)
}

function refusal(report: Extract<Report, { kind: "refused" }>) {
  if (report.reason === "encoding")
    return `GDAL does not know the encoding "${report.encoding}". Use a name such as GBK, Big5, CP1251, Shift_JIS or ISO-8859-1.`
  if (report.reason === "bands") {
    const count = report.count ?? 0
    return `This raster has ${plural(count, "band")}. bands takes one band number, or three for red, green and blue, each from 1 to ${count}.`
  }
  if (report.reason === "empty") {
    const bands = report.bands ?? []
    const at = report.size ? ` at ${report.size[0]} × ${report.size[1]}, the size of the preview` : ""
    return bands.length === 1
      ? `Band ${bands[0]} has no valid pixels${at}, so there is no picture.`
      : `No pixel is valid in all of bands ${bands.slice(0, -1).join(", ")} and ${bands.at(-1)}${at}, so there is no picture.`
  }
  return "Only rasters have a preview; this is vector data."
}

function header(report: { driver: string; layer: string | null; layers: number }, file: string, kind: string) {
  const layer = report.layers > 1 && report.layer !== null ? `, layer ${report.layer}` : ""
  return `${file}${layer}: ${kind}, ${report.driver}`
}

function layerLine(layer: Reader.Layer) {
  if (layer.kind === "table") return `- ${layer.name}: table without geometry, ${plural(layer.count, "row")}`
  if (layer.kind === "vector")
    return `- ${layer.name}: vector, ${layer.geometry ?? "mixed geometry"}, ${plural(layer.count, "feature")}, ${shortCrs(layer.crs)}`
  return `- ${layer.name}: raster, ${layer.width} × ${layer.height} pixels, ${plural(layer.bands, "band")}, ${shortCrs(layer.crs)}`
}

function shortCrs(crs: Reader.Crs) {
  if (!crs) return "no CRS"
  if (crs.code) return `${crs.code} (${crs.name})`
  return "a custom CRS without an EPSG code"
}

type Box = readonly [number, number, number, number]

/** Longitudes run to 360 in some global data; anything past these is not a longitude or latitude. */
const lonlatBounds = (box: Box) =>
  box.every((value) => Number.isFinite(value)) &&
  Math.abs(box[0]) <= 360 &&
  Math.abs(box[2]) <= 360 &&
  Math.abs(box[1]) <= 90 &&
  Math.abs(box[3]) <= 90

/** Whether the coordinates can be what the CRS says they are. */
const plausible = (crs: Reader.Crs, extent: Box | null) => !crs?.geographic || !extent || lonlatBounds(extent)

function crsLine(crs: Reader.Crs, extent: Box | null, driver: string) {
  if (!crs) return "CRS: none; the file does not say what its coordinates are."
  if (!plausible(crs, extent)) {
    return driver === "GeoJSON"
      ? "CRS: unknown. GeoJSON coordinates are longitudes and latitudes (EPSG:4326) by definition, but these are not."
      : `CRS: unknown. The file gives ${crs.code ?? "a geographic CRS"} (${crs.name}), but these coordinates are not longitudes and latitudes.`
  }
  const kind = crs.geographic ? "geographic" : "projected"
  const units = unitsOf(crs.unit)
  if (crs.code) return `CRS: ${crs.code} (${crs.name}), ${kind}${units ? `, ${units}` : ""}`
  return `CRS: a custom ${kind} CRS without an EPSG code${units ? `, ${units}` : ""}: ${crs.proj ?? crs.name}`
}

function unitsOf(unit: string | null) {
  if (!unit) return undefined
  const name = unit.toLowerCase()
  if (name === "degree") return "degrees"
  if (name === "metre" || name === "meter") return "metres"
  if (name.endsWith("foot")) return `${unit.slice(0, -4)}feet`
  return unit
}

function extentLines(crs: Reader.Crs, extent: Box | null, lonlat: Box | null) {
  if (!extent) return []
  const geographic = !!crs?.geographic && plausible(crs, extent)
  const lines = [`Extent: ${box(extent, geographic ? 6 : 2)} (xmin, ymin to xmax, ymax)`]
  if (lonlat && plausible(crs, extent)) lines.push(`In longitude and latitude: ${box(lonlat, 6)}`)
  return lines
}

function box(value: Box, digits: number) {
  return `${fixed(value[0], digits)}, ${fixed(value[1], digits)} to ${fixed(value[2], digits)}, ${fixed(value[3], digits)}`
}

const GROUP_TITLES = {
  point: "Points",
  line: "Lines",
  polygon: "Polygons",
  collection: "Geometry collections",
  none: "Without geometry",
  all: "",
} as const

const GROUP_COUNTS = {
  point: ["point", "points"],
  line: ["line", "lines"],
  polygon: ["polygon", "polygons"],
  collection: ["geometry collection", "geometry collections"],
  none: ["without geometry", "without geometry"],
  all: ["", ""],
} as const

function vectorText(
  report: Extract<Report, { kind: "vector" | "table" }>,
  file: string,
  top: number,
  samples: number,
  fields: number,
) {
  const table = report.kind === "table"
  const unit = table ? "row" : "feature"
  const mixed = report.groups.length > 1
  const lines = [header(report, file, table ? "table" : "vector")]
  if (table) lines.push(`Layer: ${report.layer}, table without geometry, ${plural(report.count, "row")}`)
  else if (mixed) {
    const parts = report.groups.map((group) => {
      const [one, many] = GROUP_COUNTS[group.type]
      return `${group.count} ${group.count === 1 ? one : many}`
    })
    lines.push(`Layer: ${report.layer}, mixed geometry, ${plural(report.count, "feature")}: ${parts.join(", ")}`)
  } else {
    lines.push(`Layer: ${report.layer}, ${report.geometry ?? "no geometry"}, ${plural(report.count, "feature")}`)
    if (report.shapefile && /^Multi(LineString|Polygon)/.test(report.geometry ?? ""))
      lines.push(
        "A shapefile does not record whether a feature has one part or several, so QGIS reads every feature as multipart.",
      )
  }
  if (!table) {
    lines.push(crsLine(report.crs, report.extent, report.driver))
    lines.push(...extentLines(report.crs, report.extent, report.lonlat))
  }
  if (report.encoding) lines.push(encodingLine(report.encoding))
  const measured = !!report.crs && !report.crs.geographic && plausible(report.crs, report.extent)
  const metres = measured ? (report.crs?.metres ?? undefined) : undefined
  for (const group of report.groups) {
    lines.push("")
    const shown = group.fields.filter((field) => !mixed || field.present > 0)
    const listed = shown.slice(0, fields)
    if (mixed) lines.push(`${GROUP_TITLES[group.type]} (${plural(group.count, unit)}):`)
    else lines.push(`Fields (of ${plural(group.count, unit)}):`)
    if (shown.length === 0) lines.push(table || !mixed ? "No fields." : "No field has a value.")
    lines.push(...listed.map((field) => fieldLine(field, group.count, top)))
    if (listed.length < shown.length) lines.push(`… and ${shown.length - listed.length} more fields`)
    const kept = group.samples.slice(0, samples)
    if (kept.length === 0) {
      if (group.count > 0 && report.offset > group.count)
        lines.push(`Offset ${report.offset} is past the last of the ${plural(group.count, unit)}.`)
      continue
    }
    const first = kept[0]!.position
    const last = kept.at(-1)!.position
    const title = table ? "Row" : "Feature"
    lines.push(
      first === last ? `${title} ${first} of ${group.count}:` : `${title}s ${first}–${last} of ${group.count}:`,
    )
    // A sample shows the fields listed, so fewer fields shorten every part of the answer.
    const names = new Set(listed.map((field) => field.name))
    for (const sample of kept) {
      const values = Object.entries(sample.attributes).filter(([name]) => names.has(name))
      const attributes = values.length ? JSON.stringify(Object.fromEntries(values)) : "no attribute values"
      lines.push(`${sample.position}. ${attributes}`)
      if (!table) lines.push(`   ${geometryText(sample.geometry, metres)}`)
    }
  }
  const more = report.groups.some((group) => {
    const kept = group.samples.slice(0, samples)
    return kept.length > 0 && kept.at(-1)!.position < group.count
  })
  if (more) {
    const next = report.offset + Math.min(samples, report.limit)
    lines.push("")
    lines.push(
      mixed
        ? `Read more with offset=${next}; it counts the features of each geometry type separately.`
        : `Read more with offset=${next}.`,
    )
  }
  return lines.join("\n")
}

function encodingLine(encoding: NonNullable<Reader.Vector["encoding"]>) {
  switch (encoding.source) {
    case "cpg":
      return `Encoding: ${encoding.name}, from the .cpg file`
    case "ldid":
      return `Encoding: ${encoding.name}, from the code page in the .dbf file`
    case "utf-8":
      return "Encoding: UTF-8; the file declares none, and its text is valid UTF-8"
    case "given":
      return `Encoding: ${encoding.name}, as requested`
    case "detected": {
      const declared = encoding.cpg
        ? `the .cpg file says ${encoding.cpg}, but the text is not valid UTF-8`
        : "the file declares none"
      return encoding.weak
        ? `Encoding: ${encoding.name}, detected from little text; ${declared}. Check that the sample text reads correctly; if it does not, read again with encoding set.`
        : `Encoding: ${encoding.name}, detected; ${declared}. If the text looks garbled, read again with encoding set.`
    }
  }
}

function fieldLine(field: Reader.Field, count: number, top: number) {
  const parts: string[] = []
  const partial = field.present < count
  if (field.present === 0) return `- ${field.name} (${field.type}): no values`
  const single =
    field.distinct === 1
      ? field.values?.[0]?.[0]
      : field.min !== undefined && field.min === field.max
        ? field.min
        : undefined
  if (single !== undefined) {
    const which = !partial
      ? "one value: "
      : field.present === 1
        ? "1 with a value: "
        : `${field.present} with a value, all `
    return `- ${field.name} (${field.type}): ${which}${valueText(single)}`
  }
  if (field.values) {
    const distinct = field.distinct ?? field.values.length
    const listed = field.values
      .slice(0, top)
      .map(([value, times]) => `${valueText(value)} ×${times}`)
      .join(", ")
    if (distinct === field.present) parts.push(`${partial ? `${field.present} with a value, ` : ""}every value unique`)
    else if (distinct <= top) parts.push(`${partial ? `${field.present} with a value: ` : ""}${listed}`)
    else
      parts.push(
        `${partial ? `${field.present} with a value, ` : ""}${distinct} distinct values${top > 0 ? `, most common ${listed}, …` : ""}`,
      )
  } else if (field.mean !== undefined) {
    if (partial) parts.push(`${field.present} with a value`)
    parts.push(`min ${valueText(field.min)}, max ${valueText(field.max)}, mean ${numeric(field.mean)}`)
  } else if (field.min !== undefined) {
    if (partial) parts.push(`${field.present} with a value`)
    parts.push(`from ${valueText(field.min)} to ${valueText(field.max)}`)
  } else if (field.distinct === null) {
    parts.push(`${partial ? `${field.present} with a value, ` : ""}more than 100000 distinct values`)
  } else {
    parts.push(`${partial ? `${field.present} with a value, ` : ""}not counted`)
  }
  return `- ${field.name} (${field.type}): ${parts.join("; ")}`
}

function valueText(value: unknown): string {
  if (typeof value === "number") return number(value)
  if (typeof value === "string") return JSON.stringify(value)
  return String(value)
}

/** A number the reader could not send as one: NaN or an infinity, spelled as it is. */
function numeric(value: number | string) {
  return typeof value === "number" ? number(value) : value
}

function geometryText(geometry: Reader.Sample["geometry"], metres: number | undefined) {
  if (!geometry) return "no geometry"
  if (geometry.point) return `${geometry.type} at ${coordinate(geometry.point[0])}, ${coordinate(geometry.point[1])}`
  const where = geometry.bbox
    ? ` within ${coordinate(geometry.bbox[0])}, ${coordinate(geometry.bbox[1])} to ${coordinate(geometry.bbox[2])}, ${coordinate(geometry.bbox[3])}`
    : ""
  // Measured only in a CRS whose units are lengths: an area in square degrees means nothing.
  const size =
    metres === undefined
      ? ""
      : geometry.area !== undefined
        ? `, area ${area(geometry.area * metres * metres)}`
        : geometry.length !== undefined
          ? `, length ${length(geometry.length * metres)}`
          : ""
  return `${geometry.type}${where}${size}`
}

function area(squareMetres: number) {
  return squareMetres >= 1e6 ? `${fixed(squareMetres / 1e6, 2)} km²` : `${fixed(squareMetres, 1)} m²`
}

function length(metres: number) {
  return metres >= 1000 ? `${fixed(metres / 1000, 3)} km` : `${fixed(metres, 1)} m`
}

const GEOREFERENCING = {
  gcp: "ground control points, without a regular grid in a CRS",
  rpc: "RPC coefficients, a sensor model, without a regular grid in a CRS",
  geolocation: "geolocation arrays, without a regular grid in a CRS",
  "crs-only": "a CRS, but nothing that places its pixels",
} as const

function rasterText(report: Reader.Raster, file: string, top: number, bands: number) {
  const lines = [
    header(report, file, "raster"),
    `Size: ${report.width} × ${report.height} pixels, ${plural(report.bands.length, "band")}`,
    crsLine(report.crs, report.extent, report.driver),
  ]
  if (report.georeferencing !== "transform") {
    lines.push(`Georeferencing: ${GEOREFERENCING[report.georeferencing]}; so no extent or pixel size.`)
  } else if (report.transform && report.extent) {
    lines.push(pixelSize(report.crs, report.transform, report.extent))
    lines.push(...extentLines(report.crs, report.extent, report.lonlat))
  }
  lines.push("", "Bands:")
  const listed = report.bands.slice(0, bands)
  lines.push(...listed.map((band) => bandLine(band, top)))
  if (listed.length < report.bands.length) lines.push(`… and ${report.bands.length - listed.length} more bands`)
  return lines.join("\n")
}

function pixelSize(crs: Reader.Crs, transform: readonly number[], extent: Box) {
  const x = Math.hypot(transform[1]!, transform[4]!)
  const y = Math.hypot(transform[2]!, transform[5]!)
  const rotated = transform[2] !== 0 || transform[4] !== 0 ? "; the grid is rotated" : ""
  const sizes = Math.abs(x - y) <= x * 1e-9 ? significant(x) : `${significant(x)} × ${significant(y)}`
  if (!crs || !plausible(crs, extent)) return `Pixel size: ${sizes}${rotated}`
  if (!crs.geographic) return `Pixel size: ${sizes} ${unitsOf(crs.unit) ?? ""}`.trimEnd() + rotated
  // A degree of longitude shrinks toward the poles; a degree of latitude barely changes.
  const [a, inverse] = crs.ellipsoid
  const flattening = inverse ? 1 / inverse : 0
  const e2 = flattening * (2 - flattening)
  const radians = (degrees: number) => (degrees * Math.PI) / 180
  const north = (lat: number) => (Math.PI / 180) * ((a * (1 - e2)) / (1 - e2 * Math.sin(radians(lat)) ** 2) ** 1.5)
  const east = (lat: number) =>
    (Math.PI / 180) * ((a * Math.cos(radians(lat))) / Math.sqrt(1 - e2 * Math.sin(radians(lat)) ** 2))
  const middle = (extent[1] + extent[3]) / 2
  const across = [extent[1], extent[3]].map((lat) => east(lat) * x)
  const narrow = Math.min(...across)
  const wide = Math.max(...across)
  const eastWest =
    wide > narrow * 1.1
      ? `east–west ${metresText(across[0]!)} m at ${fixed(extent[1], 1)}° to ${metresText(across[1]!)} m at ${fixed(extent[3], 1)}° latitude`
      : `${metresText(east(middle) * x)} m east–west`
  return `Pixel size: ${sizes}° (about ${metresText(north(middle) * y)} m north–south, ${eastWest})${rotated}`
}

function metresText(metres: number) {
  return metres < 10 ? fixed(metres, 1) : String(Math.round(metres))
}

function bandLine(band: Reader.Band, top: number) {
  const traits = [band.name ? `${band.name} (${band.type})` : band.type]
  if (band.nodata !== null) traits.push(`no data ${numeric(band.nodata)}`)
  if (band.unit) traits.push(`unit ${band.unit}`)
  if (band.scale !== null) traits.push(`scale ${number(band.scale)}`)
  if (band.offset !== null) traits.push(`offset ${number(band.offset)}`)
  if (band.valid !== undefined && band.valid !== null && band.valid < 1)
    traits.push(`${fixed(band.valid * 100, 1)}% valid`)
  return `${band.index}. ${traits.join(", ")}: ${bandValues(band, top)}`
}

function bandValues(band: Reader.Band, top: number) {
  if (!band.stats) return "no valid pixels"
  if (band.categories) {
    const total = band.categories.reduce((sum, [, count]) => sum + count, 0)
    const listed = band.categories.slice(0, top).map(([value, count]) => {
      const name = band.names[String(value)]
      const share = (count / total) * 100
      return `${value}${name ? ` ${JSON.stringify(name)}` : ""} ×${count} (${share < 0.05 ? "<0.1" : fixed(share, 1)}%)`
    })
    const rest = band.categories.length > top ? (top > 0 ? ", …" : "") : ""
    return `${plural(band.categories.length, "value")}${listed.length ? `: ${listed.join(", ")}${rest}` : ""}`
  }
  const stats = band.stats
  return `min ${numeric(stats.min)}, max ${numeric(stats.max)}, mean ${numeric(stats.mean)}, std dev ${numeric(stats.std)}`
}

function previewText(report: Reader.Preview, file: string, request: Request) {
  const named = (band: { index: number; name: string | null }) => `${band.index}${band.name ? ` (${band.name})` : ""}`
  const lines = [header(report, file, "raster preview")]
  if (report.mode === "rgb") {
    lines.push(
      `Bands ${report.bands.map(named).join(", ")} as red, green and blue, each stretched between its 2nd and 98th percentiles.`,
    )
  } else if (report.mode === "gray") {
    const [low, high] = report.ranges[0] ?? [0, 0]
    lines.push(
      `Band ${named(report.bands[0]!)} in grey, from ${number(low)} as black to ${number(high)} as white, its 2nd and 98th percentiles.`,
    )
  } else {
    const legend = (report.legend ?? []).map(([value, colour]) => `${value} ${colour}`).join(", ")
    lines.push(`Band ${named(report.bands[0]!)}, one colour per value: ${legend}.`)
  }
  lines.push(
    `Shown at ${report.width} × ${report.height} of its ${report.original[0]} × ${report.original[1]} pixels; no data is transparent.`,
  )
  if (report.count > 1 && !request.bands?.length)
    lines.push("To show other bands, set bands to one band number, or three for red, green and blue.")
  return lines.join("\n")
}

function plural(count: number, word: string) {
  return `${count} ${count === 1 ? word : `${word}s`}`
}

function coordinate(value: number) {
  return fixed(value, Math.abs(value) > 1000 ? 2 : 6)
}

/** Statistics: whole numbers as they are, two decimals from 100 up, four significant digits below. */
function number(value: number) {
  if (!Number.isFinite(value)) return String(value)
  if (Number.isInteger(value)) return String(value)
  if (Math.abs(value) >= 100) return fixed(value, 2)
  return String(Number(value.toPrecision(4)))
}

function significant(value: number) {
  return String(Number(value.toPrecision(6)))
}

function fixed(value: number, digits: number) {
  return String(Number(value.toFixed(digits)))
}
