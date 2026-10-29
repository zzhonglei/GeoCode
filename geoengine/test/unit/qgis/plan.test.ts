import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { Catalog } from "../../../src/qgis/catalog.ts"
import { Plan } from "../../../src/qgis/plan.ts"

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

const tiles = algorithm({
  id: "native:tilesxyzdirectory",
  name: "Generate XYZ tiles (Directory)",
  parameters: [parameter({ name: "OUTPUT_DIRECTORY", type: "folderDestination", destination: true })],
})

const catalog: Catalog.Catalog = {
  ok: true,
  qgis: "4.2.3-Ushuaia",
  algorithms: [buffer, merge, tiles],
  excluded: [],
  vectorExtensions: ["gpkg", "shp", "geojson", "gpkg.zip"],
}

const located = (request: Plan.Request) => {
  const found = Plan.locate(catalog, request)
  assert.equal(found.kind, "located", found.kind === "refused" ? found.text : "")
  return found as Extract<Plan.Located, { kind: "located" }>
}

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

test("an output that would overwrite takes the first free name, a folder holding files too", async () => {
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
    // As is a GeoPackage another checked run adds a table to.
    const adding = await number(
      { algorithm: "native:buffer", parameters: { OUTPUT: "new.gpkg" } },
      [at("new.gpkg")],
      new Set([`${at("new.gpkg").toLowerCase()}|t`]),
    )
    assert.equal(adding.slots[0]!.file, at("new_1.gpkg"))

    // Guards against a rerun writing into the folder of the last, over its files and among them.
    const tiles = { algorithm: "native:tilesxyzdirectory", parameters: { OUTPUT_DIRECTORY: "tiles" } }
    const folder = await number(tiles, [directory])
    assert.deepEqual([folder.slots[0]!.file, folder.claimed], [`${directory}_1`, [`${directory}_1`.toLowerCase()]])
    await fs.mkdir(at("empty"))
    assert.equal((await number(tiles, [at("empty")])).slots[0]!.file, at("empty"))
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
  // Guards against the GeoPackage not being asked for its tables, which leaves nothing to number against.
  assert.deepEqual(Plan.survey(found).request.tables, ["/w/db.gpkg"])
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

// Guards against checking another name than QGIS writes, which leaves the file it writes to be overwritten.
test("a vector output is named as QGIS will name it, with .gpkg added where QGIS knows no extension", () => {
  const file = (OUTPUT: string) => located({ algorithm: "native:buffer", parameters: { OUTPUT } }).slots[0]!.file
  assert.equal(file("result"), "result.gpkg")
  assert.equal(file("roads.v2"), "roads.v2.gpkg")
  assert.equal(file("roads.v2.SHP"), "roads.v2.SHP")
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
