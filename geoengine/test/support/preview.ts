import assert from "node:assert/strict"

/**
 * A reader's stand-in, run by Node in place of the Python: it answers as the reader does, and how it answers a tile
 * is chosen by the tile's `z`. A description tells what it was opened with, its process and the cancels it was sent.
 */
export const STAND_IN = `
const fs = require("fs")
let opened
const cancels = []
const write = (header, bytes = Buffer.alloc(0)) =>
  process.stdout.write(
    Buffer.concat([Buffer.from(JSON.stringify(bytes.length ? { ...header, bytes: bytes.length } : header) + "\\n"), bytes]),
  )
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const asked = JSON.parse(line)
  if (!opened) return void (opened = asked)
  if ("cancel" in asked) return void cancels.push(asked.cancel)
  if (asked.do === "describe") return write({ id: asked.id, result: { opened, pid: process.pid, cancels } })
  if (asked.do === "identify") return write({ id: asked.id, error: { code: "changed", message: "changed" } })
  if (asked.z === 1) return write({ id: asked.id, result: { empty: true } })
  // Never answered.
  if (asked.z === 2) return
  // Its reader ends, every time.
  if (asked.z === 3) return process.exit(7)
  // Its reader ends the first time a dataset is asked for it.
  if (asked.z === 4 && !fs.existsSync(opened.path + ".asked")) {
    fs.writeFileSync(opened.path + ".asked", "")
    return process.exit(7)
  }
  write({ id: asked.id, result: { empty: false } }, Buffer.from(asked.stamp + ":" + asked.z + "/" + asked.x + "/" + asked.y))
})
`

export const EMPTY = 1
export const SILENT = 2
export const FATAL = 3
export const FATAL_ONCE = 4

/**
 * A layer of a vector tile as read back: what its one feature is, and its parts, each a run of vertices in tile
 * units.
 */
export interface TileLayer {
  /** 1 for points, 2 for lines, 3 for rings. */
  readonly kind: number
  readonly extent: number
  readonly parts: readonly (readonly (readonly [number, number])[])[]
}

/**
 * The layers of a Mapbox Vector Tile by name, read by the format's specification rather than by the code that wrote
 * them. A point is a part of one vertex; a ring comes without its first vertex repeated.
 */
export const layers = (tile: Uint8Array): Record<string, TileLayer> => {
  const fields = (bytes: Uint8Array) => {
    const out: { field: number; value: number; bytes: Uint8Array }[] = []
    let at = 0
    const varint = () => {
      let value = 0
      for (let shift = 0; ; shift += 7) {
        const byte = bytes[at++]
        value += (byte & 0x7f) * 2 ** shift
        if (byte < 0x80) return value
      }
    }
    while (at < bytes.length) {
      const key = varint()
      if ((key & 7) === 0) out.push({ field: key >> 3, value: varint(), bytes: new Uint8Array() })
      else if ((key & 7) === 2) {
        const length = varint()
        out.push({ field: key >> 3, value: 0, bytes: bytes.subarray(at, at + length) })
        at += length
      } else throw new Error(`a tile field of wire type ${key & 7}`)
    }
    return out
  }
  const found: Record<string, TileLayer> = {}
  for (const layer of fields(tile)) {
    assert.equal(layer.field, 3)
    const inside = fields(layer.bytes)
    const name = Buffer.from(inside.find((each) => each.field === 1)!.bytes).toString()
    const features = inside.filter((each) => each.field === 2)
    assert.equal(features.length, 1)
    const feature = fields(features[0].bytes)
    const kind = feature.find((each) => each.field === 3)!.value
    // A packed field: its bytes are varints one after another, read here as fields of wire type 0 would not be.
    const numbers: number[] = []
    const packed = feature.find((each) => each.field === 4)!.bytes
    for (let at = 0; at < packed.length; ) {
      let value = 0
      for (let shift = 0; ; shift += 7) {
        const byte = packed[at++]
        value += (byte & 0x7f) * 2 ** shift
        if (byte < 0x80) break
      }
      numbers.push(value)
    }
    const parts: [number, number][][] = []
    let x = 0
    let y = 0
    for (let at = 0; at < numbers.length; ) {
      const command = numbers[at] & 7
      const count = numbers[at] >> 3
      at += 1
      if (command === 7) continue
      for (let step = 0; step < count; step++) {
        const dx = numbers[at++]
        const dy = numbers[at++]
        x += dx % 2 ? -(dx + 1) / 2 : dx / 2
        y += dy % 2 ? -(dy + 1) / 2 : dy / 2
        // A point's MoveTo may hold many, each a part of its own; a line's or a ring's begins one.
        if (command === 1) parts.push([[x, y]])
        else parts.at(-1)!.push([x, y])
      }
    }
    found[name] = { kind, extent: inside.find((each) => each.field === 5)!.value, parts }
  }
  return found
}

/** Twice a ring's area in the tile's units, positive when it runs clockwise as drawn, as a shell does. */
export const area = (ring: readonly (readonly [number, number])[]) =>
  ring.reduce((sum, [x, y], index) => {
    const [nextX, nextY] = ring[(index + 1) % ring.length]
    return sum + (x * nextY - nextX * y)
  }, 0)

const HALF = 20037508.342789244

/** Where a longitude and latitude lie in the map's plane, in metres. */
export const plane = (longitude: number, latitude: number): [number, number] => [
  (longitude * HALF) / 180,
  (Math.log(Math.tan(((90 + latitude) * Math.PI) / 360)) * HALF) / Math.PI,
]

/**
 * Where a longitude and latitude fall in a tile, in its units: on the grid of two units the vertices of a tile's lines
 * and rings keep to, or `exact`, as its points are.
 */
export const unit = (
  longitude: number,
  latitude: number,
  z: number,
  x: number,
  y: number,
  exact = false,
): [number, number] => {
  const span = (2 * HALF) / 2 ** z
  const [east, north] = plane(longitude, latitude)
  const u = Math.floor(((east + HALF - x * span) / span) * 4096)
  const v = Math.floor(((HALF - y * span - north) / span) * 4096)
  return exact ? [u, v] : [u - (((u % 2) + 2) % 2), v - (((v % 2) + 2) % 2)]
}

/**
 * Writes the datasets the tests read into the folder given as its argument, with the base environment's GDAL. All lie
 * in the tile 10/512/511, which reaches from the equator and the prime meridian about a third of a degree north and
 * east.
 */
export const MAKE = String.raw`
import os, sys
import numpy
from osgeo import gdal, ogr, osr
gdal.UseExceptions()
folder = sys.argv[1]
wgs84 = osr.SpatialReference(); wgs84.ImportFromEPSG(4326); wgs84.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)

def layer(dataset, name, srs, kind, features):
    made = dataset.CreateLayer(name, srs, kind)
    made.CreateField(ogr.FieldDefn("name", ogr.OFTString))
    made.CreateField(ogr.FieldDefn("size", ogr.OFTReal))
    for name, wkt in features:
        feature = ogr.Feature(made.GetLayerDefn())
        feature.SetField("name", name)
        feature.SetField("size", 1.5)
        if wkt:
            feature.SetGeometry(ogr.CreateGeometryFromWkt(wkt))
        made.CreateFeature(feature)

shapes = ogr.GetDriverByName("GPKG").CreateDataSource(os.path.join(folder, "shapes.gpkg"))
layer(shapes, "shapes", wgs84, ogr.wkbUnknown, [
    # Its shell counter-clockwise and its hole clockwise, the other way round from a tile's.
    ("district", "POLYGON ((0.05 0.05, 0.25 0.05, 0.25 0.25, 0.05 0.25, 0.05 0.05), (0.10 0.10, 0.10 0.20, 0.20 0.20, 0.20 0.10, 0.10 0.10))"),
    ("house", "POLYGON ((0.060 0.060, 0.060 0.062, 0.062 0.062, 0.062 0.060, 0.060 0.060))"),
    ("west", "POLYGON ((-0.1 0.28, -0.1 0.32, 0.1 0.32, 0.1 0.28, -0.1 0.28))"),
    ("road", "LINESTRING (0.0 0.30, 0.02 0.30, 0.05 0.30, 0.1 0.30, 0.1 0.34)"),
    ("east", "LINESTRING (0.30 0.01, 0.50 0.01)"),
    ("shed", "POLYGON ((0.300000 0.200000, 0.300000 0.200005, 0.300005 0.200005, 0.300005 0.200000, 0.300000 0.200000))"),
    ("hut", "POLYGON ((0.300006 0.200000, 0.300006 0.200005, 0.300011 0.200005, 0.300011 0.200000, 0.300006 0.200000))"),
    ("well", "POINT (0.01 0.01)"),
    ("pump", "POINT (0.010001 0.01)"),
    ("tree", "POINT (0.03 0.01)"),
    ("islands", "MULTIPOLYGON (((0.26 0.02, 0.26 0.04, 0.28 0.04, 0.28 0.02, 0.26 0.02)), ((0.30 0.02, 0.30 0.04, 0.32 0.04, 0.32 0.02, 0.30 0.02)))"),
    ("bend", "CIRCULARSTRING (0.26 0.10, 0.28 0.12, 0.30 0.10)"),
    ("both", "GEOMETRYCOLLECTION (POINT (0.33 0.33), LINESTRING (0.32 0.30, 0.34 0.30))"),
    ("raised", "POLYGON Z ((0.26 0.26 5, 0.26 0.28 5, 0.28 0.28 5, 0.28 0.26 5, 0.26 0.26 5))"),
    ("nowhere", None),
])
layer(shapes, "towns", wgs84, ogr.wkbPoint, [("north", "POINT (0.2 0.3)")])
shapes = None

# GeoJSON of two kinds of geometry, and one whose coordinates are metres, of which the file says nothing.
def geojson(name, geometries):
    features = ['{"type": "Feature", "properties": {"name": "%s"}, "geometry": %s}' % each for each in geometries]
    with open(os.path.join(folder, name), "w") as out:
        out.write('{"type": "FeatureCollection", "features": [%s]}' % ", ".join(features))

geojson("route.geojson", [
    ("stop", '{"type": "Point", "coordinates": [0.1, 0.1]}'),
    ("way", '{"type": "LineString", "coordinates": [[0.1, 0.1], [0.2, 0.2]]}'),
])
geojson("metres.geojson", [("stop", '{"type": "Point", "coordinates": [302000, 2770000]}')])
# Under GeoJSON's name, a feature on each line.
with open(os.path.join(folder, "lines.geojson"), "w") as out:
    for x in (0.1, 0.2):
        out.write('{"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": [%s, 0.1]}}\n' % x)

# A Shapefile with nothing to say where it lies, and one that says.
for name, srs in (("unplaced", None), ("roads", wgs84)):
    made = ogr.GetDriverByName("ESRI Shapefile").CreateDataSource(os.path.join(folder, name + ".shp"))
    layer(made, name, srs, ogr.wkbLineString, [("a", "LINESTRING (0.1 0.1, 0.2 0.2)")])
    made = None

side = 0.3515625
def raster(name, bands, kind, fill):
    made = gdal.GetDriverByName("GTiff").Create(os.path.join(folder, name), 256, 256, bands, kind)
    made.SetGeoTransform((0, side / 256, 0, side, 0, -side / 256))
    made.SetSpatialRef(wgs84)
    fill(made)
    made = None

def picture(made):
    # Red in its west half, blue in its east.
    red = numpy.zeros((256, 256), dtype=numpy.uint8); red[:, :128] = 255
    made.GetRasterBand(1).WriteArray(red)
    made.GetRasterBand(2).WriteArray(numpy.zeros((256, 256), dtype=numpy.uint8))
    made.GetRasterBand(3).WriteArray(255 - red)

def heights(made):
    # Rising from west to east, with no data in its north-west corner.
    values = numpy.tile(numpy.linspace(0, 1000, 256, dtype=numpy.float32), (256, 1))
    values[:64, :64] = -9999
    made.GetRasterBand(1).WriteArray(values)
    made.GetRasterBand(1).SetNoDataValue(-9999)

def classes(made):
    values = numpy.ones((256, 256), dtype=numpy.uint8); values[:, 128:] = 2
    band = made.GetRasterBand(1)
    table = gdal.ColorTable()
    table.SetColorEntry(1, (200, 30, 30, 255)); table.SetColorEntry(2, (30, 200, 30, 255))
    band.SetColorTable(table)
    band.WriteArray(values)

def unknown(made):
    # As heights, with NaN for where it has no data, as rasters written by Python often have.
    values = numpy.tile(numpy.linspace(0, 1000, 256, dtype=numpy.float32), (256, 1))
    values[:64, :64] = numpy.nan
    made.GetRasterBand(1).WriteArray(values)
    made.GetRasterBand(1).SetNoDataValue(float("nan"))

raster("picture.tif", 3, gdal.GDT_Byte, picture)
raster("heights.tif", 1, gdal.GDT_Float32, heights)
raster("classes.tif", 1, gdal.GDT_Byte, classes)
raster("unknown.tif", 1, gdal.GDT_Float32, unknown)

# A raster too long to draw without overviews and with none: low in its west half, high in its east, and without data
# at its western end.
strip = gdal.GetDriverByName("GTiff").Create(os.path.join(folder, "strip.tif"), 9000, 64, 1, gdal.GDT_Int16)
strip.SetGeoTransform((0, side / 9000, 0, side * 64 / 9000, 0, -side / 9000))
strip.SetSpatialRef(wgs84)
values = numpy.full((64, 9000), 100, dtype=numpy.int16); values[:, 4500:] = 1000; values[:, :1500] = -9999
strip.GetRasterBand(1).WriteArray(values)
strip.GetRasterBand(1).SetNoDataValue(-9999)
strip = None

# A GeoPackage of a vector layer and two rasters.
both = ogr.GetDriverByName("GPKG").CreateDataSource(os.path.join(folder, "both.gpkg"))
layer(both, "roads", wgs84, ogr.wkbLineString, [("a", "LINESTRING (0.1 0.1, 0.2 0.2)")])
both = None
for table in ("heights", "picture"):
    gdal.Translate(
        os.path.join(folder, "both.gpkg"),
        os.path.join(folder, table + ".tif"),
        format="GPKG",
        creationOptions=["APPEND_SUBDATASET=YES", "RASTER_TABLE=" + table],
    )
# Under a GeoTIFF's name, a virtual raster: a list of other files for GDAL to open.
gdal.BuildVRT(os.path.join(folder, "virtual.tif"), [os.path.join(folder, "picture.tif")]).FlushCache()
`

/**
 * Prints, as JSON, each image's size and its pixels at the places asked for, with Pillow. Its one argument is JSON: a
 * list of images, each a file and its places.
 */
export const PIXELS = String.raw`
import json, sys
from PIL import Image
out = []
for file, places in json.loads(sys.argv[1]):
    image = Image.open(file).convert("RGBA")
    out.append([image.size] + [image.getpixel(tuple(place)) for place in places])
print(json.dumps(out))
`
