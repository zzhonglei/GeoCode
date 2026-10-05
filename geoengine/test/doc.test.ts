import assert from "node:assert/strict"
import { test } from "node:test"
import { Catalog } from "../src/qgis/catalog.ts"
import { Doc } from "../src/qgis/doc.ts"

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

const NUMBER_ACCEPTS = [
  "A numeric value",
  "field:FIELD_NAME to use a data defined value taken from the FIELD_NAME field",
  "expression:SOME EXPRESSION to use a data defined value calculated using a custom QGIS expression",
]

const catalog: Catalog.Catalog = {
  ok: true,
  qgis: "3.44.15-Solothurn",
  algorithms: [
    algorithm({
      id: "native:buffer",
      name: "Buffer",
      description: "Computes a buffer area for all the features in an input layer.",
      help: "This algorithm computes a buffer area.",
      tags: ["offset"],
      notes: 2 | 4,
      parameters: [
        parameter({ name: "INPUT", description: "Input layer", type: "source", accepted: ["Path to a vector layer"] }),
        parameter({ name: "DISTANCE", type: "distance", default: 10, parent: "INPUT", accepted: NUMBER_ACCEPTS }),
        parameter({
          name: "END_CAP_STYLE",
          type: "enum",
          default: 0,
          options: ["Round", "Flat"],
          accepted: ["Number of selected option, e.g. '1'"],
        }),
        parameter({
          name: "ENCODING",
          type: "enum",
          default: "UTF-8",
          options: ["UTF-8", "ISO-8859-1"],
          static: true,
          accepted: ["Number of selected option, e.g. '1'"],
        }),
        parameter({ name: "DISSOLVE", type: "boolean", default: false, help: "Merges the result." }),
        parameter({ name: "EXTRA", type: "string", default: "", optional: true, advanced: true }),
        parameter({ name: "OUTPUT", description: "Buffered", type: "sink", destination: true }),
      ],
      outputs: [{ name: "OUTPUT", type: "outputVector", description: "Buffered" }],
    }),
    algorithm({
      id: "native:joinattributesbylocation",
      name: "Join attributes by location",
      group: "Vector general",
      tags: ["join", "intersects"],
      parameters: [
        parameter({
          name: "PREDICATE",
          type: "enum",
          default: [0, 1],
          options: ["intersect", "contain"],
          multiple: true,
        }),
        parameter({ name: "JOIN_FIELDS", type: "field", parent: "JOIN", multiple: true, optional: true }),
        parameter({ name: "FORMULA", type: "expression", parent: "JOIN" }),
        parameter({ name: "BAND", type: "band", parent: "RASTER" }),
      ],
    }),
    algorithm({ id: "gdal:slope", name: "Slope", group: "Raster analysis" }),
    algorithm({ id: "native:slope", name: "Slope", group: "Raster terrain analysis", description: "Terrain slope." }),
    algorithm({ id: "native:centroids", name: "Centroids", description: "Creates a point layer of centroids." }),
    algorithm({ id: "qgis:orphan", name: "Orphan", group: "" }),
  ],
  excluded: [{ id: "native:selectbyexpression", name: "Select by expression" }],
}

test("an algorithm is found however the caller spells its ID or name", () => {
  for (const text of [
    "native:buffer",
    "NATIVE:BUFFER",
    "native_buffer",
    "buffer",
    "Buffer",
    " join attributes by location ",
  ]) {
    assert.equal(Catalog.resolve(catalog, text).kind, "found", text)
  }
  const found = Catalog.resolve(catalog, "Join_Attributes_By_Location")
  assert.ok(found.kind === "found" && found.algorithm.id === "native:joinattributesbylocation")
})

test("a name shared by several algorithms is answered with all of them, never one picked", () => {
  const resolution = Catalog.resolve(catalog, "slope")
  assert.ok(resolution.kind === "ambiguous")
  assert.deepEqual(
    resolution.candidates.map((candidate) => candidate.id),
    ["gdal:slope", "native:slope"],
  )
  // Guards against refusing the full ID along with the name it shares.
  assert.equal(Catalog.resolve(catalog, "gdal:slope").kind, "found")
})

test("an algorithm left out for needing QGIS's interface is told apart from one that does not exist", () => {
  assert.equal(Catalog.resolve(catalog, "selectbyexpression").kind, "excluded")
  const missing = Catalog.resolve(catalog, "bufer")
  assert.ok(missing.kind === "missing")
  assert.deepEqual(
    missing.suggestions.map((candidate) => candidate.id),
    ["native:buffer"],
  )
  // Guards against GeoAgent reading why QGIS leaves an algorithm out, which it can do nothing with.
  assert.equal(Doc.help(catalog, "native:selectbyexpression"), "native:selectbyexpression is not available.")
  assert.equal(
    Doc.help(catalog, "bufer"),
    'There is no algorithm "bufer".\nSimilar IDs:\n' +
      "native:buffer — Buffer (Vector geometry): Computes a buffer area for all the features in an input layer.\n" +
      'Use action "search" to find algorithms.',
  )
  assert.equal(
    Doc.help(catalog, "slope"),
    '"slope" names several algorithms. Call again with one of these IDs:\n' +
      "gdal:slope — Slope (Raster analysis)\nnative:slope — Slope (Raster terrain analysis): Terrain slope.",
  )
})

test("an ID from a release that put the algorithm under another provider is not taken for it", () => {
  // Guards against calling missing an algorithm left out under the provider another release gives it.
  const resolution = Catalog.resolve(catalog, "qgis:selectbyexpression")
  assert.ok(resolution.kind === "excluded" && resolution.id === "native:selectbyexpression")
  // Guards against documenting another provider's algorithm of the same name, whose parameters may differ.
  const moved = Catalog.resolve(catalog, "qgis:centroids")
  assert.ok(moved.kind === "missing")
  assert.deepEqual(
    moved.suggestions.map((candidate) => candidate.id),
    ["native:centroids"],
  )
})

test("search needs every word and ranks the name above tags above descriptions", () => {
  assert.deepEqual(
    Catalog.search(catalog, "join intersects").map((hit) => hit.id),
    ["native:joinattributesbylocation"],
  )
  // Guards against ranking a match in a description above the algorithm the word names.
  const hits = Catalog.search(catalog, "buffer").map((hit) => hit.id)
  assert.equal(hits[0], "native:buffer")
  assert.deepEqual(
    Catalog.search(catalog, "offset").map((hit) => hit.id),
    ["native:buffer"],
  )
  assert.deepEqual(
    Catalog.search(catalog, "centroids point").map((hit) => hit.id),
    ["native:centroids"],
  )
  assert.equal(Doc.search(catalog, "缓冲区"), 'No algorithm matches "缓冲区". Search with English keywords.')
})

test("a search with more hits than it shows says how many there are", () => {
  const many: Catalog.Catalog = {
    ...catalog,
    algorithms: Array.from({ length: Doc.SEARCH_LIMIT + 2 }, (_, index) =>
      algorithm({ id: `native:ring${index}`, name: `Ring ${index}` }),
    ),
  }
  const text = Doc.search(many, "ring")
  assert.ok(text.includes(`12 algorithms match "ring"; the first ${Doc.SEARCH_LIMIT}`))
  assert.equal(text.split("\n").filter((line) => line.startsWith("native:ring")).length, Doc.SEARCH_LIMIT)
})

test("groups list what they hold, an unnamed group included, and accept any spelling", () => {
  const text = Doc.groups(catalog)
  assert.ok(text.startsWith("QGIS 3.44.15-Solothurn\n\n5 groups, 6 algorithms:\n"))
  assert.ok(text.includes(`\n${Catalog.UNGROUPED} (1)`))
  assert.ok(text.includes("\nVector geometry (2)"))
  assert.ok(Doc.algorithms(catalog, "VECTOR_geometry").includes("native:centroids — Centroids: Creates a point layer"))
  // Guards against listing an unnamed group under a name that does not find it.
  assert.ok(Doc.algorithms(catalog, Catalog.UNGROUPED).includes("qgis:orphan — Orphan"))
  assert.ok(
    Doc.algorithms(catalog, "nothing").startsWith('There is no group "nothing". The groups are:\nRaster analysis\n'),
  )
})

test("an algorithm's documentation follows qgis_process help and adds what a call needs", () => {
  const text = Doc.help(catalog, "native:buffer")
  assert.ok(text.startsWith("QGIS 3.44.15-Solothurn\n\nBuffer (native:buffer)\n\n"))
  assert.ok(
    text.includes("Description\n----------------\nComputes a buffer area for all the features in an input layer.\n"),
  )
  assert.ok(text.includes(" - This algorithm may drop existing primary keys"))
  assert.ok(text.includes(" - This algorithm uses ellipsoid based measurements"))
  assert.ok(
    text.includes("DISTANCE: DISTANCE\n\tDefault value:\t10\n\tArgument type:\tdistance in the units of INPUT's CRS"),
  )
  // Guards against offering data-defined values, which only qgis_process converts.
  assert.ok(text.includes("\tAcceptable values:\n\t\t- A numeric value\nEND_CAP_STYLE"))
  assert.ok(!text.includes("field:FIELD_NAME"))
  assert.ok(text.includes("\tAvailable values:\n\t\t- 0: Round\n\t\t- 1: Flat"))
  // Guards against numbering the options of an enum that refuses numbers.
  assert.ok(
    text.includes(
      "ENCODING: ENCODING\n\tDefault value:\tUTF-8\n\tArgument type:\tenum\n\tAvailable values:\n" +
        "\t\t- UTF-8\n\t\t- ISO-8859-1\nDISSOLVE",
    ),
  )
  assert.ok(
    text.includes("DISSOLVE: DISSOLVE\n\tDefault value:\tfalse\n\tMerges the result.\n\tArgument type:\tboolean"),
  )
  // Guards against printing an empty default.
  assert.ok(text.includes("EXTRA: EXTRA (optional) (advanced)\n\tArgument type:\tstring"))
  assert.ok(text.includes("Outputs\n----------------\n\nOUTPUT: <outputVector>\n\tBuffered"))
  assert.ok(
    text.endsWith(
      "\n\nIf anything here is unclear or incomplete, read this algorithm's section of the official QGIS documentation:\n" +
        'webfetch(url="https://docs.qgis.org/3.44/en/docs/user_manual/processing_algs/qgis/vectorgeometry.html#buffer")',
    ),
  )
})

test("multiple values and the layer a parameter belongs to are stated, and a list default is printed", () => {
  const text = Doc.help(catalog, "native:joinattributesbylocation")
  assert.ok(
    text.includes("PREDICATE: PREDICATE\n\tDefault value:\t[0,1]\n\tArgument type:\tenum, multiple values allowed"),
  )
  assert.ok(
    text.includes("JOIN_FIELDS: JOIN_FIELDS (optional)\n\tArgument type:\tfield of JOIN, multiple values allowed"),
  )
  assert.ok(text.includes("\tArgument type:\texpression on JOIN"))
  assert.ok(text.includes("\tArgument type:\tband of RASTER"))
  // Guards against printing empty sections.
  assert.ok(!text.includes("Description") && !text.includes("Notes") && !text.includes("Outputs"))
})

test("the manual's link is the release's, slugs the display name, and goes to the index without a group", () => {
  assert.equal(
    Doc.docsUrl(
      algorithm({ id: "gdal:cliprasterbymasklayer", name: "Clip raster by mask layer", group: "Raster extraction" }),
      "4.2.3-Firenze",
    ),
    "https://docs.qgis.org/4.2/en/docs/user_manual/processing_algs/gdal/rasterextraction.html#clip-raster-by-mask-layer",
  )
  assert.equal(
    Doc.docsUrl(algorithm({ id: "native:orphan", name: "Orphan", group: "" }), "3.44.15-Solothurn"),
    "https://docs.qgis.org/3.44/en/docs/user_manual/processing_algs/index.html",
  )
  // Guards against a version QGIS words otherwise breaking the link.
  assert.equal(
    Doc.docsUrl(algorithm({ id: "native:orphan", name: "Orphan", group: "" }), "unknown"),
    "https://docs.qgis.org/latest/en/docs/user_manual/processing_algs/index.html",
  )
})

test("an action missing what it needs says what to pass, and nothing else", () => {
  assert.equal(
    Doc.answer(catalog, { action: "help" }),
    'Action "help" needs "algorithm", a full algorithm ID such as "native:buffer".',
  )
  assert.equal(
    Doc.answer(catalog, { action: "search", query: "  " }),
    'Action "search" needs "query", English keywords.',
  )
  assert.equal(
    Doc.answer(catalog, { action: "algorithms" }),
    'Action "algorithms" needs "group", a group name as action "groups" lists them.',
  )
  assert.ok(Doc.answer(catalog, { action: "groups", query: "ignored" }).includes("5 groups"))
})
