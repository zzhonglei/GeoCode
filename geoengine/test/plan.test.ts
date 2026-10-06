import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { Catalog } from "../src/qgis/catalog.ts"
import { Plan } from "../src/qgis/plan.ts"

const parameter = (fields: Partial<Catalog.Parameter> & { name: string; type: string }): Catalog.Parameter => ({
  description: fields.name,
  optional: false,
  advanced: false,
  destination: false,
  help: "",
  default: null,
  accepted: [],
  ...fields,
})

const algorithm = (fields: Partial<Catalog.Algorithm> & { id: string; name: string }): Catalog.Algorithm => ({
  group: "Vector geometry",
  description: "",
  help: "",
  tags: [],
  notes: 0,
  parameters: [],
  outputs: [],
  ...fields,
})

const buffer = algorithm({
  id: "native:buffer",
  name: "Buffer",
  description: "Computes a buffer area.",
  translations: { "zh-CN": { name: "缓冲区", description: "计算缓冲区。" } },
  parameters: [
    parameter({ name: "INPUT", description: "Input layer", type: "source" }),
    parameter({ name: "DISTANCE", description: "Distance", type: "distance", default: 10 }),
    parameter({ name: "END_CAP_STYLE", type: "enum", default: 0, options: ["Round", "Flat"] }),
    parameter({ name: "DISSOLVE", type: "boolean", default: false }),
    parameter({ name: "FIELD_NAME", type: "string", optional: true }),
    parameter({ name: "OUTPUT", type: "sink", destination: true }),
  ],
})

const merge = algorithm({
  id: "native:mergevectorlayers",
  name: "Merge vector layers",
  parameters: [
    parameter({ name: "LAYERS", type: "multilayer" }),
    parameter({ name: "CRS", type: "crs", optional: true }),
    parameter({ name: "OUTPUT", type: "sink", destination: true }),
  ],
})

const warp = algorithm({
  id: "gdal:warpreproject",
  name: "Warp (reproject)",
  parameters: [
    parameter({ name: "INPUT", type: "raster" }),
    parameter({ name: "RESAMPLING", type: "enum", default: 0, options: ["Nearest Neighbour", "Bilinear"] }),
    parameter({ name: "OUTPUT", type: "rasterDestination", destination: true }),
  ],
})

const tiles = algorithm({
  id: "native:tilesxyzdirectory",
  name: "Generate XYZ tiles (Directory)",
  parameters: [parameter({ name: "OUTPUT_DIRECTORY", type: "folderDestination", destination: true })],
})

const catalog: Catalog.Catalog = {
  ok: true,
  qgis: "4.2.3-Ushuaia",
  algorithms: [buffer, merge, warp, tiles],
  excluded: [{ id: "native:openurl", name: "Open file or URL" }],
  vectorExtensions: ["gpkg", "shp", "geojson", "gpkg.zip"],
}

const located = (request: Plan.Request) => {
  const found = Plan.locate(catalog, request)
  assert.equal(found.kind, "located", found.kind === "refused" ? found.text : "")
  return found as Extract<Plan.Located, { kind: "located" }>
}

const refused = (request: Plan.Request) => {
  const found = Plan.locate(catalog, request)
  assert.equal(found.kind, "refused")
  return (found as Extract<Plan.Located, { kind: "refused" }>).text
}

test("an algorithm left out or not there is refused with what to do instead", () => {
  assert.equal(
    refused({ algorithm: "native:openurl", parameters: {} }),
    "QGIS 4.2.3-Ushuaia\n\nnative:openurl is not available.",
  )
  // Guards against guessing: a near spelling is offered, never run.
  assert.equal(
    refused({ algorithm: "native:bufer", parameters: {} }),
    'QGIS 4.2.3-Ushuaia\n\nThere is no algorithm "native:bufer".\nSimilar IDs:\n' +
      "native:buffer — Buffer (Vector geometry): Computes a buffer area.\n" +
      'Find algorithms with qgisdoc (action "search").',
  )
})

test("a parameter the algorithm does not have is refused, with its spelling when only the case differs", () => {
  assert.equal(
    refused({ algorithm: "native:buffer", parameters: { INPUT: "a.shp", DIST: 5, distance: 5 } }),
    "QGIS 4.2.3-Ushuaia\nnative:buffer — Buffer: Computes a buffer area.\n\n" +
      "native:buffer has no parameter DIST or distance, so nothing was run.\n" +
      "distance is written DISTANCE.\n" +
      "Its parameters are INPUT, DISTANCE, END_CAP_STYLE, DISSOLVE, FIELD_NAME, OUTPUT.",
  )
})

test("an output written to memory is refused, raster or vector", () => {
  assert.match(
    refused({ algorithm: "native:buffer", parameters: { INPUT: "a.shp", OUTPUT: "TEMPORARY_OUTPUT" } }),
    /\n\nOUTPUT is TEMPORARY_OUTPUT, which is lost when the run ends, so nothing was run\. Write it to a file, such as "result\.gpkg"\.$/,
  )
  assert.match(
    refused({ algorithm: "native:buffer", parameters: { OUTPUT: "memory:buffered" } }),
    /OUTPUT is memory:buffered, which is lost/,
  )
  assert.match(
    refused({ algorithm: "gdal:warpreproject", parameters: { OUTPUT: "TEMPORARY_OUTPUT" } }),
    /such as "result\.tif"\.$/,
  )
  assert.match(
    refused({ algorithm: "gdal:warpreproject", parameters: { OUTPUT: "/vsimem/dem.tif" } }),
    /OUTPUT is \/vsimem\/dem\.tif, which is lost when the run ends, so nothing was run\. .* "result\.tif"\.$/,
  )
  // QGIS matches the keyword by case: in lower case it is a file of that name.
  assert.equal(
    Plan.locate(catalog, { algorithm: "native:buffer", parameters: { OUTPUT: "temporary_output" } }).kind,
    "located",
  )
})

test("files are found by the type of a parameter, never by what its value looks like", () => {
  const found = located({
    algorithm: "native:buffer",
    parameters: { INPUT: "roads.shp|layername=roads|subset=x", FIELD_NAME: "build.geojson", OUTPUT: "out.gpkg" },
  })
  assert.deepEqual(
    found.slots.map((slot) => [slot.parameter.name, slot.before, slot.file, slot.after]),
    [
      ["INPUT", "", "roads.shp", "|layername=roads|subset=x"],
      ["OUTPUT", "", "out.gpkg", ""],
    ],
  )
  const lists = located({
    algorithm: "native:mergevectorlayers",
    parameters: {
      LAYERS: [
        "a.geojson",
        "postgres:dbname=x",
        "https://example.com/wfs",
        "/vsizip/b.zip/c.shp",
        "memory:",
        7,
        // Any data source QGIS or GDAL knows by the text before a colon, not only the common ones.
        "oracle:dbname=orcl table=roads",
        "PG:dbname=gis",
        "d.shp|subset=time > '12:00'",
      ],
      CRS: "dem.tif",
      OUTPUT: "ogr:dbname='out folder/merged.gpkg' table=\"merged\" (geom)",
    },
  })
  assert.deepEqual(
    lists.slots.map((slot) => [slot.parameter.name, slot.index, slot.before, slot.file, slot.after]),
    [
      ["LAYERS", 0, "", "a.geojson", ""],
      ["LAYERS", 8, "", "d.shp", "|subset=time > '12:00'"],
      ["OUTPUT", undefined, "ogr:dbname='", "out folder/merged.gpkg", '\' table="merged" (geom)'],
    ],
  )
})

test("resolved files go back where they were found, the text around them kept", () => {
  const found = located({
    algorithm: "native:mergevectorlayers",
    parameters: { LAYERS: ["a.geojson", "postgres:dbname=x", "b.shp|layerid=0"], OUTPUT: "o.gpkg" },
  })
  const { parameters } = Plan.substitute(
    { LAYERS: ["a.geojson", "postgres:dbname=x", "b.shp|layerid=0"], OUTPUT: "o.gpkg" },
    found.slots,
    ["/w/a.geojson", "/w/b.shp", "/w/o.gpkg"],
  )
  assert.deepEqual(parameters, {
    LAYERS: ["/w/a.geojson", "postgres:dbname=x", "/w/b.shp|layerid=0"],
    OUTPUT: "/w/o.gpkg",
  })
})

test("only vector layers taken whole are surveyed, and a GeoPackage added to is asked for its tables", () => {
  const request = {
    algorithm: "native:mergevectorlayers",
    parameters: {
      LAYERS: ["a.geojson", "b.gpkg|layername=roads", "c.gpkg|layerid=2", "d.geojson|geometrytype=Point"],
      OUTPUT: "ogr:dbname='e.gpkg' table=\"t\" (geom)",
    },
  }
  const { slots } = Plan.substitute(request.parameters, located(request).slots, [
    "/w/a.geojson",
    "/w/b.gpkg",
    "/w/c.gpkg",
    "/w/d.geojson",
    "/w/e.gpkg",
  ])
  assert.deepEqual(Plan.survey(slots).request, {
    layers: [{ path: "/w/a.geojson" }, { path: "/w/b.gpkg", name: "roads" }, { path: "/w/c.gpkg", id: 2 }],
    tables: ["/w/e.gpkg"],
  })
  const raster = located({ algorithm: "gdal:warpreproject", parameters: { INPUT: "dem.tif", OUTPUT: "x.tif" } })
  assert.deepEqual(Plan.survey(raster.slots).request, { layers: [], tables: [] })
})

test("a layer mixing kinds of geometry is refused, naming the kinds it mixes and how to take each", () => {
  const found = located({
    algorithm: "native:mergevectorlayers",
    parameters: { LAYERS: ["mixed.geojson", "pts.geojson"] },
  })
  const reasons = Plan.mixed(found.slots, [["line", "point"], ["point"]])
  assert.deepEqual(reasons, [
    "mixed.geojson mixes points and lines in one layer, so nothing was run: QGIS would treat every feature as the geometry type of the first one.\n" +
      "Take one kind by adding |geometrytype=MultiPoint or |geometrytype=MultiLineString to the path, and run once for each kind you need. Features without geometry are left out.",
  ])
  assert.match(
    Plan.mixed(found.slots, [["collection", "line", "point", "polygon"], null])[0]!,
    /mixes points, lines, polygons and geometry collections in one layer/,
  )
})

test("an output that would overwrite takes the first free name; folders keep theirs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-plan-"))
  try {
    for (const name of ["OUT.gpkg", "out_1.gpkg", "roads.dbf", "dem.tif"])
      await fs.writeFile(path.join(directory, name), "")
    const at = (name: string) => path.join(directory, name)
    const number = async (request: Plan.Request, files: string[], reserved = new Set<string>()) => {
      const { slots } = Plan.substitute(request.parameters, located(request).slots, files)
      return Plan.number(slots, new Map(), reserved)
    }

    // Guards against comparing by case: macOS and Windows find OUT.gpkg under out.gpkg.
    const gpkg = await number({ algorithm: "native:buffer", parameters: { INPUT: "in.shp", OUTPUT: "out.gpkg" } }, [
      at("in.shp"),
      at("out.gpkg"),
    ])
    assert.deepEqual(
      gpkg.slots.map((slot) => slot.file),
      [at("in.shp"), at("out_2.gpkg")],
    )
    assert.deepEqual(gpkg.claimed, [at("out_2.gpkg").toLowerCase()])

    // A Shapefile is taken by any one of its files.
    const shp = await number({ algorithm: "native:buffer", parameters: { OUTPUT: "roads.shp" } }, [at("roads.shp")])
    assert.equal(shp.slots[0]!.file, at("roads_1.shp"))

    const free = await number({ algorithm: "native:buffer", parameters: { OUTPUT: "new.gpkg" } }, [at("new.gpkg")])
    assert.equal(free.slots[0]!.file, at("new.gpkg"))

    // A name another checked run holds is taken too.
    const held = await number(
      { algorithm: "native:buffer", parameters: { OUTPUT: "new.gpkg" } },
      [at("new.gpkg")],
      new Set([at("new.gpkg").toLowerCase()]),
    )
    assert.equal(held.slots[0]!.file, at("new_1.gpkg"))

    const folder = await number({ algorithm: "native:tilesxyzdirectory", parameters: { OUTPUT_DIRECTORY: "tiles" } }, [
      directory,
    ])
    assert.deepEqual([folder.slots[0]!.file, folder.claimed], [directory, []])
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("a table added to a GeoPackage that has it takes the first free table name", async () => {
  const request = {
    algorithm: "native:buffer",
    parameters: { OUTPUT: "ogr:dbname='/w/db.gpkg' table=\"Roads\" (geom)" },
  }
  const found = located(request).slots
  const numbered = await Plan.number(found, new Map([["/w/db.gpkg", ["roads", "Roads_1"]]]), new Set())
  assert.equal(numbered.slots[0]!.after, '\' table="Roads_2" (geom)')
  assert.deepEqual(numbered.claimed, ["/w/db.gpkg|roads_2"])
  const fresh = await Plan.number(found, new Map([["/w/db.gpkg", null]]), new Set())
  assert.equal(fresh.slots[0]!.after, '\' table="Roads" (geom)')
})

// Guards against finding a name inside its own key: a table "t" sits in "table=", a file "db" in "dbname=".
test("names in an ogr: connection are replaced where they stand, and an unquoted file goes back quoted", async () => {
  const value = 'ogr:dbname=db table="t" (geom)'
  const request = { algorithm: "native:buffer", parameters: { OUTPUT: value } }
  const { parameters, slots } = Plan.substitute(request.parameters, located(request).slots, ["/w/My Project/db"])
  assert.equal(parameters.OUTPUT, "ogr:dbname='/w/My Project/db' table=\"t\" (geom)")
  const numbered = await Plan.number(slots, new Map([["/w/My Project/db", ["t"]]]), new Set())
  const plan = Plan.plan(catalog, buffer, request, numbered)
  assert.equal(plan.parameters.OUTPUT, "ogr:dbname='/w/My Project/db' table=\"t_1\" (geom)")
  // The run finds again, in what it runs, the names its check took, so it lets them go.
  const again = Plan.locate(catalog, { algorithm: "native:buffer", parameters: plan.parameters })
  assert.ok(again.kind === "located")
  assert.deepEqual(Plan.claims(again.slots), numbered.claimed)
  assert.deepEqual(numbered.claimed, ["/w/my project/db|t_1"])
})

// Guards against a table QGIS writes escaping the check, named before the file or not named at all.
test("an ogr: table is found before or after the file, or is the one QGIS names after the file", async () => {
  const number = async (OUTPUT: string, tables: string[]) => {
    const request = { algorithm: "native:buffer", parameters: { OUTPUT } }
    const numbered = await Plan.number(located(request).slots, new Map([["/w/db.gpkg", tables]]), new Set())
    return [Plan.plan(catalog, buffer, request, numbered).parameters.OUTPUT, numbered.claimed]
  }
  assert.deepEqual(await number(`ogr:table="first" dbname='/w/db.gpkg' (geom)`, ["first"]), [
    `ogr:table="first_1" dbname='/w/db.gpkg' (geom)`,
    ["/w/db.gpkg|first_1"],
  ])
  assert.deepEqual(await number("ogr:dbname='/w/db.gpkg'", ["db"]), [
    `ogr:dbname='/w/db.gpkg' table="db_1"`,
    ["/w/db.gpkg|db_1"],
  ])
  assert.deepEqual(await number("ogr:dbname='/w/db.gpkg'", ["other"]), ["ogr:dbname='/w/db.gpkg'", ["/w/db.gpkg|db"]])
})

// Guards against a quote in a path ending the value it is written in.
test("a file in an ogr: connection is read and written back with QGIS's escapes", () => {
  const request = {
    algorithm: "native:buffer",
    parameters: { OUTPUT: String.raw`ogr:dbname='/w/Lei\'s GIS/a\\b.gpkg' table="t"` },
  }
  const slots = located(request).slots
  assert.equal(slots[0]!.file, String.raw`/w/Lei's GIS/a\b.gpkg`)
  const { parameters } = Plan.substitute(request.parameters, slots, ["/x/It's/db.gpkg"])
  assert.equal(parameters.OUTPUT, String.raw`ogr:dbname='/x/It\'s/db.gpkg' table="t"`)
})

test("a vector output is named as QGIS will name it, with .gpkg added where QGIS knows no extension", () => {
  const file = (algorithm: string, OUTPUT: string) => located({ algorithm, parameters: { OUTPUT } }).slots[0]!.file
  assert.equal(file("native:buffer", "result"), "result.gpkg")
  assert.equal(file("native:buffer", "roads.v2"), "roads.v2.gpkg")
  assert.equal(file("native:buffer", "roads.v2.SHP"), "roads.v2.SHP")
  assert.equal(file("native:buffer", "a.gpkg.zip"), "a.gpkg.zip")
  // A raster output without one QGIS refuses itself.
  assert.equal(file("gdal:warpreproject", "dem"), "dem")
})

test("a file another checked run adds a table to is taken, and a GeoPackage added to is no half-written output", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-plan-"))
  try {
    const gpkg = path.join(directory, "x.gpkg")
    const request = { algorithm: "native:buffer", parameters: { OUTPUT: "x.gpkg" } }
    const { slots } = Plan.substitute(request.parameters, located(request).slots, [gpkg])
    const numbered = await Plan.number(slots, new Map(), new Set([`${gpkg.toLowerCase()}|t`]))
    assert.equal(numbered.slots[0]!.file, path.join(directory, "x_1.gpkg"))

    await fs.writeFile(gpkg, "")
    const table = { algorithm: "native:buffer", parameters: { OUTPUT: `ogr:dbname='${gpkg}' table="t"` } }
    assert.deepEqual(await Plan.written(located(table).slots), [])
    assert.deepEqual(await Plan.written(located({ ...table, parameters: { OUTPUT: gpkg } }).slots), [gpkg])
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("a plan holds the run as checked, and says which defaults it runs on", async () => {
  const request = { algorithm: "native:buffer", parameters: { INPUT: "in.shp", DISTANCE: 5, OUTPUT: "out.gpkg" } }
  const { slots } = Plan.substitute(request.parameters, located(request).slots, ["/w/in.shp", "/w/out.gpkg"])
  const plan = Plan.plan(catalog, buffer, request, {
    slots: [slots[0]!, { ...slots[1]!, file: "/w/out_1.gpkg" }],
    claimed: [],
  })
  assert.equal(
    plan.header,
    "QGIS 4.2.3-Ushuaia\nnative:buffer — Buffer: Computes a buffer area.\n" +
      "Defaults used: END_CAP_STYLE=0 (Round), DISSOLVE=false",
  )
  assert.deepEqual(plan.parameters, { INPUT: "/w/in.shp", DISTANCE: 5, OUTPUT: "/w/out_1.gpkg" })
  assert.deepEqual(plan.inputs, [{ name: "INPUT", value: "/w/in.shp" }])
  assert.deepEqual(plan.options, [{ name: "DISTANCE", value: 5 }])
  assert.deepEqual(plan.outputs, [{ name: "OUTPUT", value: "/w/out_1.gpkg", files: ["/w/out_1.gpkg"], folder: false }])
  assert.deepEqual(plan.algorithm.translations, { "zh-CN": { name: "缓冲区", description: "计算缓冲区。" } })
})

// Guards against "always allow" for one table of a database reaching another database, or one table only.
test("an output that is no file says where it writes: a database by its connection, anything else as written", () => {
  const place = (OUTPUT: string) => {
    const request = { algorithm: "native:buffer", parameters: { INPUT: "in.shp", OUTPUT } }
    const plan = Plan.plan(catalog, buffer, request, { slots: located(request).slots, claimed: [] })
    return plan.outputs.map((output) => [output.files, output.place])
  }
  assert.deepEqual(place(`postgis:dbname='gis' host=db.local port=5432 table="public"."roads" (geom)`), [
    [[], "postgres: host=db.local port=5432 dbname=gis"],
  ])
  assert.deepEqual(place(`PG:host=db.local port=5432 dbname="gis" user=lei`), [
    [[], "postgres: host=db.local port=5432 dbname=gis"],
  ])
  assert.deepEqual(place(`spatialite:dbname='/data/a b.sqlite' table="roads" (geom)`), [
    [[], "spatialite: dbname=/data/a b.sqlite"],
  ])
  assert.deepEqual(place("/vsizip/out.zip/roads.shp"), [[[], "/vsizip/out.zip/roads.shp"]])
  assert.deepEqual(place("out.gpkg"), [[["out.gpkg"], undefined]])
})

test("only the CRS values given are asked about, and one QGIS does not read is refused as QGIS words its forms", () => {
  const assign = algorithm({
    id: "native:assignprojection",
    name: "Assign projection",
    parameters: [
      parameter({ name: "INPUT", type: "source" }),
      parameter({ name: "CRS", type: "crs", accepted: ["CRS as an auth ID (e.g. 'EPSG:3111')"] }),
      parameter({ name: "OTHER_CRS", type: "crs", optional: true }),
      parameter({ name: "LAST_CRS", type: "crs", optional: true }),
    ],
  })
  const given = Plan.coordinateSystems(assign, { INPUT: "a.shp", CRS: "+proj=longlat", OTHER_CRS: "", LAST_CRS: 4326 })
  assert.deepEqual(
    given.map((entry) => [entry.parameter.name, entry.value]),
    [
      ["CRS", "+proj=longlat"],
      ["LAST_CRS", 4326],
    ],
  )
  assert.deepEqual(Plan.unread(given, [false, false]), [
    'CRS is "+proj=longlat", which QGIS does not read as a coordinate reference system, so nothing was run: QGIS ' +
      "would run as if it were not given.\nQGIS accepts:\n- CRS as an auth ID (e.g. 'EPSG:3111')",
    "LAST_CRS is 4326, which QGIS does not read as a coordinate reference system, so nothing was run: QGIS would " +
      "run as if it were not given.",
  ])
  assert.deepEqual(Plan.unread(given, [true, true]), [])
})

test("the end of an answer says how the run ended, and what of its outputs is left", () => {
  assert.equal(
    Plan.finished(7240, { OUTPUT: "/w/out.gpkg", COUNT: 3 }),
    "Finished in 7 s.\nOutputs:\n- OUTPUT: /w/out.gpkg\n- COUNT: 3",
  )
  assert.equal(Plan.finished(30, {}), "Finished in 0.1 s.")
  const named = new Set(Plan.named(buffer, "Unable to execute algorithm\nIncorrect parameter value for DISTANCE"))
  assert.equal(
    Plan.failed(420, buffer, named, ["/w/out.gpkg"]),
    "Failed after 0.4 s.\nDISTANCE: Distance (distance, default 10)\nThese outputs may be incomplete:\n- /w/out.gpkg",
  )
  // Guards against naming a parameter a longer name merely contains.
  assert.deepEqual(Plan.named(buffer, "Could not load INPUT_LAYER"), [])
  assert.equal(Plan.failed(1500, buffer, new Set(), []), "Failed after 2 s.")
  assert.equal(Plan.crashed(5000, []), "QGIS exited unexpectedly after 5 s.")
})
