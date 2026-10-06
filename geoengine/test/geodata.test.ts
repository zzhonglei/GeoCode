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

const UTM49: Reader.Crs = {
  name: "WGS 84 / UTM zone 49N",
  geographic: false,
  code: "EPSG:32649",
  proj: null,
  unit: "metre",
  metres: 1,
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

const band = (fields: Partial<Reader.Band> & { index: number }): Reader.Band => ({
  name: null,
  type: "Float32",
  nodata: null,
  unit: null,
  scale: null,
  offset: null,
  colors: false,
  names: {},
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

test("a shapefile is described with its CRS, its encoding, each field's values and a page of features", () => {
  const answer = Geodata.answer(
    vector({
      encoding: { name: "GB18030", source: "detected" },
      groups: [
        {
          type: "all",
          count: 3,
          fields: [
            {
              name: "name",
              type: "String",
              present: 3,
              distinct: 3,
              values: [
                ["鄂城区", 1],
                ["龙里县", 1],
                ["华容区", 1],
              ],
            },
            { name: "level", type: "String", present: 3, distinct: 1, values: [["county", 3]] },
            { name: "kind", type: "String", present: 2, distinct: 1, values: [["区", 2]] },
            { name: "pop", type: "Integer64", present: 3, min: 120000, max: 980000, mean: 456666.6666 },
            {
              name: "rank",
              type: "Integer",
              present: 3,
              distinct: 2,
              values: [
                [1, 2],
                [3, 1],
              ],
            },
            { name: "built", type: "Date", present: 3, min: "1950-01-01", max: "2001-12-31" },
            { name: "tags", type: "StringList", present: 1 },
            { name: "note", type: "String", present: 0 },
          ],
          samples: [
            {
              position: 1,
              attributes: { name: "鄂城区", level: "county" },
              geometry: { type: "Polygon", bbox: [114.652412, 30.206043, 115.084628, 30.445591], area: 0.0578 },
            },
          ],
        },
      ],
      limit: 1,
    }),
    request("/data/county.shp"),
  )
  assert.equal(
    answer.text,
    [
      "county.shp: vector, ESRI Shapefile",
      "Layer: county, MultiPolygon, 3 features",
      "A shapefile does not record whether a feature has one part or several, so QGIS reads every feature as multipart.",
      "CRS: EPSG:4326 (WGS 84), geographic, degrees",
      "Extent: 73.498962, 3.832541 to 135.087387, 53.558498 (xmin, ymin to xmax, ymax)",
      "Encoding: GB18030, detected; the file declares none. If the text looks garbled, read again with encoding set.",
      "",
      "Fields (of 3 features):",
      "- name (String): every value unique",
      '- level (String): one value: "county"',
      '- kind (String): 2 with a value, all "区"',
      "- pop (Integer64): min 120000, max 980000, mean 456666.67",
      "- rank (Integer): 1 ×2, 3 ×1",
      '- built (Date): from "1950-01-01" to "2001-12-31"',
      "- tags (StringList): 1 with a value, not counted",
      "- note (String): no values",
      "Feature 1 of 3:",
      '1. {"name":"鄂城区","level":"county"}',
      // Guards against an area in square degrees, which reads as a measurement and means nothing.
      "   Polygon within 114.652412, 30.206043 to 115.084628, 30.445591",
      "",
      "Read more with offset=2.",
    ].join("\n"),
  )
})

test("a layer of mixed geometry is described type by type, each with only its own fields", () => {
  const answer = Geodata.answer(
    vector({
      driver: "GeoJSON",
      layer: "mixed",
      geometry: null,
      shapefile: false,
      count: 5,
      groups: [
        {
          type: "point",
          count: 2,
          fields: [
            {
              name: "name",
              type: "String",
              present: 2,
              distinct: 2,
              values: [
                ["黄鹤楼", 1],
                ["武汉大学", 1],
              ],
            },
            { name: "lanes", type: "Integer", present: 0 },
          ],
          samples: [
            { position: 1, attributes: { name: "黄鹤楼" }, geometry: { type: "Point", point: [114.3, 30.59] } },
          ],
        },
        {
          type: "line",
          count: 1,
          fields: [
            { name: "name", type: "String", present: 1, distinct: 1, values: [["长江大桥", 1]] },
            { name: "lanes", type: "Integer", present: 1, distinct: 1, values: [[4, 1]] },
          ],
          samples: [
            {
              position: 1,
              attributes: { name: "长江大桥", lanes: 4 },
              geometry: { type: "LineString", bbox: [114.25, 30.55, 114.35, 30.62], length: 0.12 },
            },
          ],
        },
        {
          type: "none",
          count: 2,
          fields: [
            { name: "name", type: "String", present: 0 },
            { name: "lanes", type: "Integer", present: 0 },
          ],
          samples: [{ position: 1, attributes: {}, geometry: null }],
        },
      ],
      limit: 1,
    }),
    request("/data/mixed.geojson"),
  )
  assert.equal(
    answer.text,
    [
      "mixed.geojson: vector, GeoJSON",
      "Layer: mixed, mixed geometry, 5 features: 2 points, 1 line, 2 without geometry",
      "CRS: EPSG:4326 (WGS 84), geographic, degrees",
      "Extent: 73.498962, 3.832541 to 135.087387, 53.558498 (xmin, ymin to xmax, ymax)",
      "",
      "Points (2 features):",
      "- name (String): every value unique",
      "Feature 1 of 2:",
      '1. {"name":"黄鹤楼"}',
      "   Point at 114.3, 30.59",
      "",
      "Lines (1 feature):",
      '- name (String): one value: "长江大桥"',
      "- lanes (Integer): one value: 4",
      "Feature 1 of 1:",
      '1. {"name":"长江大桥","lanes":4}',
      "   LineString within 114.25, 30.55 to 114.35, 30.62",
      "",
      "Without geometry (2 features):",
      "No field has a value.",
      "Feature 1 of 2:",
      "1. no attribute values",
      "   no geometry",
      "",
      "Read more with offset=2; it counts the features of each geometry type separately.",
    ].join("\n"),
  )
})

test("coordinates that cannot be longitudes and latitudes leave the CRS unknown and the features unmeasured", () => {
  const extent = [-621020.02, 3034725.7, 589384.11, 3952391.88] as const
  const sample: Reader.Sample = {
    position: 1,
    attributes: { name: "四川省" },
    geometry: { type: "MultiPolygon", bbox: [-621020.02, 3034725.7, 429427.85, 3952391.88], area: 485197870145 },
  }
  const group: Reader.Group = { type: "all", count: 1, fields: [], samples: [sample] }
  const geojson = Geodata.answer(
    vector({ driver: "GeoJSON", shapefile: false, count: 1, extent, groups: [group] }),
    request("/data/chuanyu.geojson"),
  ).text
  assert.ok(
    geojson.includes(
      "\nCRS: unknown. GeoJSON coordinates are longitudes and latitudes (EPSG:4326) by definition, but these are not.\n",
    ),
    geojson,
  )
  assert.ok(geojson.includes("\n   MultiPolygon within -621020.02, 3034725.7 to 429427.85, 3952391.88"), geojson)
  assert.ok(!geojson.includes("area"))
  const shapefile = Geodata.answer(vector({ count: 1, extent, groups: [group] }), request("/data/chuanyu.shp")).text
  assert.ok(
    shapefile.includes(
      "\nCRS: unknown. The file gives EPSG:4326 (WGS 84), but these coordinates are not longitudes and latitudes.\n",
    ),
  )
})

test("a projected layer is measured in its units, with its extent in longitude and latitude", () => {
  const answer = Geodata.answer(
    vector({
      driver: "GeoPackage",
      layer: "buffer",
      layers: 2,
      shapefile: false,
      geometry: "MultiPolygon",
      count: 1,
      crs: UTM49,
      extent: [-346547.4841, 3126310.1928, 137117.5086, 3579095.2005],
      lonlat: [105.289, 28.16, 110.19, 32.2],
      groups: [
        {
          type: "all",
          count: 1,
          fields: [{ name: "name", type: "String", present: 1, distinct: 1, values: [["重庆市", 1]] }],
          samples: [
            {
              position: 1,
              attributes: { name: "重庆市" },
              geometry: {
                type: "MultiPolygon",
                bbox: [-346547.48, 3126310.19, 137117.5, 3579095.2],
                area: 84549400304.99,
              },
            },
          ],
        },
      ],
    }),
    request("/data/chongqing.gpkg"),
  )
  assert.equal(
    answer.text,
    [
      "chongqing.gpkg, layer buffer: vector, GeoPackage",
      "Layer: buffer, MultiPolygon, 1 feature",
      "CRS: EPSG:32649 (WGS 84 / UTM zone 49N), projected, metres",
      "Extent: -346547.48, 3126310.19 to 137117.51, 3579095.2 (xmin, ymin to xmax, ymax)",
      "In longitude and latitude: 105.289, 28.16 to 110.19, 32.2",
      "",
      "Fields (of 1 feature):",
      '- name (String): one value: "重庆市"',
      "Feature 1 of 1:",
      '1. {"name":"重庆市"}',
      "   MultiPolygon within -346547.48, 3126310.19 to 137117.5, 3579095.2, area 84549.4 km²",
    ].join("\n"),
  )
})

test("each way a shapefile's encoding is known is said, and a weak detection asks for a check", () => {
  const line = (encoding: NonNullable<Reader.Vector["encoding"]>) =>
    Geodata.answer(vector({ encoding }), request("/data/a.shp")).text.split("\n")[5]
  assert.equal(line({ name: "UTF-8", source: "cpg" }), "Encoding: UTF-8, from the .cpg file")
  assert.equal(line({ name: "CP936", source: "ldid" }), "Encoding: CP936, from the code page in the .dbf file")
  assert.equal(
    line({ name: "UTF-8", source: "utf-8" }),
    "Encoding: UTF-8; the file declares none, and its text is valid UTF-8",
  )
  assert.equal(line({ name: "CP1251", source: "given" }), "Encoding: CP1251, as requested")
  assert.equal(
    line({ name: "CP950", source: "detected", weak: true }),
    "Encoding: CP950, detected from little text; the file declares none. Check that the sample text reads correctly; if it does not, read again with encoding set.",
  )
  assert.equal(
    line({ name: "GB18030", source: "detected", weak: false, cpg: "UTF-8" }),
    "Encoding: GB18030, detected; the .cpg file says UTF-8, but the text is not valid UTF-8. If the text looks garbled, read again with encoding set.",
  )
})

test("a raster in degrees gives its pixel size in metres too, narrowing east-west toward the poles", () => {
  const answer = Geodata.answer(
    raster({
      bands: [
        band({
          index: 1,
          name: "elevation",
          type: "Int16",
          nodata: -32768,
          valid: 0.3149,
          stats: { min: -157, max: 8364, mean: 1790.0833, std: 1716.5202 },
        }),
        band({ index: 2, nodata: "-Infinity", valid: 1, stats: { min: 0.0043, max: 0.98, mean: 0.3252, std: 0.1933 } }),
        band({ index: 3, valid: 0 }),
      ],
    }),
    request("/data/dem.tif"),
  )
  assert.equal(
    answer.text,
    [
      "dem.tif: raster, GeoTIFF",
      "Size: 6857 × 5537 pixels, 3 bands",
      "CRS: EPSG:4326 (WGS 84), geographic, degrees",
      "Pixel size: 0.00898315° (about 996 m north–south, east–west 998 m at 3.8° to 595 m at 53.6° latitude)",
      "Extent: 73.491173, 3.826823 to 135.088652, 53.56654 (xmin, ymin to xmax, ymax)",
      "",
      "Bands:",
      "1. elevation (Int16), no data -32768, 31.5% valid: min -157, max 8364, mean 1790.08, std dev 1716.52",
      "2. Float32, no data -Infinity: min 0.0043, max 0.98, mean 0.3252, std dev 0.1933",
      "3. Float32, 0% valid: no valid pixels",
    ].join("\n"),
  )
  const small = Geodata.answer(
    raster({
      width: 5123,
      height: 5160,
      transform: [113.6965, 0.00026949458523585647, 0, 31.3624, 0, -0.00026949458523585647],
      extent: [113.6965, 29.9718, 115.0772, 31.3624],
    }),
    request("/data/wuhan.tif"),
  )
  assert.ok(small.text.includes("\nPixel size: 0.000269495° (about 30 m north–south, 26 m east–west)\n"), small.text)
})

test("a categorical band lists each value's share, with its name when the file gives one", () => {
  const answer = Geodata.answer(
    raster({
      crs: UTM49,
      transform: [812730, 30, 0, 3393360, 0, -30],
      extent: [812730, 3378840, 828510, 3393360],
      lonlat: [114.258126, 30.496984, 114.426886, 30.632008],
      bands: [
        band({
          index: 1,
          name: "landcover",
          type: "Byte",
          nodata: 0,
          names: { "1": "Trees", "6": "Built" },
          valid: 0.321,
          stats: { min: 1, max: 8, mean: 3.5, std: 2.17 },
          categories: [
            [1, 3078761],
            [6, 2908099],
            [8, 447],
          ],
        }),
      ],
    }),
    request("/data/landcover.tif"),
  )
  assert.equal(
    answer.text,
    [
      "landcover.tif: raster, GeoTIFF",
      "Size: 6857 × 5537 pixels, 1 band",
      "CRS: EPSG:32649 (WGS 84 / UTM zone 49N), projected, metres",
      "Pixel size: 30 metres",
      "Extent: 812730, 3378840 to 828510, 3393360 (xmin, ymin to xmax, ymax)",
      "In longitude and latitude: 114.258126, 30.496984 to 114.426886, 30.632008",
      "",
      "Bands:",
      '1. landcover (Byte), no data 0, 32.1% valid: 3 values: 1 "Trees" ×3078761 (51.4%), 6 "Built" ×2908099 (48.6%), 8 ×447 (<0.1%)',
    ].join("\n"),
  )
})

test("a raster placed by other means than a grid has no extent or pixel size, and says why", () => {
  const answer = Geodata.answer(
    raster({ georeferencing: "gcp", transform: null, extent: null, bands: [] }),
    request("/data/scene.tif"),
  )
  assert.equal(
    answer.text.split("\n")[3],
    "Georeferencing: ground control points, without a regular grid in a CRS; so no extent or pixel size.",
  )
})

test("a preview says which bands it shows, how it stretched them, and how to choose others", () => {
  const preview = (fields: Partial<Reader.Preview>): Reader.Preview => ({
    driver: "GeoTIFF",
    layer: null,
    layers: 1,
    kind: "preview",
    width: 1958,
    height: 2000,
    original: [7531, 7691],
    count: 12,
    bands: [{ index: 1, name: "B1" }],
    mode: "gray",
    ranges: [[9135, 11683]],
    legend: null,
    png: "iVBORw0KGgo=",
    ...fields,
  })
  const grey = Geodata.answer(preview({}), request("/data/stack.tif"))
  assert.equal(grey.image, "iVBORw0KGgo=")
  assert.equal(
    grey.text,
    [
      "stack.tif: raster preview, GeoTIFF",
      "Band 1 (B1) in grey, from 9135 as black to 11683 as white, its 2nd and 98th percentiles.",
      "Shown at 1958 × 2000 of its 7531 × 7691 pixels; no data is transparent.",
      "To show other bands, set bands to one band number, or three for red, green and blue.",
    ].join("\n"),
  )
  const colour = Geodata.answer(
    preview({
      mode: "rgb",
      bands: [
        { index: 4, name: "B4" },
        { index: 3, name: "B3" },
        { index: 2, name: null },
      ],
    }),
    request("/data/stack.tif", { bands: [4, 3, 2] }),
  )
  assert.equal(
    colour.text.split("\n").slice(1).join("\n"),
    [
      "Bands 4 (B4), 3 (B3), 2 as red, green and blue, each stretched between its 2nd and 98th percentiles.",
      "Shown at 1958 × 2000 of its 7531 × 7691 pixels; no data is transparent.",
    ].join("\n"),
  )
  const categories = Geodata.answer(
    preview({
      mode: "categories",
      count: 1,
      ranges: [],
      legend: [
        [1, "red"],
        [2, "rgb(0, 128, 0)"],
      ],
    }),
    request("/data/landcover.tif"),
  )
  assert.equal(categories.text.split("\n")[1], "Band 1 (B1), one colour per value: 1 red, 2 rgb(0, 128, 0).")
})

test("a file of several layers lists them to choose from, and a wrong name lists them again", () => {
  const layers: Reader.Layer[] = [
    { name: "county", kind: "vector", count: 2891, geometry: "MultiPolygon", crs: WGS84 },
    { name: "places", kind: "vector", count: 9, geometry: null, crs: null },
    { name: "population", kind: "table", count: 1 },
    { name: "landsat", kind: "raster", width: 526, height: 484, bands: 3, crs: UTM49 },
    { name: "lcc", kind: "raster", width: 10, height: 10, bands: 1, crs: { ...UTM49, code: null } },
  ]
  const lines = [
    "- county: vector, MultiPolygon, 2891 features, EPSG:4326 (WGS 84)",
    "- places: vector, mixed geometry, 9 features, no CRS",
    "- population: table without geometry, 1 row",
    "- landsat: raster, 526 × 484 pixels, 3 bands, EPSG:32649 (WGS 84 / UTM zone 49N)",
    "- lcc: raster, 10 × 10 pixels, 1 band, a custom CRS without an EPSG code",
  ]
  assert.equal(
    Geodata.answer({ kind: "layers", driver: "GeoPackage", layers }, request("/data/multi.gpkg")).text,
    ["multi.gpkg: GeoPackage, 5 layers", ...lines, 'Read one with layer="<name>".'].join("\n"),
  )
  assert.equal(
    Geodata.answer({ kind: "no-layer", driver: "GeoPackage", layer: "roads", layers }, request("/data/multi.gpkg"))
      .text,
    ['multi.gpkg has no layer "roads". Its layers:', ...lines].join("\n"),
  )
  assert.equal(
    Geodata.answer({ kind: "layers", driver: "GeoPackage", layers: [] }, request("/data/empty.gpkg")).text,
    "empty.gpkg: GeoPackage, with no layers.",
  )
})

test("what cannot be read is answered with what to do instead", () => {
  const text = (report: Parameters<typeof Geodata.answer>[0], path = "/data/x.tif") =>
    Geodata.answer(report, request(path)).text
  assert.equal(text({ kind: "missing" }), "There is no file or folder at /data/x.tif.")
  assert.equal(
    text({ kind: "unopenable", directory: false, error: "not recognized as being in a supported file format." }),
    "GDAL cannot open /data/x.tif as geographic data. GDAL says: not recognized as being in a supported file format.",
  )
  assert.equal(
    text({ kind: "unopenable", directory: true, error: "" }, "/data/maps"),
    "GDAL cannot open the folder /data/maps as geographic data. A folder is read only when GDAL takes it as one dataset, as it does a File Geodatabase (.gdb).",
  )
  assert.equal(
    text({ kind: "not-geographic", driver: "PNG", layer: null, layers: 1 }, "/data/photo.png"),
    "photo.png has no georeferencing: no transform, control points, RPC coefficients, geolocation arrays or CRS. It is an image, not geographic data.",
  )
  assert.equal(
    text({ kind: "refused", reason: "encoding", encoding: "NOPE" }),
    'GDAL does not know the encoding "NOPE". Use a name such as GBK, Big5, CP1251, Shift_JIS or ISO-8859-1.',
  )
  assert.equal(
    text({ kind: "refused", reason: "bands", count: 1 }),
    "This raster has 1 band. bands takes one band number, or three for red, green and blue, each from 1 to 1.",
  )
  assert.equal(text({ kind: "refused", reason: "preview-vector" }), "Only rasters have a preview; this is vector data.")
  // Guards against a picture with nothing in it, which GeoAgent would take for the data.
  assert.equal(
    text({ kind: "refused", reason: "empty", bands: [1], size: null }),
    "Band 1 has no valid pixels, so there is no picture.",
  )
  assert.equal(
    text({ kind: "refused", reason: "empty", bands: [4, 3, 2], size: [2000, 1500] }),
    "No pixel is valid in all of bands 4, 3 and 2 at 2000 × 1500, the size of the preview, so there is no picture.",
  )
})

test("a parameter the read had no use for is said, so GeoAgent does not take it as applied", () => {
  const note = (fields: Partial<Geodata.Request>, report: Parameters<typeof Geodata.answer>[0]) =>
    Geodata.answer(report, request("/data/x", fields)).text.split("\n").slice(0, 3)
  assert.deepEqual(note({ encoding: "GBK", bands: [1] }, vector({ driver: "GeoJSON", shapefile: false })), [
    "x: vector, GeoJSON",
    "encoding was not used: it applies only to Shapefiles.",
    "bands was not used: it applies only with preview.",
  ])
  assert.deepEqual(note({ encoding: "GBK" }, vector({})).slice(0, 2), [
    "x: vector, ESRI Shapefile",
    "Layer: county, MultiPolygon, 3 features",
  ])
  assert.equal(note({ bands: [1] }, raster({}))[1], "bands was not used: it applies only with preview.")
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
