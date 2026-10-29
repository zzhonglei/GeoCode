import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Macos } from "../../src/qgis/macos.ts"
import { Python } from "../../src/qgis/python.ts"
import { Runtime } from "../../src/runtime.ts"
import { until, alive } from "../support/common.ts"
import { darwin, start } from "../support/qgis.ts"

/**
 * Real installations: GEOENGINE_QGIS_APPS (colon-separated), or every /Applications/QGIS*.app, `located` when its
 * Python is found.
 */
const realApps = async () => {
  if (!darwin) return []
  if (process.env.GEOENGINE_QGIS_APPS) {
    return process.env.GEOENGINE_QGIS_APPS.split(":")
      .filter(Boolean)
      .map((app) => ({ app, located: true }))
  }
  const names = await fs.readdir("/Applications").catch(() => [] as string[])
  const apps = names.filter((name) => /^QGIS.*\.app$/.test(name)).map((name) => path.join("/Applications", name))
  return Promise.all(apps.map(async (app) => ({ app, located: (await Macos.locate(app)).ok })))
}

const found = await realApps()
const apps = found.flatMap((each) => (each.located ? [each.app] : []))

// Guards against these tests reported as passed with none run: on a machine without QGIS, or for a QGIS installed where
// GeoEngine no longer finds its Python.
if (found.length === 0) test("a real QGIS", { skip: "no QGIS found on this machine (macOS only)" }, () => {})
for (const { app } of found.filter((each) => !each.located)) {
  test(`QGIS at ${app}`, { skip: "its Python is not where GeoEngine looks for it" }, () => {})
}

for (const app of apps) {
  test(`QGIS at ${app} gets ready and runs a built-in algorithm on Chinese paths and values`, async () => {
    const engine = await start(app)
    // Guards against a request reaching QGIS's Python changed: quotes and backslashes are escapes in the program it
    // reads, and %, ^, & and ! are what Windows's command interpreter would rewrite on a command line.
    const data = path.join(engine.directory, String.raw`数据 目录 "%PATH%" ^&! \n 😀`)
    try {
      const state = await engine.settled(150000)
      assert.equal(state.status, "ready", JSON.stringify(state))
      assert.ok(state.status === "ready" && state.algorithms > 100)

      await fs.mkdir(data)
      const input = path.join(data, "点.geojson")
      const output = path.join(data, "缓冲区.gpkg")
      await fs.writeFile(
        input,
        JSON.stringify({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { 名称: "台北" },
              geometry: { type: "Point", coordinates: [121.56, 25.03] },
            },
          ],
        }),
      )
      const response = await engine.request(
        { algorithm: "native:buffer", parameters: { INPUT: input, DISTANCE: 0.01, OUTPUT: output } },
        120000,
      )
      assert.ok(response.ok, JSON.stringify(response))
      // Guards against attribute text reaching QGIS through a codec other than UTF-8.
      const value = execFileSync("sqlite3", [output, 'SELECT "名称" FROM "缓冲区"'], { encoding: "utf-8" })
      assert.equal(value.trim(), "台北")
    } finally {
      await engine.stop()
    }
  })

  test(`QGIS at ${app} checks a run as the kernel does, and measures on the WGS 84 ellipsoid`, async () => {
    const inherited = process.env.TMPDIR
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-tmp-"))
    process.env.TMPDIR = temporary
    const engine = await start(app)
    const at = (name: string) => path.join(engine.directory, name)
    const square = (south: number) => ({
      type: "Feature",
      properties: { south },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, south],
            [1, south],
            [1, south + 1],
            [0, south + 1],
            [0, south],
          ],
        ],
      },
    })
    try {
      assert.equal((await engine.settled(150000)).status, "ready")
      await fs.writeFile(
        at("cells.geojson"),
        JSON.stringify({ type: "FeatureCollection", features: [square(0), square(60)] }),
      )
      await fs.writeFile(
        at("mixed.geojson"),
        JSON.stringify({
          type: "FeatureCollection",
          features: [square(0), { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } }],
        }),
      )
      await fs.writeFile(at("area.gpkg"), "")
      const step = async (method: string, params: unknown) => {
        const response = await engine.request(params, 120000, method)
        assert.ok(response.ok, JSON.stringify(response))
        return response.result as Record<string, any>
      }
      const request = {
        algorithm: "native:fieldcalculator",
        parameters: { INPUT: "cells.geojson", FIELD_NAME: "a", FIELD_TYPE: 0, FORMULA: "$area", OUTPUT: "area.gpkg" },
      }
      const located = await step("qgis.locate", request)
      assert.deepEqual(located.files, ["cells.geojson", "area.gpkg"])
      const prepared = await step("qgis.prepare", { ...request, files: [at("cells.geojson"), at("area.gpkg")] })
      const plan = prepared.plan
      assert.ok(plan, JSON.stringify(prepared))
      assert.equal(plan.parameters.OUTPUT, at("area_1.gpkg"))
      assert.ok(plan.algorithm.translations["zh-CN"].name && plan.algorithm.translations["zh-TW"].name)
      assert.notEqual(plan.algorithm.translations["zh-CN"].name, plan.algorithm.name)
      await step("qgis.run", { algorithm: request.algorithm, parameters: plan.parameters })
      const areas = execFileSync("sqlite3", [at("area_1.gpkg"), 'SELECT "a" FROM "area_1" ORDER BY "south"'], {
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
        .map(Number)
      // A planar measure gives the two cells one area; on the ellipsoid the one at 60° N is about half.
      assert.ok(Math.abs(areas[0]! / 1.2308e10 - 1) < 0.01, String(areas))
      assert.ok(Math.abs(areas[1]! / areas[0]! - 0.493) < 0.02, String(areas))

      // Guards against QGIS renaming the feedback methods the run script overrides, which would drop every message.
      const buffered = await engine.request(
        {
          algorithm: "gdal:buffervectors",
          parameters: { INPUT: at("cells.geojson"), DISTANCE: 0.1, OUTPUT: at("b.gpkg") },
        },
        120000,
      )
      assert.ok(buffered.ok, JSON.stringify(buffered))
      const messages = engine.sent.flatMap((message) =>
        message.type === "progress" && message.id === buffered.id && "level" in (message.data as object)
          ? [message.data as { level: string; text: string }]
          : [],
      )
      assert.ok(
        messages.some((message) => message.level === "command" && message.text.includes("ogr2ogr")),
        JSON.stringify(messages),
      )

      // Guards against a GDAL command that exits with an error reading as finished: QGIS only reports its exit code.
      const unknown = await engine.request(
        {
          algorithm: "gdal:buffervectors",
          parameters: { INPUT: at("cells.geojson"), DISTANCE: 0.1, OPTIONS: "-nosuchoption", OUTPUT: at("c.gpkg") },
        },
        120000,
      )
      assert.ok(!unknown.ok && unknown.error.code === "algorithm-failed", JSON.stringify(unknown))

      // An algorithm that changes its input answers with the layer; the answer names its file, not the object.
      await fs.copyFile(at("cells.geojson"), at("scratch.geojson"))
      const truncated = await step("qgis.run", {
        algorithm: "native:truncatetable",
        parameters: { INPUT: at("scratch.geojson") },
      })
      assert.ok(truncated.ending.includes(at("scratch.geojson")), truncated.ending)

      const mixed = await step("qgis.prepare", {
        algorithm: "native:buffer",
        parameters: { INPUT: "mixed.geojson", DISTANCE: 1, OUTPUT: "m.gpkg" },
        files: [at("mixed.geojson"), at("m.gpkg")],
      })
      assert.ok(mixed.refused && !mixed.plan, JSON.stringify(mixed))
      assert.deepEqual(
        await fs.readdir(engine.directory).then((names) => names.filter((name) => name.startsWith("mixed"))),
        ["mixed.geojson"],
      )

      // A PROJ string without its prefix QGIS does not read, and would reproject nothing: refused with QGIS's own
      // forms. With the prefix it reads it, and a layer's path from where the run runs.
      const reproject = (target: string) =>
        step("qgis.prepare", {
          algorithm: "native:reprojectlayer",
          parameters: { INPUT: "cells.geojson", TARGET_CRS: target, OUTPUT: "p.gpkg" },
          files: [at("cells.geojson"), at("p.gpkg")],
          cwd: engine.directory,
        })
      const tmerc = "+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +units=m +no_defs"
      assert.ok((await reproject(tmerc)).refused)
      assert.ok((await reproject(`PROJ:${tmerc}`)).plan)
      assert.ok((await reproject("cells.geojson")).plan)

      // Guards against losing what PROJ and GDAL write themselves while the algorithm runs, and against telling
      // Qt's own diagnostics as QGIS starts.
      const unread = await engine.request(
        {
          algorithm: "native:reprojectlayer",
          parameters: { INPUT: at("cells.geojson"), TARGET_CRS: "EPSG:999999", OUTPUT: at("q.gpkg") },
        },
        120000,
      )
      assert.ok(unread.ok, JSON.stringify(unread))
      const written = engine.sent.flatMap((message) =>
        message.type === "progress" && message.id === unread.id && "level" in (message.data as object)
          ? [message.data as { level: string; text: string }]
          : [],
      )
      assert.ok(
        written.some((message) => message.level === "console" && message.text.includes("EPSG:999999")),
        JSON.stringify(written),
      )
      assert.ok(!written.some((message) => message.text.startsWith("qt.")), JSON.stringify(written))
      // Guards against offering the algorithm that opens files and addresses in other programs.
      assert.ok((await step("qgis.locate", { algorithm: "native:openurl", parameters: {} })).refused)
      // Guards against QGIS's temporary files piling up: they are its own, removed only by its teardown.
      assert.deepEqual(
        (await fs.readdir(temporary)).filter((name) => name.startsWith("QGIS")),
        [],
      )
    } finally {
      await engine.stop()
      if (inherited === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = inherited
      await fs.rm(temporary, { recursive: true, force: true })
    }
  })

  test(`QGIS at ${app} documents the algorithms GeoCode offers from its own definitions`, async () => {
    const engine = await start(app)
    try {
      const state = await engine.settled(150000)
      assert.ok(state.status === "ready", JSON.stringify(state))
      const doc = async (params: unknown) => {
        const response = await engine.request(params, 120000, "qgis.doc")
        assert.ok(response.ok, JSON.stringify(response))
        return (response.result as { text: string }).text
      }
      // Guards against offering data-defined values, which only qgis_process converts.
      assert.ok(!(await doc({ action: "help", algorithm: "native:buffer" })).includes("field:FIELD_NAME"))
      // Guards against losing which layer a field belongs to and that it takes several.
      const join = await doc({ action: "help", algorithm: "native:joinattributesbylocation" })
      assert.ok(join.includes("field of JOIN, multiple values allowed"), join)
      // Guards against numbering the options of an enum that refuses numbers.
      const dxf = await doc({ action: "help", algorithm: "native:dxfexport" })
      assert.ok(dxf.includes("- ISO-8859-1") && !dxf.includes("- 0: ISO-8859-1"), dxf)
      // Guards against offering an algorithm that needs QGIS's interface.
      assert.match(
        await doc({ action: "help", algorithm: "native:selectbyexpression" }),
        /^\w+:selectbyexpression is not available\.$/,
      )
      // Guards against the interface counting algorithms GeoAgent cannot use.
      assert.ok((await doc({ action: "groups" })).includes(` groups, ${state.algorithms} algorithms:\n`))
    } finally {
      await engine.stop()
    }
  })

  // Guards against a failed check losing where QGIS's launcher pointed Python, which tells a broken install apart.
  test(`QGIS at ${app} reports where its launcher pointed Python when a check fails`, async () => {
    const located = await Macos.locate(app)
    assert.ok(located.ok)
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-proj-"))
    try {
      const output = execFileSync(located.install.interpreter, ["-"], {
        input: Python.program(Python.PROBE),
        env: {
          ...Runtime.base(process.env, process.platform),
          ...Macos.environment(located.install),
          PROJ_DATA: empty,
        },
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      })
      const report = Python.marked(output).at(-1) as { failed: string; environment: Record<string, string> }
      assert.equal(report.failed, "proj")
      assert.ok(report.environment.PATH)
      // Guards against reporting the rest of the environment, which can hold the user's secrets.
      assert.equal(report.environment.HOME, undefined)
    } finally {
      await fs.rm(empty, { recursive: true, force: true })
    }
  })

  test(`QGIS at ${app} stops a cancelled run and its process, removing what it began to write`, async () => {
    const engine = await start(app)
    try {
      assert.equal((await engine.settled(150000)).status, "ready")
      const output = path.join(engine.directory, "points.gpkg")
      const id = engine.send({
        algorithm: "native:randompointsinextent",
        parameters: {
          EXTENT: "0,100,0,100 [EPSG:3857]",
          POINTS_NUMBER: 50000000,
          MIN_DISTANCE: 0,
          OUTPUT: output,
        },
      })
      await until(
        () => engine.sent.some((message) => message.type === "progress" && message.id === id) && existsSync(output),
        60000,
        "progress and the output begun",
      )
      const task = engine.sent.findLast((message) => message.type === "task" && message.event === "start")
      engine.deliver({ type: "cancel", id })
      const response = await engine.response(id)
      assert.ok(!response.ok && response.cancelled && response.error.code === "cancelled", JSON.stringify(response))
      assert.ok(task?.type === "task")
      await until(() => !alive(task.pid), 5000, "QGIS to end")
      // Guards against a stopped run leaving its half-written GeoPackage, with its journals, to pass for a result.
      const left = (await fs.readdir(engine.directory)).filter((name) => name.startsWith("points.gpkg"))
      assert.deepEqual(left, [])
    } finally {
      await engine.stop()
    }
  })

  test(`QGIS at ${app} reads geographic data as GDAL finds it, and leaves nothing beside it`, async () => {
    const engine = await start(app)
    const data = path.join(engine.directory, "数据 目录")
    try {
      assert.equal((await engine.settled(150000)).status, "ready")
      await fs.mkdir(data)
      await makeData(app, data)
      const before = await snapshot(data)
      const read = async (params: Record<string, unknown>) => {
        const response = await engine.request(
          { ...params, path: path.join(data, params.path as string) },
          120000,
          "qgis.read",
        )
        assert.ok(response.ok, JSON.stringify(response))
        return response.result as { text: string; image?: string }
      }

      const gbk = (await read({ path: "县.shp" })).text
      // Guards against reading a shapefile that declares no encoding as bytes, which garbles Chinese text.
      assert.ok(gbk.includes("GB18030") && gbk.includes('"鄂城区"'), gbk)
      const miscoded = (await read({ path: "乡.shp" })).text
      // Guards against taking a .cpg at its word when the text proves it wrong.
      assert.ok(miscoded.includes("GB18030") && miscoded.includes('"鄂城区"'), miscoded)
      const names = (await read({ path: "统计.shp" })).text
      // Guards against detecting the encoding from the values alone, which leaves Chinese field names garbled.
      assert.ok(names.includes("生产总值"), names)
      // Guards against GDAL failing the read when asked to move past the last feature.
      await read({ path: "县.shp", offset: 21 })

      const mixed = (await read({ path: "mixed.geojson" })).text
      assert.ok(mixed.includes("2 points, 1 line, 1 without geometry"), mixed)
      // Guards against GDAL's spelling of a number it had to keep as text, which reading in order brings out.
      const ratings = (await read({ path: "ratings.geojson" })).text
      assert.ok(ratings.includes('{"rating":"4.8"}'), ratings)
      const codes = (await read({ path: "codes.geojson" })).text
      // Guards against respelling text that only looks like a number, and against JavaScript rounding a 64-bit id.
      assert.ok(codes.includes('"007"') && codes.includes('"612345678901234567"'), codes)

      // Guards against the extent of zeros GDAL gives a GeoJSON layer whose features have no geometry.
      const unplaced = (await read({ path: "unplaced.geojson" })).text
      assert.ok(!unplaced.includes("Extent"), unplaced)
      await read({ path: "roads.gml" })

      // Guards against listing the styles QGIS keeps in a GeoPackage as a layer of data.
      const layers = (await read({ path: "multi.gpkg" })).text
      assert.ok(
        ["points", "population", "dem"].every((name) => layers.includes(`- ${name}:`)),
        layers,
      )
      assert.ok(!layers.includes("layer_styles"), layers)
      assert.ok((await read({ path: "multi.gpkg", layer: "population" })).text.includes("668000"))
      assert.ok((await read({ path: "multi.gpkg", layer: "dem" })).text.includes("4 × 3 pixels"))
      // Guards against reading a raster table of a GeoPackage open elsewhere without the changes in its -wal.
      const held = (await read({ path: "open.gpkg", layer: "dem" })).text
      assert.ok(held.includes("115, 30.97"), held)

      const landcover = (await read({ path: "landcover.tif" })).text
      // Guards against taking the approximate statistics cached in the .aux.xml for the raster's own.
      assert.ok(
        ["91.7%", "45.5%", "36.4%", "18.2%"].every((share) => landcover.includes(share)),
        landcover,
      )
      // Guards against a picture with nothing in it, which GeoAgent would take for the data.
      assert.equal((await read({ path: "blank.tif", preview: true })).image, undefined)
      const preview = await read({ path: "landcover.tif", preview: true })
      assert.ok(preview.image?.startsWith("iVBORw0KGgo"), "a PNG")
      assert.ok(preview.text.includes("rgb(0, 100, 0)"), preview.text)
      assert.ok((await read({ path: "photo.png" })).text.includes("no georeferencing"))
      // Guards against reporting a raster GDAL cannot read, here a VRT whose source is gone, as a band without data.
      const broken = await engine.request({ path: path.join(data, "broken.vrt") }, 120000, "qgis.read")
      assert.ok(!broken.ok && broken.error.code === "read-failed", JSON.stringify(broken))

      // Guards against a read writing beside the data: a .aux.xml, a .gfs, or a changed GeoPackage. SQLite indexes the
      // -wal of the one open elsewhere in its -shm, as that program does.
      const after = await snapshot(data)
      delete after["open.gpkg-shm"]
      assert.deepEqual(after, before)
    } finally {
      await engine.stop()
    }
  })
}

/** Every file under a directory with its content, to compare before and after. */
async function snapshot(directory: string) {
  const files = await fs.readdir(directory, { recursive: true })
  const entries = await Promise.all(
    files.sort().map(async (name) => [name, (await fs.readFile(path.join(directory, name))).toString("base64")]),
  )
  return Object.fromEntries(entries)
}

/** Writes the test data with QGIS's own GDAL: what each reader case needs, in the shapes real files take. */
async function makeData(app: string, directory: string) {
  const located = await Macos.locate(app)
  assert.ok(located.ok)
  const point = (name: string, coordinates: unknown, properties: object) => ({
    type: "Feature",
    properties,
    geometry: name === "none" ? null : { type: name, coordinates },
  })
  await fs.writeFile(
    path.join(directory, "mixed.geojson"),
    JSON.stringify({
      type: "FeatureCollection",
      features: [
        point("Point", [114.3, 30.59], { name: "黄鹤楼", rating: 4.8 }),
        point("MultiPoint", [[114.28, 30.58]], { name: "出口", rating: "5" }),
        point(
          "LineString",
          [
            [114.25, 30.55],
            [114.35, 30.62],
          ],
          { name: "长江大桥" },
        ),
        point("none", [], { name: "无几何" }),
      ],
    }),
  )
  await fs.writeFile(
    path.join(directory, "ratings.geojson"),
    JSON.stringify({
      type: "FeatureCollection",
      features: [4.8, "5", 4.8].map((rating) => point("Point", [114.3, 30.5], { rating })),
    }),
  )
  // Written as text: JSON.stringify cannot spell an integer past 2^53.
  const coded = (code: string) =>
    `{"type":"Feature","properties":{"id":612345678901234567,"code":${code}},"geometry":{"type":"Point","coordinates":[114.3,30.5]}}`
  await fs.writeFile(
    path.join(directory, "codes.geojson"),
    `{"type":"FeatureCollection","features":[${['"007"', '"007"', "5"].map(coded).join(",")}]}`,
  )
  await fs.writeFile(
    path.join(directory, "unplaced.geojson"),
    JSON.stringify({ type: "FeatureCollection", features: [point("none", [], { name: "无几何" })] }),
  )
  const script = String.raw`
import os, shutil, sqlite3, sys
from osgeo import gdal, ogr, osr
gdal.UseExceptions()
os.chdir(sys.argv[1])
wgs84 = osr.SpatialReference()
wgs84.ImportFromEPSG(4326)

# In GBK, the one without a .cpg, the other with a .cpg that says UTF-8.
for county in ("县", "乡"):
    shapefile = ogr.GetDriverByName("ESRI Shapefile").CreateDataSource(county + ".shp")
    layer = shapefile.CreateLayer(county, wgs84, ogr.wkbPolygon, options=["ENCODING=CP936"])
    layer.CreateField(ogr.FieldDefn("name", ogr.OFTString))
    # Enough text to tell GBK from Big5, as a real table of names has.
    for name in "鄂城区 龙里县 华容区 梁子湖区 光明区 高陵区 洪山区 江夏区 黄陂区 新洲区 蔡甸区 汉南区 武昌区 青山区 硚口区 汉阳区 江岸区 江汉区 东西湖区 黄石港区".split():
        feature = ogr.Feature(layer.GetLayerDefn())
        feature.SetField("name", name)
        feature.SetGeometry(ogr.CreateGeometryFromWkt("POLYGON ((114.6 30.2, 115 30.2, 115 30.4, 114.6 30.2))"))
        layer.CreateFeature(feature)
    shapefile = None
os.remove("县.cpg")
with open("乡.cpg", "w") as cpg:
    cpg.write("UTF-8")

# Chinese only in the field names.
shapefile = ogr.GetDriverByName("ESRI Shapefile").CreateDataSource("统计.shp")
layer = shapefile.CreateLayer("统计", wgs84, ogr.wkbPoint, options=["ENCODING=CP936"])
for name in ("人口", "面积", "生产总值"):
    layer.CreateField(ogr.FieldDefn(name, ogr.OFTString))
feature = ogr.Feature(layer.GetLayerDefn())
for name in ("人口", "面积", "生产总值"):
    feature.SetField(name, "12")
feature.SetGeometry(ogr.CreateGeometryFromWkt("POINT (114.3 30.59)"))
layer.CreateFeature(feature)
shapefile = None
os.remove("统计.cpg")

package = ogr.GetDriverByName("GPKG").CreateDataSource("multi.gpkg")
points = package.CreateLayer("points", wgs84, ogr.wkbPoint)
feature = ogr.Feature(points.GetLayerDefn())
feature.SetGeometry(ogr.CreateGeometryFromWkt("POINT (114.3 30.59)"))
points.CreateFeature(feature)
table = package.CreateLayer("population", None, ogr.wkbNone)
table.CreateField(ogr.FieldDefn("pop", ogr.OFTInteger64))
feature = ogr.Feature(table.GetLayerDefn())
feature.SetField("pop", 668000)
table.CreateFeature(feature)
styles = package.CreateLayer("layer_styles", None, ogr.wkbNone)
styles.CreateField(ogr.FieldDefn("styleQML", ogr.OFTString))
package = None
memory = gdal.GetDriverByName("MEM").Create("", 4, 3, 1, gdal.GDT_Int16)
memory.SetGeoTransform([114, 0.01, 0, 31, 0, -0.01])
memory.SetSpatialRef(wgs84)
memory.GetRasterBand(1).WriteArray(__import__("numpy").arange(12, dtype="int16").reshape(3, 4))
gdal.Translate("multi.gpkg", memory, format="GPKG", creationOptions=["APPEND_SUBDATASET=YES", "RASTER_TABLE=dem"])
# As a GeoPackage QGIS has edited is left; reading one would put a -wal and a -shm beside it.
connection = sqlite3.connect("multi.gpkg")
connection.execute("PRAGMA journal_mode=WAL")
connection.close()
# As one another program holds open is left: its last change, a raster moved a degree east, only in the -wal. Two
# rasters, so each opens as a subdataset.
shutil.copy("multi.gpkg", "held.gpkg")
gdal.Translate("held.gpkg", memory, format="GPKG", creationOptions=["APPEND_SUBDATASET=YES", "RASTER_TABLE=slope"])
connection = sqlite3.connect("held.gpkg")
connection.execute("PRAGMA wal_autocheckpoint=0")
for table in ("gpkg_tile_matrix_set", "gpkg_contents"):
    connection.execute(f"UPDATE {table} SET min_x = min_x + 1, max_x = max_x + 1 WHERE table_name = 'dem'")
connection.commit()
shutil.copy("held.gpkg", "open.gpkg")
shutil.copy("held.gpkg-wal", "open.gpkg-wal")
connection.close()
for name in ("held.gpkg", "held.gpkg-wal", "held.gpkg-shm"):
    if os.path.exists(name):
        os.remove(name)

tif = gdal.GetDriverByName("GTiff").Create("landcover.tif", 4, 3, 1, gdal.GDT_Byte)
tif.SetGeoTransform([114, 0.01, 0, 31, 0, -0.01])
tif.SetSpatialRef(wgs84)
band = tif.GetRasterBand(1)
band.SetDescription("landcover")
colors = gdal.ColorTable()
colors.SetColorEntry(1, (0, 100, 0, 255))
colors.SetColorEntry(2, (250, 230, 160, 255))
band.SetColorTable(colors)
band.WriteArray(__import__("numpy").array([[1, 1, 1, 2], [1, 1, 2, 2], [9, 9, 2, 0]], dtype="uint8"))
tif = None
# No data kept only beside the raster, and statistics QGIS once cached, approximate and wrong.
with open("landcover.tif.aux.xml", "w") as aux:
    aux.write('<PAMDataset><PAMRasterBand band="1"><NoDataValue>0</NoDataValue><Metadata><MDI key="STATISTICS_APPROXIMATE">YES</MDI><MDI key="STATISTICS_MAXIMUM">2</MDI><MDI key="STATISTICS_MINIMUM">1</MDI><MDI key="STATISTICS_MEAN">1.5</MDI><MDI key="STATISTICS_STDDEV">0.5</MDI></Metadata></PAMRasterBand></PAMDataset>')

gml = ogr.GetDriverByName("GML").CreateDataSource("roads.gml", options=["XSISCHEMA=OFF"])
roads = gml.CreateLayer("roads", wgs84, ogr.wkbLineString)
feature = ogr.Feature(roads.GetLayerDefn())
feature.SetGeometry(ogr.CreateGeometryFromWkt("LINESTRING (114.25 30.55, 114.35 30.62)"))
roads.CreateFeature(feature)
gml = None

blank = gdal.GetDriverByName("GTiff").Create("blank.tif", 3, 3, 1, gdal.GDT_Float32)
blank.SetGeoTransform([114, 0.01, 0, 31, 0, -0.01])
blank.SetSpatialRef(wgs84)
blank.GetRasterBand(1).SetNoDataValue(-1)
blank.GetRasterBand(1).Fill(-1)
blank = None

with open("broken.vrt", "w") as vrt:
    vrt.write('<VRTDataset rasterXSize="3" rasterYSize="3"><SRS>EPSG:4326</SRS><GeoTransform>114, 0.01, 0, 31, 0, -0.01</GeoTransform><VRTRasterBand dataType="Byte" band="1"><SimpleSource><SourceFilename relativeToVRT="1">gone.tif</SourceFilename><SourceBand>1</SourceBand></SimpleSource></VRTRasterBand></VRTDataset>')

png = gdal.GetDriverByName("MEM").Create("", 2, 2, 3, gdal.GDT_Byte)
gdal.GetDriverByName("PNG").CreateCopy("photo.png", png)
`
  execFileSync(located.install.interpreter, ["-c", script, directory], {
    env: { ...Runtime.base(process.env, process.platform), ...Macos.environment(located.install) },
    stdio: ["ignore", "ignore", "pipe"],
  })
}
