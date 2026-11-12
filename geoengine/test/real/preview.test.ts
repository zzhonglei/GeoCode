import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { Bundled } from "../../src/bundled.ts"
import { Preview } from "../../src/preview/index.ts"
import { Environment } from "../../src/python/index.ts"
import { SOURCE, alive } from "../support/common.ts"
import { pythonReady, start } from "../support/engine.ts"
import { MAKE, PIXELS, area, layers, plane, unit } from "../support/preview.ts"

/**
 * Reads datasets with the base environment GeoCode installed in the data directory GEOENGINE_DATA names, as
 * scripts/test.mjs hands it over: its GDAL, shapely and pyproj are what the reader stands on. The reader is this
 * source's, not the one installed there.
 */
const data = process.env.GEOENGINE_DATA
const base = data ? Environment.layout(data).basePython : ""
const missing = !data
  ? "run through scripts/test.mjs, which hands over GeoCode's data directory"
  : fs.existsSync(base)
    ? false
    : `start GeoCode once, to install its base environment in ${data}`

/** Without bytecode: the package's own folder is not the tests' to write in. */
const fromSource: Preview.Launch = (python) =>
  Bundled.python(python, [
    "-B",
    "-c",
    `import sys; sys.path.insert(0, ${JSON.stringify(SOURCE)}); from geocodekit.preview import _serve; _serve.main()`,
  ])

/** The tile every dataset lies in. */
const TILE = { z: 10, x: 512, y: 511 }
const at = (longitude: number, latitude: number) => unit(longitude, latitude, TILE.z, TILE.x, TILE.y)
const exactly = (longitude: number, latitude: number) => unit(longitude, latitude, TILE.z, TILE.x, TILE.y, true)

let folder = ""
let pyramids = ""
let listed: string[] = []
let engine: Awaited<ReturnType<typeof start>>

before(async () => {
  if (missing) return
  folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "geoengine-preview-")))
  pyramids = fs.mkdtempSync(path.join(os.tmpdir(), "geoengine-pyramids-"))
  execFileSync(base, ["-I", "-B", "-c", MAKE, folder])
  fs.writeFileSync(path.join(folder, "notes.gpkg"), "not a dataset")
  listed = fs.readdirSync(folder).toSorted()
  engine = await start("preview-real", () => [pythonReady(base, "1.0.0"), Preview.capability(pyramids, fromSource)])
})

after(async () => {
  if (missing) return
  await engine?.stop()
  fs.rmSync(folder, { recursive: true, force: true })
  fs.rmSync(pyramids, { recursive: true, force: true })
})

const file = (name: string) => path.join(folder, name)

/** What the tests read of an answer: a description's facts, a tile's bytes, what a click found, or a failure's code. */
interface Answer {
  readonly code?: string
  readonly kind?: string
  readonly stamp?: string
  readonly layer?: string
  readonly layers?: readonly { readonly name: string; readonly kind: string }[]
  readonly bands?: readonly unknown[]
  readonly features?: number
  readonly forms?: Readonly<Record<string, number>>
  readonly fields?: readonly { readonly name: string }[]
  readonly bounds?: readonly number[]
  readonly unplaced?: string
  readonly shown?: readonly number[]
  readonly width?: number
  readonly height?: number
  readonly bytes?: Uint8Array
  readonly empty?: boolean
  readonly found?: {
    readonly fid: number
    readonly row: number
    readonly attributes: readonly (readonly [string, unknown])[]
    readonly bounds: readonly number[] | null
  } | null
  readonly statistics?: {
    readonly bands: readonly ({ readonly [name: string]: number } & { readonly counts: readonly number[] })[]
    readonly ramps: Readonly<Record<string, readonly string[]>>
    readonly classes?: readonly {
      readonly value: number
      readonly color: readonly number[]
      readonly count: number
      readonly share: number
    }[]
  }
  readonly pixel?: {
    readonly column: number
    readonly row: number
    readonly values: readonly (number | null)[]
    readonly centre: readonly number[] | null
    readonly outline: readonly (readonly number[])[]
  } | null
  readonly offset?: number
  readonly fids?: readonly number[]
  readonly rows?: readonly (readonly unknown[])[]
}

/** A request's result, or the code it failed with. */
const ask = async (method: string, params: object): Promise<Answer> => {
  const response = await engine.response(engine.send(`preview.${method}`, params), 60000)
  return response.ok ? (response.result as Answer) : { code: response.error.code }
}

/** A tile's layers, of an answer that brought one. */
const drawn = (answer: Answer) => {
  assert.ok(answer.bytes, `no tile: ${answer.code ?? "empty"}`)
  return layers(answer.bytes)
}

/** A dataset's description and a function asking for its tiles and clicks as described. */
const open = async (name: string, layer?: string) => {
  const target = { path: file(name), ...(layer ? { layer } : {}) }
  const described = await ask("describe", target)
  return {
    described,
    tile: (tile: { z: number; x: number; y: number } = TILE, fid?: number) =>
      ask("tile", { ...target, stamp: described.stamp, ...tile, ...(fid === undefined ? {} : { fid }) }),
    drawn: (look: object) => ask("tile", { ...target, stamp: described.stamp, ...TILE, look }),
    statistics: async () => (await ask("statistics", { ...target, stamp: described.stamp })).statistics,
    pixel: async (longitude: number, latitude: number) => {
      const [x, y] = plane(longitude, latitude)
      return (await ask("pixel", { ...target, stamp: described.stamp, x, y })).pixel
    },
    feature: async (fid: number) => (await ask("identify", { ...target, stamp: described.stamp, fid })).found,
    rows: (row: number) => ask("rows", { ...target, stamp: described.stamp, row }),
    click: async (longitude: number, latitude: number, tolerance = 5, forms?: readonly string[]) => {
      const [x, y] = plane(longitude, latitude)
      const shown = forms ? { forms } : {}
      return (await ask("identify", { ...target, stamp: described.stamp, x, y, tolerance, ...shown })).found
    },
  }
}

const box = (ring: readonly (readonly [number, number])[]) => [
  Math.min(...ring.map(([x]) => x)),
  Math.min(...ring.map(([, y]) => y)),
  Math.max(...ring.map(([x]) => x)),
  Math.max(...ring.map(([, y]) => y)),
]
/** The box a tile's part is expected in: from its north-west corner to its south-east, as longitudes and latitudes. */
const boxed = (west: number, north: number, east: number, south: number) => [...at(west, north), ...at(east, south)]

test("a vector layer's tile holds each shape as a display can tell it apart", { skip: missing }, async () => {
  const shapes = await open("shapes.gpkg")
  assert.equal(shapes.described.kind, "vector")
  assert.equal(shapes.described.layer, "shapes")
  assert.deepEqual(
    shapes.described.layers?.map((layer) => layer.name),
    ["shapes", "towns"],
  )
  assert.equal(shapes.described.features, 15)
  // Features, not their parts: the islands are one, and the feature of a point and a line is among both.
  assert.deepEqual(shapes.described.forms, { points: 4, lines: 4, polygons: 7 })
  assert.deepEqual(
    shapes.described.fields?.map((field) => field.name),
    ["name", "size"],
  )
  const [west, south, east, north] = shapes.described.bounds ?? []
  assert.ok(Math.abs(west + 0.1) < 1e-6 && Math.abs(east - 0.5) < 1e-6, `${west} to ${east}`)
  assert.ok(Math.abs(south - 0.01) < 1e-6 && Math.abs(north - 0.34) < 1e-6, `${south} to ${north}`)

  const tile = drawn(await shapes.tile())
  assert.deepEqual(Object.keys(tile).toSorted(), ["lines", "points", "polygons", "small-polygons"])
  for (const layer of Object.values(tile)) assert.equal(layer.extent, 4096)

  // A shell runs clockwise and its hole follows it the other way, however the file wound them: that order and
  // those directions are all a tile has to tell a hole by.
  const rings = tile.polygons.parts
  assert.equal(tile.polygons.kind, 3)
  assert.equal(rings.length, 7)
  const shell = rings.findIndex((ring) => String(box(ring)) === String(boxed(0.05, 0.25, 0.25, 0.05)))
  assert.ok(shell >= 0, "the district's shell")
  assert.equal(rings[shell].length, 4)
  assert.ok(area(rings[shell]) > 0)
  assert.deepEqual(box(rings[shell + 1]), boxed(0.1, 0.2, 0.2, 0.1))
  assert.ok(area(rings[shell + 1]) < 0)
  for (const [index, ring] of rings.entries()) if (index !== shell + 1) assert.ok(area(ring) > 0)
  // Cut where the tile's margin ends, not drawn out to where the polygon does.
  assert.ok(rings.some((ring) => box(ring)[0] === -64 && box(ring)[2] === at(0.1, 0.3)[0]))
  assert.ok(
    rings.some((ring) => String(box(ring)) === String(boxed(0.3, 0.04, 0.32, 0.02))),
    "the second island",
  )

  // A line keeps its corners and loses the vertices on the straight way between them.
  assert.equal(tile.lines.kind, 2)
  assert.equal(tile.lines.parts.length, 4)
  assert.ok(tile.lines.parts.some((line) => String(line) === String([at(0, 0.3), at(0.1, 0.3), at(0.1, 0.34)])))
  const cut = tile.lines.parts.find((line) => String(line[0]) === String(at(0.3, 0.01)))
  assert.ok(cut && cut.length === 2 && cut[1][0] >= 4158 && cut[1][0] <= 4160, String(cut))
  // A curve is followed by straight pieces from its one end to its other.
  const bend = tile.lines.parts.find((line) => String(line[0]) === String(at(0.26, 0.1)))
  assert.ok(bend && bend.length > 4 && String(bend.at(-1)) === String(at(0.3, 0.1)), String(bend))

  // Two points a display cannot tell apart are one, and so are two shapes too small to be seen as shapes.
  assert.equal(tile.points.kind, 1)
  assert.deepEqual(
    tile.points.parts.map(([point]) => String(point)).toSorted(),
    [exactly(0.01, 0.01), exactly(0.03, 0.01), exactly(0.33, 0.33)].map(String).toSorted(),
  )
  assert.equal(tile["small-polygons"].parts.length, 1)
  const [[dot]] = tile["small-polygons"].parts
  assert.ok(Math.abs(dot[0] - at(0.3, 0.2)[0]) <= 2 && Math.abs(dot[1] - at(0.3, 0.2)[1]) <= 2, String(dot))

  // Farther out the house is too small to be a shape as well.
  const wider = drawn(await shapes.tile({ z: 4, x: 8, y: 7 }))
  assert.equal(wider.polygons.parts.length, 6)
  assert.equal((await shapes.tile({ z: 10, x: 100, y: 100 })).empty, true)
})

test("a click finds the smallest feature under it and its attributes", { skip: missing }, async () => {
  const shapes = await open("shapes.gpkg")
  const named = async (longitude: number, latitude: number, tolerance?: number) =>
    (await shapes.click(longitude, latitude, tolerance))?.attributes[0][1]
  assert.deepEqual((await shapes.click(0.061, 0.061))?.attributes, [
    ["name", "house"],
    ["size", 1.5],
  ])
  assert.equal(await named(0.07, 0.07), "district")
  // In the district's hole.
  assert.equal(await shapes.click(0.15, 0.15), null)
  // The second of a feature's two parts, a curve where it bends, and a point rather than its neighbour.
  assert.equal(await named(0.31, 0.03), "islands")
  assert.equal(await named(0.28, 0.12, 30), "bend")
  assert.equal(await named(0.01, 0.01), "well")
  assert.equal(await named(0.33, 0.3), "both")
  assert.equal(await named(0.27, 0.27), "raised")
  // What is hidden is not clicked: neither the house nor the district it stands in, nor a point.
  assert.equal(await shapes.click(0.061, 0.061, 5, ["points", "lines"]), null)
  assert.equal(await shapes.click(0.01, 0.01, 5, ["lines", "polygons"]), null)
})

// Guards the mark of the feature that is picked, cut from that feature's parts alone: taken from the wrong places of
// the layer's arrays, it would mark another feature's shape and fail nothing.
test("a feature is found by its number, with where it lies, and is drawn alone", { skip: missing }, async () => {
  const shapes = await open("shapes.gpkg")
  const near = (bounds: readonly number[] | null | undefined, expected: readonly number[]) =>
    bounds?.length === 4 && bounds.every((value, index) => Math.abs(value - expected[index]) < 1e-6)
  const house = await shapes.click(0.061, 0.061)
  assert.deepEqual([house?.fid, house?.row], [2, 1])
  assert.ok(near(house?.bounds, [0.06, 0.06, 0.062, 0.062]), String(house?.bounds))
  // Both of its parts, and the point and the line of a feature that is both.
  const islands = await shapes.feature(11)
  assert.deepEqual([islands?.row, islands?.attributes[0][1]], [10, "islands"])
  assert.ok(near(islands?.bounds, [0.26, 0.02, 0.32, 0.04]), String(islands?.bounds))
  assert.ok(near((await shapes.feature(13))?.bounds, [0.32, 0.3, 0.34, 0.33]))
  // A feature without geometry lies nowhere, and a number of no feature finds none.
  assert.deepEqual([(await shapes.feature(15))?.row, (await shapes.feature(15))?.bounds], [14, null])
  assert.equal(await shapes.feature(99), null)

  const district = drawn(await shapes.tile(TILE, 1))
  assert.deepEqual(Object.keys(district), ["polygons"])
  assert.deepEqual(district.polygons.parts.map(box), [boxed(0.05, 0.25, 0.25, 0.05), boxed(0.1, 0.2, 0.2, 0.1)])
  const marked = drawn(await shapes.tile(TILE, 11))
  assert.deepEqual(marked.polygons.parts.map(box), [boxed(0.26, 0.04, 0.28, 0.02), boxed(0.3, 0.04, 0.32, 0.02)])
  assert.deepEqual(Object.keys(drawn(await shapes.tile(TILE, 13))).toSorted(), ["lines", "points"])
  assert.equal((await shapes.tile(TILE, 15)).empty, true)

  // Where the attributes are kept in memory, they are those of the row the feature is read as.
  const route = await open("route.geojson")
  assert.deepEqual([(await route.feature(1))?.row, (await route.feature(1))?.attributes[0][1]], [1, "way"])
})

// Guards the table's pages against beginning at the wrong feature, by either way of reading them: a page of other
// rows than its numbers say looks as right as any.
test("a layer's table is read a page at a time, with or without a place on the map", { skip: missing }, async () => {
  const shapes = await open("shapes.gpkg")
  const first = await shapes.rows(0)
  assert.equal(first.offset, 0)
  assert.deepEqual(first.fids, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
  assert.deepEqual(
    [first.rows?.[0], first.rows?.[14]],
    [
      ["district", 1.5],
      ["nowhere", 1.5],
    ],
  )

  const paged = (answer: Answer) => [answer.offset, answer.fids?.length, answer.fids?.[0], answer.rows?.[0]?.[0]]
  const many = await open("many.gpkg")
  assert.deepEqual(paged(await many.rows(2050)), [2000, 100, 2001, "p2000"])
  assert.deepEqual(paged(await many.rows(1999)), [0, 2000, 1, "p0"])
  // Read from the file before the layer is in memory, and from memory once a tile has brought it there.
  const kept = await open("many.geojson")
  const read = await kept.rows(2050)
  assert.deepEqual(paged(read), [2000, 100, 2000, "p2000"])
  assert.ok((await kept.tile()).bytes)
  assert.deepEqual(await kept.rows(2050), read)

  assert.deepEqual((await (await open("unplaced.shp")).rows(0)).rows, [["a", 1.5]])
})

// Guards a GeoPackage's rasters, which a file described by its vector layers alone would hide for good.
test("a GeoPackage shows each of its layers, vector layers and rasters alike", { skip: missing }, async () => {
  const both = await open("both.gpkg")
  assert.deepEqual([both.described.kind, both.described.layer], ["vector", "roads"])
  assert.deepEqual(
    both.described.layers?.map((layer) => [layer.name, layer.kind]),
    [
      ["roads", "vector"],
      ["heights", "raster"],
      ["picture", "raster"],
    ],
  )
  assert.equal(drawn(await both.tile()).lines.parts.length, 1)
  const picture = await open("both.gpkg", "picture")
  assert.deepEqual([picture.described.kind, picture.described.layer], ["raster", "picture"])
  assert.equal(picture.described.bands?.length, 3)
  assert.ok((await picture.tile()).bytes)
  const heights = await open("both.gpkg", "heights")
  assert.equal(heights.described.bands?.length, 1)
  assert.ok((await heights.tile()).bytes)
  assert.deepEqual(heights.described.layers, both.described.layers)
})

test("a dataset says which layer it shows, and why it shows nothing", { skip: missing }, async () => {
  const towns = await open("shapes.gpkg", "towns")
  assert.equal(towns.described.features, 1)
  assert.equal(drawn(await towns.tile()).points.parts.length, 1)
  assert.deepEqual(await ask("describe", { path: file("shapes.gpkg"), layer: "villages" }), { code: "no-layer" })

  const unplaced = await open("unplaced.shp")
  assert.equal(unplaced.described.unplaced, "no-crs")
  assert.equal(unplaced.described.features, 1)
  assert.deepEqual(await unplaced.tile(), { code: "no-crs" })

  // GDAL takes GeoJSON for longitude and latitude whatever its numbers are; drawn as that, metres lie nowhere.
  const route = await open("route.geojson")
  assert.deepEqual(route.described.forms, { points: 1, lines: 1 })
  assert.deepEqual(Object.keys(drawn(await route.tile())).toSorted(), ["lines", "points"])
  assert.equal((await route.click(0.15, 0.15))?.attributes[0][1], "way")
  assert.equal((await open("metres.geojson")).described.unplaced, "not-degrees")
  // Guards a file of a feature a line, which read as one GeoJSON object is its first feature and no failure.
  assert.equal((await open("lines.geojson")).described.features, 2)

  assert.deepEqual(await ask("describe", { path: file("absent.tif") }), { code: "missing" })
  assert.deepEqual(await ask("describe", { path: file("notes.gpkg") }), { code: "unopenable" })
  // Guards against a file that only lists others, which GDAL would go and open wherever they are.
  assert.deepEqual(await ask("describe", { path: file("virtual.tif") }), { code: "unopenable" })
})

test(
  "a raster's tile shows its bands, stretched or coloured as its kind asks, and nothing where it has no data",
  { skip: missing },
  async () => {
    const saved = async (name: string, tile = TILE) => {
      const opened = await open(name)
      assert.equal(opened.described.kind, "raster")
      const answer = await opened.tile(tile)
      const image = file(`${name}-${tile.z}.webp`)
      assert.ok(answer.bytes, `no tile: ${answer.code ?? "empty"}`)
      fs.writeFileSync(image, answer.bytes)
      return { image, opened }
    }
    const picture = await saved("picture.tif")
    assert.deepEqual(picture.opened.described.shown, [1, 2, 3])
    assert.deepEqual([picture.opened.described.width, picture.opened.described.height], [256, 256])
    const farther = await saved("picture.tif", { z: 9, x: 256, y: 255 })
    const heights = await saved("heights.tif")
    const classes = await saved("classes.tif")
    // Guards the reader itself: NaN is no JSON, and a description naming it would end the reader that wrote it.
    const unknown = await saved("unknown.tif")
    const [here, out, risen, coloured, known] = JSON.parse(
      execFileSync(
        base,
        [
          "-I",
          "-B",
          "-c",
          PIXELS,
          JSON.stringify([
            [
              picture.image,
              [
                [100, 256],
                [400, 256],
              ],
            ],
            [
              farther.image,
              [
                [100, 400],
                [400, 100],
              ],
            ],
            [
              heights.image,
              [
                [130, 400],
                [500, 400],
                [40, 40],
              ],
            ],
            [
              classes.image,
              [
                [100, 256],
                [400, 256],
              ],
            ],
            [
              unknown.image,
              [
                [130, 400],
                [40, 40],
              ],
            ],
          ]),
        ],
        { encoding: "utf-8" },
      ),
    ) as number[][][]
    const near = (pixel: number[], expected: number[]) =>
      pixel.every((value, index) => Math.abs(value - expected[index]) <= 12)
    // Twice the pixels a tile takes on the map; red in the west, blue in the east, as it is.
    assert.deepEqual(here[0], [512, 512])
    assert.ok(near(here[1], [255, 0, 0, 255]) && near(here[2], [0, 0, 255, 255]), String(here))
    // The raster fills the south-west quarter of the tile above it, and the rest shows through.
    assert.ok(near(out[1], [255, 0, 0, 255]), String(out))
    assert.equal(out[2][3], 0)
    // One band: grey, darker where it is lower, and clear where it has no data.
    const [low, high, none] = risen.slice(1)
    assert.ok(Math.abs(low[0] - low[1]) <= 3 && Math.abs(low[1] - low[2]) <= 3 && low[3] === 255, String(low))
    assert.ok(high[0] - low[0] > 100, `${low} to ${high}`)
    assert.equal(none[3], 0)
    // A colour table's entries exactly, which a lossy picture would smear.
    assert.deepEqual(coloured.slice(1), [
      [200, 30, 30, 255],
      [30, 200, 30, 255],
    ])
    assert.deepEqual([known[1][3], known[2][3]], [255, 0])
    assert.equal((await picture.opened.tile({ z: 10, x: 100, y: 100 })).empty, true)
  },
)

// Guards what the interface draws a raster by: the numbers under its histogram, and the bands, the range and the ramp
// it asks for reaching the picture. Any of them dropped on the way, the tile is still a picture and nothing fails.
test("a raster is measured, and drawn as the interface asks", { skip: missing }, async () => {
  const heights = await open("heights.tif")
  const measured = await heights.statistics()
  const [band] = measured?.bands ?? []
  assert.deepEqual([band.min, band.max], [0, 1000])
  // Its mean above the middle: the corner without data is where it is lowest.
  assert.ok(Math.abs(band.mean - 525) < 5 && band.low < 40 && band.high > 960, JSON.stringify({ ...band, counts: 0 }))
  assert.equal(band.counts.length, 256)
  // Every value of the sample that is data, about evenly: none of the corner that has none.
  const counted = band.counts.reduce((sum, count) => sum + count, 0)
  assert.equal(counted, 256 * 256 - 64 * 64)
  assert.ok(Math.max(...band.counts) < 2 * (counted / 256), String(Math.max(...band.counts)))

  const pixels = async (answer: Answer, name: string, places: number[][]) => {
    assert.ok(answer.bytes, `no tile: ${answer.code ?? "empty"}`)
    const image = file(name)
    fs.writeFileSync(image, answer.bytes)
    const out = execFileSync(base, ["-I", "-B", "-c", PIXELS, JSON.stringify([[image, places]])], { encoding: "utf-8" })
    return (JSON.parse(out) as number[][][])[0].slice(1)
  }
  const near = (pixel: number[], expected: number[]) =>
    pixel.every((value, index) => Math.abs(value - expected[index]) <= 14)
  const colour = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).concat(255)
  // Low in the west and high in the east, through the ramp from its one end to its other, clear where there is no
  // data; and all above a range's high end drawn as that end.
  const ramp = measured?.ramps.viridis ?? []
  const spots = [
    [130, 400],
    [500, 400],
    [40, 40],
  ]
  const [low, high, none] = await pixels(
    await heights.drawn({ bands: [1], ranges: [[0, 1000]], ramp: "viridis" }),
    "ramp.webp",
    spots,
  )
  assert.ok(near(low, colour(ramp[1])) && near(high, colour(ramp.at(-1) ?? "")), `${low} and ${high}`)
  assert.equal(none[3], 0)
  const [cut] = await pixels(await heights.drawn({ bands: [1], ranges: [[0, 100]] }), "cut.webp", spots)
  assert.ok(near(cut, [255, 255, 255, 255]), String(cut))
  // Its bands in the order asked for: blue as red, where the picture is blue.
  const picture = await open("picture.tif")
  const [east] = await pixels(await picture.drawn({ bands: [3, 2, 1] }), "swapped.webp", [[400, 256]])
  assert.ok(near(east, [255, 0, 0, 255]), String(east))

  // The bands that are not drawn, the fourth and the fifth here, are measured together, from every third pixel of the
  // raster each way: each band its own values, the pixels without data left out, and as many of them as that
  // thinning keeps.
  const several = (await (await open("bands.tif")).statistics())?.bands ?? []
  assert.deepEqual(
    several.slice(3).map((each) => [each.min, each.max]),
    [
      [400, 1699],
      [500, 1799],
    ],
  )
  const kept = several[4].counts.reduce((sum, count) => sum + count, 0)
  assert.equal(kept, 434 * 434 - 100 * 100)

  const classes = (await (await open("classes.tif")).statistics())?.classes
  assert.deepEqual(
    classes?.map((each) => [each.value, each.color, each.share]),
    [
      [1, [200, 30, 30, 255], 0.5],
      [2, [30, 200, 30, 255], 0.5],
    ],
  )
})

// Guards the values a click reads out against being those of a neighbouring pixel, or of the picture drawn rather
// than of the file: either would be a number as good as any to look at.
test("a click on a raster reads the pixel under it, as the file holds it", { skip: missing }, async () => {
  const side = 0.3515625 / 256
  const heights = await open("heights.tif")
  // The pixel of column 200 and row 100, a little off its centre; its value is where it lies from west to east.
  const found = await heights.pixel(200.3 * side, 0.3515625 - 100.7 * side)
  assert.deepEqual([found?.column, found?.row], [200, 100])
  assert.ok(Math.abs((found?.values[0] ?? 0) - (200 / 255) * 1000) < 0.01, String(found?.values))
  const [x, y] = found?.centre ?? []
  assert.ok(Math.abs(x - 200.5 * side) < 1e-9 && Math.abs(y - (0.3515625 - 100.5 * side)) < 1e-9, `${x}, ${y}`)
  const corners = found?.outline ?? []
  assert.equal(corners.length, 4)
  assert.ok(Math.abs(corners[0][0] - 200 * side) < 1e-7 && Math.abs(corners[2][0] - 201 * side) < 1e-7, String(corners))
  assert.ok(Math.abs(corners[0][1] - (0.3515625 - 100 * side)) < 1e-7, String(corners))
  // No value where the band has no data, and no pixel outside the raster.
  assert.deepEqual((await heights.pixel(10 * side, 0.3515625 - 10 * side))?.values, [null])
  assert.equal(await heights.pixel(0.4, 0.1), null)
  // Every band, whichever are drawn.
  const picture = await open("picture.tif")
  assert.deepEqual((await picture.pixel(50 * side, 0.1))?.values, [255, 0, 0])
  assert.deepEqual((await picture.pixel(200 * side, 0.1))?.values, [0, 0, 255])
})

// Guards a raster of classes that brings no colours, as a classification's result is: drawn as measurements it is
// greys a shade apart. And guards its list of classes, which a count of a sample would leave the rare ones out of.
test(
  "whole numbers of few values are classes, each counted and in a colour of its own",
  { skip: missing },
  async () => {
    const zones = await open("zones.tif")
    const classes = (await zones.statistics())?.classes ?? []
    assert.deepEqual(
      classes.map((each) => [each.value, each.count]),
      [
        [100, 512 * 1024],
        [200, 1],
        [300, 512 * 1024 - 1],
      ],
    )
    const image = file("zones.webp")
    const colours = async (answer: Answer) => {
      assert.ok(answer.bytes, `no tile: ${answer.code ?? "empty"}`)
      fs.writeFileSync(image, answer.bytes)
      const spots = JSON.stringify([
        [
          image,
          [
            [100, 256],
            [400, 256],
          ],
        ],
      ])
      return (
        JSON.parse(execFileSync(base, ["-I", "-B", "-c", PIXELS, spots], { encoding: "utf-8" })) as number[][][]
      )[0]
    }
    // As it is opened, and asked for by name; through a ramp when one is asked for in their place.
    const [, west, east] = await colours(await zones.tile())
    assert.deepEqual([west, east], [classes[0].color, classes[2].color])
    assert.notDeepEqual(west, east)
    assert.deepEqual((await colours(await zones.drawn({ bands: [1], ramp: "classes" }))).slice(1), [west, east])
    const [, low, high] = await colours(await zones.drawn({ bands: [1], ranges: [[100, 300]], ramp: "grey" }))
    assert.ok(low[0] < 10 && low[0] === low[1] && high[0] > 245 && high[0] === high[1], `${low} and ${high}`)
    // Measurements stay measurements: heights have no classes.
    assert.equal((await (await open("heights.tif")).statistics())?.classes, undefined)
  },
)

// Guards a large raster's first view, which without overviews reads every pixel of it for a tile, and guards the
// overviews themselves: failing to make them is not a failure to draw, so nothing else would say they are not made.
test("a large raster without overviews is given them, in the cache and not beside it", { skip: missing }, async () => {
  const kept = () =>
    fs.readdirSync(pyramids).filter((name) => fs.existsSync(path.join(pyramids, name, "raster.vrt.ovr")))
  const strip = await open("strip.tif")
  assert.deepEqual([strip.described.width, strip.described.height], [9000, 64])
  assert.equal(kept().length, 1)
  // The whole of it across one tile, read from an overview: dark in its west half, light in its east, clear where it
  // has no data.
  const image = file("strip.webp")
  const answer = await strip.tile()
  assert.ok(answer.bytes, `no tile: ${answer.code ?? "empty"}`)
  fs.writeFileSync(image, answer.bytes)
  const spots = JSON.stringify([
    [
      image,
      [
        [30, 510],
        [150, 510],
        [310, 510],
      ],
    ],
  ])
  const [[, none, west, east]] = JSON.parse(
    execFileSync(base, ["-I", "-B", "-c", PIXELS, spots], { encoding: "utf-8" }),
  ) as number[][][]
  assert.equal(none[3], 0)
  assert.ok(west[3] === 255 && east[3] === 255 && east[0] - west[0] > 100, `${west} and ${east}`)
  // The same data is given them once, and changed data its own.
  await open("strip.tif")
  assert.equal(kept().length, 1)
  const later = new Date(Date.now() + 5000)
  fs.utimesSync(file("strip.tif"), later, later)
  await open("strip.tif")
  assert.equal(kept().length, 2)
  // A raster of a size to read whole is left as it is.
  await open("heights.tif")
  assert.equal(kept().length, 2)
  // Classes are not averaged into the overviews: a sample of the raster, read from them, still holds the classes
  // alone, and so the raster is still seen to be one of classes.
  const wide = await open("wide.tif")
  assert.equal(kept().length, 3)
  assert.deepEqual(
    (await wide.statistics())?.classes?.map((each) => each.value),
    [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000],
  )
})

// Guards a whole tile's fill: its first ring says which way shells run, so one the grid turned over would make holes
// of every shell after it. About two shells in a thousand are turned over where a tile shows a whole region.
test("a ring wound the wrong way for what it is is turned back", { skip: missing }, () => {
  const script = [
    "import json, sys, numpy",
    `sys.path.insert(0, ${JSON.stringify(SOURCE)})`,
    "from geocodekit.preview import _cut",
    // A shell and a hole each wound the wrong way, and a shell wound the right way.
    "rings = [[[0, 0], [0, 4], [4, 4], [4, 0]], [[10, 10], [14, 10], [14, 14], [10, 14]], [[20, 20], [24, 20], [24, 24]]]",
    "units = numpy.array([vertex for ring in rings for vertex in ring], dtype=numpy.int64)",
    "wound = _cut._wound(units, numpy.array([4, 4, 3]), numpy.array([True, False, True])).tolist()",
    "print(json.dumps([wound[0:4], wound[4:8], wound[8:11]]))",
  ].join("\n")
  const [shell, hole, right] = JSON.parse(execFileSync(base, ["-I", "-B", "-c", script], { encoding: "utf-8" })) as [
    number,
    number,
  ][][]
  assert.ok(area(shell) > 0 && area(hole) < 0, `${area(shell)} and ${area(hole)}`)
  assert.equal(shell.length, 4)
  assert.deepEqual(right, [
    [20, 20],
    [24, 20],
    [24, 24],
  ])
})

// Guards a preview against showing what the file no longer holds: a change to any file the dataset is made of, here
// one whose main file stays as it was.
test(
  "a request made for data that has since changed is refused until the data is described again",
  { skip: missing },
  async () => {
    const roads = await open("roads.shp")
    assert.equal(drawn(await roads.tile()).lines.parts.length, 1)
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(file("roads.dbf"), later, later)
    assert.deepEqual(await roads.tile(), { code: "changed" })
    const again = await open("roads.shp")
    assert.notEqual(again.described.stamp, roads.described.stamp)
    assert.equal(drawn(await again.tile()).lines.parts.length, 1)
  },
)

// Guards the user's folder: the statistics GDAL writes down once it has computed them are what reading would leave.
test("the readers leave nothing beside the data", { skip: missing }, () => {
  const made = fs.readdirSync(folder).filter((name) => !name.endsWith(".webp"))
  assert.deepEqual(made.toSorted(), listed)
})

const LSOF = "/usr/sbin/lsof"

// Guards a file GeoAgent is about to replace: Windows refuses to replace a file a process holds open. Looked for
// where lsof can show it, which is not on Windows.
test(
  "the readers hold none of the data's files open once they have answered",
  { skip: missing || (!fs.existsSync(LSOF) && `no ${LSOF} to list a reader's open files with`) },
  () => {
    const readers = engine.sent.flatMap((message) =>
      message.type === "task" && message.event === "start" ? [message.pid] : [],
    )
    const running = readers.filter(alive)
    assert.ok(running.length > 0)
    for (const pid of running) {
      const open = execFileSync(LSOF, ["-p", String(pid), "-Fn"], { encoding: "utf-8" })
      // It lists what a reader does hold, its interpreter for one.
      assert.ok(open.includes(path.dirname(path.dirname(base))), "lsof lists the reader's files")
      const held = open.split("\n").filter((line) => line.includes(folder))
      assert.deepEqual(held, [])
    }
  },
)
