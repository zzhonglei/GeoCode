import assert from "node:assert/strict"
import { test } from "node:test"
import { Geodata } from "../src/qgis/geodata.ts"
import type { Reader } from "../src/qgis/reader.ts"

const WGS84: Reader.Crs = {
  name: "WGS 84",
  geographic: true,
  code: "EPSG:4326",
  proj: null,
  unit: "degree",
  metres: null,
  ellipsoid: [6378137, 298.257223563],
}

const vector = (fields: Partial<Reader.Vector>): Reader.Vector => ({
  driver: "ESRI Shapefile",
  layer: "county",
  layers: 1,
  kind: "vector",
  geometry: "MultiPolygon",
  shapefile: true,
  count: 3,
  crs: WGS84,
  extent: [73.498962, 3.832541, 135.087387, 53.558498],
  lonlat: null,
  encoding: null,
  offset: 1,
  limit: 3,
  groups: [],
  ...fields,
})

const raster = (fields: Partial<Reader.Raster>): Reader.Raster => ({
  driver: "GeoTIFF",
  layer: null,
  layers: 1,
  kind: "raster",
  width: 6857,
  height: 5537,
  crs: WGS84,
  georeferencing: "transform",
  transform: [73.49117339381806, 0.008983152841195215, 0, 53.56654039204707, 0, -0.008983152841195215],
  extent: [73.49117339381806, 3.82682311034916, 135.08865242589366, 53.56654039204707],
  lonlat: null,
  bands: [],
  ...fields,
})

const request = (path: string, fields: Partial<Geodata.Request> = {}): Geodata.Request => ({ path, ...fields })

// Guards against a wrong ellipsoid formula, which gives wrong distances without any error.
test("a raster in degrees gives its pixel size in metres too, narrowing east-west toward the poles", () => {
  const wide = Geodata.answer(raster({}), request("/data/dem.tif")).text
  assert.match(wide, /\b996 m\b.*\b998 m\b.*\b595 m\b/, wide)
  const small = Geodata.answer(
    raster({
      width: 5123,
      height: 5160,
      transform: [113.6965, 0.00026949458523585647, 0, 31.3624, 0, -0.00026949458523585647],
      extent: [113.6965, 29.9718, 115.0772, 31.3624],
    }),
    request("/data/wuhan.tif"),
  )
  assert.match(small.text, /\b30 m\b.*\b26 m\b/, small.text)
})

test("an answer too long for the kernel lists fewer values, then fewer fields, and still fits", () => {
  const values = Array.from({ length: 10 }, (_, index) => [`value ${"x".repeat(40)} ${index}`, 1] as const)
  const fields = (count: number): Reader.Field[] =>
    Array.from({ length: count }, (_, index) => ({
      name: `field_${index}`,
      type: "String",
      present: 3,
      distinct: 30,
      values: values.map(([value, times]) => [value, times]),
    }))
  const fits = (text: string) => Buffer.byteLength(text, "utf-8") <= 50 * 1024 && text.split("\n").length <= 2000
  const sample = (count: number): Reader.Sample => ({
    position: 1,
    attributes: Object.fromEntries(Array.from({ length: count }, (_, index) => [`field_${index}`, "x".repeat(30)])),
    geometry: null,
  })
  const wide = (count: number) =>
    Geodata.answer(
      vector({
        groups: [{ type: "all", count: 3, fields: fields(count), samples: [1, 2, 3].map(() => sample(count)) }],
      }),
      request("/data/wide.shp"),
    ).text
  const fewer = wide(100)
  assert.ok(fits(fewer))
  // Guards against dropping the field list to fit, when shorter value lists are enough.
  assert.ok(fewer.includes("- field_99 (String): 30 distinct values, most common"), fewer.slice(-500))
  const many = wide(5000)
  // Guards against a sample still showing every field, which no fewer fields would shorten.
  assert.ok(fits(many))
  assert.match(many, /\n… and \d+ more fields\n/)
})
