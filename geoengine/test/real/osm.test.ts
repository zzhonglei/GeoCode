import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { isDeepStrictEqual } from "node:util"
import { Environment } from "../../src/python/index.ts"
import {
  answer,
  counts,
  instanceOf,
  isProbe,
  queriesOf,
  serve,
  start,
  waitedOn,
  type Asked,
  type Reply,
} from "../support/osm.ts"

/**
 * Downloads on the base environment GeoCode installed in its data directory, or in the one GEOENGINE_OSM_DATA names:
 * its shapely and GDAL assemble and write what the fake services answer. Nothing goes to OSM's servers.
 */
const data =
  process.env.GEOENGINE_OSM_DATA ??
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "geocode")
const base = Environment.layout(data).basePython
const missing = await fs.access(base).then(
  () => false,
  () => `start GeoCode once, to install its base environment in ${data}`,
)

/** The layers of a GeoPackage, each with its features' attributes and geometry as WKT, and its description. */
const read = (file: string) => {
  const script = [
    "import json, sqlite3, sys, pyogrio",
    "path = sys.argv[1]",
    "out = {}",
    "for name, _ in pyogrio.list_layers(path):",
    "    frame = pyogrio.read_dataframe(path, layer=name)",
    "    rows = json.loads(frame.drop(columns='geometry').to_json(orient='records', force_ascii=False))",
    "    out[name] = {'crs': frame.crs.to_string(), 'rows': rows, 'wkt': [shape.wkt for shape in frame.geometry]}",
    "out['descriptions'] = [row[0] for row in sqlite3.connect(path).execute('select description from gpkg_contents')]",
    "print(json.dumps(out, ensure_ascii=False))",
  ].join("\n")
  return JSON.parse(execFileSync(base, ["-I", "-c", script, file], { encoding: "utf-8" })) as Record<string, any>
}

const ring = (points: readonly (readonly [number, number])[]) => points.map(([lat, lon]) => ({ lat, lon }))
const square = (south: number, west: number, north: number, east: number) =>
  ring([
    [south, west],
    [south, east],
    [north, east],
    [north, west],
    [south, west],
  ])
const building = (id: number, south: number, west: number, north: number, east: number) => ({
  type: "way",
  id,
  tags: { building: "yes", name: `B${id}` },
  geometry: square(south, west, north, east),
})

/** Overpass counting `total` for every count, and answering a download with `elements`. */
const overpass =
  (total: number, elements: readonly unknown[]) =>
  (query: string): Reply =>
    query.includes("out count") ? counts(total) : answer(elements)

test(
  "a download from a boundary with a hole keeps what lies inside it, whole, and nothing in the hole",
  { skip: missing },
  async () => {
    // A square boundary, 0 to 1 degrees, with a hole from 0.4 to 0.6, as a file the area names.
    const boundary = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
                [0, 0],
              ],
              [
                [0.4, 0.4],
                [0.6, 0.4],
                [0.6, 0.6],
                [0.4, 0.6],
                [0.4, 0.4],
              ],
            ],
          },
        },
      ],
    }
    const lake = {
      type: "relation",
      id: 9,
      tags: { type: "multipolygon", natural: "water", name: "湖" },
      members: [
        { type: "way", ref: 91, role: "outer", geometry: square(0.1, 0.1, 0.3, 0.3) },
        { type: "way", ref: 92, role: "inner", geometry: square(0.15, 0.15, 0.2, 0.2) },
      ],
    }
    const elements = [
      building(1, 0.1, 0.7, 0.2, 0.8),
      building(2, 0.45, 0.45, 0.55, 0.55),
      building(3, 0.9, 0.9, 1.1, 1.1),
    ]
    const services = await serve({ overpass: overpass(4, [...elements, building(4, 2, 2, 2.1, 2.1), lake]) })
    const engine = await start(base, services.services)
    try {
      const file = path.join(engine.directory, "area.geojson")
      await fs.writeFile(file, JSON.stringify(boundary))
      const done = await engine.call("features", {
        area: `file:${file}`,
        tags: ["building", "natural=water"],
        fields: ["*", "name:en"],
        output: path.join(engine.directory, "out.gpkg"),
      })
      assert.ok(done.ok, JSON.stringify(done))
      const layers = read((done.result as { path: string }).path)
      const polygons = layers.polygons
      assert.equal(polygons.crs, "EPSG:4326")
      // Guards against a hole taken as part of the area, and against cutting what crosses its edge.
      assert.deepEqual(polygons.rows.map((row: { osm_id: string }) => row.osm_id).sort(), ["R9", "W1", "W3"])
      const crossing = polygons.wkt[polygons.rows.findIndex((row: { osm_id: string }) => row.osm_id === "W3")]
      assert.match(crossing, /1\.1 1\.1/)
      // Guards against a multipolygon losing its inner ring.
      const water = polygons.wkt[polygons.rows.findIndex((row: { osm_id: string }) => row.osm_id === "R9")]
      assert.equal(water.split("), (").length, 2, water)
      // Guards against "*" keeping every tag only when asked alone.
      assert.ok("osm_tags" in polygons.rows[0], JSON.stringify(polygons.rows[0]))
      assert.match(layers.descriptions[0], /OpenStreetMap contributors/)
      // Guards against a file others may open telling where its boundary lay on this computer.
      assert.match(layers.descriptions[0], /file:area\.geojson/)
      assert.ok(!layers.descriptions[0].includes(engine.directory), layers.descriptions[0])
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "points of interest come as one point inside each, mapped as an area or not, in a file of their own",
  { skip: missing },
  async () => {
    // An L-shaped school, whose centroid lies outside it, and a café mapped as a point.
    const school = {
      type: "way",
      id: 1,
      tags: { amenity: "school", name: "學校" },
      geometry: ring([
        [0, 0],
        [0, 2],
        [0.2, 2],
        [0.2, 0.2],
        [2, 0.2],
        [2, 0],
        [0, 0],
      ]),
    }
    const cafe = { type: "node", id: 2, lat: 0.5, lon: 0.5, tags: { amenity: "cafe", name: "咖啡" } }
    const services = await serve({ overpass: overpass(2, [school, cafe]) })
    const engine = await start(base, services.services)
    try {
      const output = path.join(engine.directory, "poi.gpkg")
      // The name taken: the download goes beside it, the file there untouched.
      await fs.writeFile(output, "not a GeoPackage")
      const done = await engine.call("features", {
        area: "bbox:-1,-1,3,3",
        tags: ["amenity"],
        geometry: "point",
        output,
      })
      assert.ok(done.ok, JSON.stringify(done))
      const written = (done.result as { path: string }).path
      assert.equal(path.basename(written), "poi_1.gpkg")
      assert.equal(await fs.readFile(output, "utf-8"), "not a GeoPackage")
      const layers = read(written)
      assert.deepEqual(Object.keys(layers).sort(), ["descriptions", "points"])
      const rows = layers.points.rows as { osm_id: string; original_geometry: string }[]
      assert.deepEqual(rows.map((row) => [row.osm_id, row.original_geometry]).sort(), [
        ["N2", "point"],
        ["W1", "area"],
      ])
      const inside = layers.points.wkt[rows.findIndex((row) => row.osm_id === "W1")]
      const [x, y] = /POINT \(([-\d.e]+) ([-\d.e]+)\)/.exec(inside)!.slice(1).map(Number)
      assert.ok((x <= 2 && y <= 0.2) || (x <= 0.2 && y <= 2), inside)
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "a download too large for one request is split into parts, downloaded on several instances at once, each kept once",
  { skip: missing },
  async () => {
    // 120,000 features in all, 30,000 a quarter: each quarter is downloaded on its own.
    const quarter = /\)\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\);/
    const services = await serve({
      overpass: (query) => {
        if (isProbe(query)) return answer([])
        const box = quarter.exec(query)
        if (query.includes("out count")) return counts(box ? 30000 : 120000)
        const [south, west] = box!.slice(1).map(Number)
        // One building in the south-west quarter, and one across its edge with the south-east, which both answer.
        const elements =
          south === 0 && west === 0
            ? [building(1, 0.1, 0.1, 0.2, 0.2), building(2, 0.1, 0.4, 0.2, 0.6)]
            : south === 0
              ? [building(2, 0.1, 0.4, 0.2, 0.6)]
              : []
        // Long enough to tell parts downloaded at once from parts downloaded in turn.
        return { after: 600, reply: answer(elements) }
      },
    })
    const engine = await start(base, services.services)
    try {
      const id = engine.send("features", {
        area: "bbox:0,0,1,1",
        tags: ["building"],
        output: path.join(engine.directory, "buildings.gpkg"),
      })
      const done = await engine.response(id)
      assert.ok(done.ok, JSON.stringify(done))
      assert.deepEqual((done.result as { layers: object }).layers, { polygons: 2 })
      const downloads = services.asked.filter((request) => request.query.includes("out geom"))
      assert.equal(downloads.length, 4)
      // Guards against the parts going one at a time to one instance, or several at once to the same one.
      assert.ok(new Set(downloads.map(instanceOf)).size > 1, JSON.stringify(downloads.map(instanceOf)))
      assert.ok(downloads[1].at - downloads[0].at < 300, JSON.stringify(downloads.map((request) => request.at)))
      for (const [index, request] of downloads.entries()) {
        const before = downloads.slice(0, index).filter((other) => instanceOf(other) === instanceOf(request))
        assert.ok(
          before.every((other) => request.at - other.at >= 590),
          JSON.stringify(downloads.map(instanceOf)),
        )
      }
      const shown = engine.sent.flatMap((message) =>
        message.type === "progress" && message.id === id ? [(message.data as { osm: object }).osm] : [],
      )
      assert.ok(
        shown.some((event) => isDeepStrictEqual(event, { type: "counted", features: 120000, parts: 4 })),
        JSON.stringify(shown),
      )
      assert.ok(
        shown.some((event) => isDeepStrictEqual(event, { type: "part", part: 4, parts: 4 })),
        JSON.stringify(shown),
      )
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "a download too large for OSM's public servers is refused before anything is downloaded",
  { skip: missing },
  async () => {
    const services = await serve({ overpass: overpass(2_000_000, []) })
    const engine = await start(base, services.services)
    try {
      const output = path.join(engine.directory, "all.gpkg")
      const done = await engine.call("features", { area: "bbox:0,0,10,10", tags: ["building"], output })
      assert.ok(done.ok, JSON.stringify(done))
      assert.equal((done.result as { refused: number }).refused, 2_000_000)
      assert.ok(!services.asked.some((request) => request.query.includes("out geom")))
      await assert.rejects(fs.access(output))
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "a download whose whole area goes uncounted is still refused once its parts count too many",
  { skip: missing },
  async () => {
    // Two million features spread evenly over the box; the count of the whole times out on the server.
    const cell = /\)\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\);/
    const services = await serve({
      overpass: (query) => {
        const box = cell.exec(query)
        if (!box) return answer([], { remark: 'runtime error: Query timed out in "query" at line 1 after 61 seconds.' })
        const [south, west, north, east] = box.slice(1).map(Number)
        return counts(Math.round(2_000_000 * (north - south) * (east - west)))
      },
    })
    const engine = await start(base, services.services)
    try {
      const done = await engine.call("features", {
        area: "bbox:0,0,1,1",
        tags: ["building"],
        output: path.join(engine.directory, "all.gpkg"),
      })
      assert.ok(done.ok, JSON.stringify(done))
      assert.ok((done.result as { refused: number }).refused > 1_000_000, JSON.stringify(done.result))
      assert.ok(!services.asked.some((request) => request.query.includes("out geom")))
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "a download is still refused once its parts count too many, though one of them could not be counted",
  { skip: missing },
  async () => {
    // Two million features spread evenly over the box; the whole, and each part at its north-east corner, time out.
    const cell = /\)\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\);/
    const timedOut = answer([], { remark: 'runtime error: Query timed out in "query" at line 1 after 61 seconds.' })
    const services = await serve({
      overpass: (query) => {
        const box = cell.exec(query)
        if (!box) return timedOut
        const [south, west, north, east] = box.slice(1).map(Number)
        if (north === 1 && east === 1) return timedOut
        return counts(Math.round(2_000_000 * (north - south) * (east - west)))
      },
    })
    const engine = await start(base, services.services)
    try {
      const done = await engine.call("features", {
        area: "bbox:0,0,1,1",
        tags: ["building"],
        output: path.join(engine.directory, "all.gpkg"),
      })
      assert.ok(done.ok, JSON.stringify(done))
      // Guards against a part that could not be counted ending the count of the rest.
      assert.ok((done.result as { refused: number }).refused > 1_000_000, JSON.stringify(done.result))
      assert.ok(!services.asked.some((request) => request.query.includes("out geom")))
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "a download whose whole area was counted is not refused because its parts count more",
  { skip: missing },
  async () => {
    // 990,000 features in all, but each part counts what crosses its edges too: the parts add up to 1,040,000.
    const cell = /\)\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\);/
    const services = await serve({
      overpass: (query) => {
        if (!query.includes("out count")) return answer([])
        const box = cell.exec(query)
        if (!box) return counts(990_000)
        const [south, west, north, east] = box.slice(1).map(Number)
        return counts(Math.round(1_040_000 * (north - south) * (east - west)))
      },
    })
    const engine = await start(base, services.services)
    try {
      const done = await engine.call("features", {
        area: "bbox:0,0,1,1",
        tags: ["building"],
        output: path.join(engine.directory, "osm", "all.gpkg"),
      })
      assert.ok(done.ok, JSON.stringify(done))
      // Guards against the parts' sum, which counts a feature once for each part it lies in, outweighing the whole's.
      assert.ok(!("refused" in (done.result as object)), JSON.stringify(done.result))
      assert.ok(services.asked.some((request) => request.query.includes("out geom")))
      // Guards against a download that wrote nothing leaving the folder it would have written in.
      await assert.rejects(fs.access(path.join(engine.directory, "osm")))
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test("objects the server stopped early on are not taken for objects OSM lacks", { skip: missing }, async () => {
  const remark = "runtime error: Query run out of memory using about 2048 MB of RAM."
  const services = await serve({ overpass: () => answer([], { remark }) })
  const engine = await start(base, services.services)
  try {
    const done = await engine.call("objects", { ids: ["R1"], output: path.join(engine.directory, "o.gpkg") })
    assert.ok(done.ok, JSON.stringify(done))
    assert.deepEqual((done.result as { gaps: object[] }).gaps, [{ said: remark }])
  } finally {
    await engine.stop()
    await services.close()
  }
})

test(
  "a folder no file can be written in fails the download before anything is downloaded",
  { skip: missing },
  async () => {
    const services = await serve({ overpass: overpass(1, [building(1, 0.1, 0.1, 0.2, 0.2)]) })
    const engine = await start(base, services.services)
    const locked = path.join(engine.directory, "locked")
    await fs.mkdir(locked, { mode: 0o555 })
    try {
      for (const [method, params] of [
        ["objects", { ids: ["W1"] }],
        ["features", { area: "bbox:0,0,1,1", tags: ["building"] }],
      ] as const) {
        // In the folder, and in one still to be made inside it.
        for (const output of [path.join(locked, "out.gpkg"), path.join(locked, "osm", "out.gpkg")]) {
          const done = await engine.call(method, { ...params, output })
          // Guards against a download that ran its whole course, then failed as if GeoCode were broken.
          assert.equal(!done.ok && done.error.code, "unwritable", JSON.stringify(done))
        }
      }
      assert.deepEqual(services.asked, [])
    } finally {
      await fs.chmod(locked, 0o755)
      await engine.stop()
      await services.close()
    }
  },
)

test("around an object is the object itself and all within that distance of it", { skip: missing }, async () => {
  // A square of about 11 km, and 1 km around it: its middle, 5 km from its edge, is in; 10 km out is not.
  const square = building(5, 0, 0, 0.1, 0.1)
  const cafe = (id: number, lat: number, lon: number) => ({ type: "node", id, lat, lon, tags: { amenity: "cafe" } })
  const services = await serve({
    overpass: (query) => {
      if (!query.includes("nwr")) return answer([square])
      return query.includes("out count")
        ? counts(3)
        : answer([cafe(1, 0.05, 0.05), cafe(2, 0.105, 0.05), cafe(3, 0.2, 0.2)])
    },
  })
  const engine = await start(base, services.services)
  try {
    const done = await engine.call("features", {
      area: "around:W5,1000",
      tags: ["amenity"],
      output: path.join(engine.directory, "near.gpkg"),
    })
    assert.ok(done.ok, JSON.stringify(done))
    const rows = read((done.result as { path: string }).path).points.rows as { osm_id: string }[]
    // Guards against taking only a band on both sides of the object's edge, or everything the server answered.
    assert.deepEqual(rows.map((row) => row.osm_id).sort(), ["N1", "N2"])
  } finally {
    await engine.stop()
    await services.close()
  }
})

test("a part Overpass stops early on is downloaded again in quarters", { skip: missing }, async () => {
  const services = await serve({
    overpass: (query) => {
      if (query.includes("out count")) return counts(10)
      // The whole area times out on the server; each quarter answers.
      if (!/\)\([-\d.]+,[-\d.]+,[-\d.]+,[-\d.]+\);/.test(query)) {
        return answer([], { remark: 'runtime error: Query timed out in "query" at line 1 after 181 seconds.' })
      }
      return answer([building(1, 0.1, 0.1, 0.2, 0.2)])
    },
  })
  const engine = await start(base, services.services)
  try {
    const done = await engine.call("features", {
      area: "bbox:0,0,1,1",
      tags: ["building"],
      output: path.join(engine.directory, "b.gpkg"),
    })
    assert.ok(done.ok, JSON.stringify(done))
    // Guards against a part the server gave up on passing as complete, or being dropped.
    assert.deepEqual((done.result as { missing: string[] }).missing, [])
    assert.deepEqual((done.result as { layers: object }).layers, { polygons: 1 })
    assert.equal(services.asked.filter((request) => request.query.includes("out geom")).length, 5)
  } finally {
    await engine.stop()
    await services.close()
  }
})

/** Nominatim's answer to a lookup: a feature for each object it has, with its tags as Nominatim keeps them. */
const looked = (...features: readonly object[]): Reply => ({ json: { type: "FeatureCollection", features } })
const place = (kind: string, id: number, tag: string, geometry: object, extra: object = {}) => ({
  type: "Feature",
  properties: {
    osm_type: kind,
    osm_id: id,
    category: tag.split("=")[0],
    type: tag.split("=")[1],
    extratags: {},
    namedetails: {},
    ...extra,
  },
  geometry,
})
const polygon = (south: number, west: number, north: number, east: number) => ({
  type: "Polygon",
  coordinates: [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ],
})
const queries = (asked: readonly Asked[]) => queriesOf(asked).map((request) => request.query)

test(
  "an area by id is read from Nominatim, and Overpass asked only for the objects Nominatim lacks",
  { skip: missing },
  async () => {
    const services = await serve({
      nominatim: (where) =>
        where === "lookup"
          ? looked(place("relation", 10, "boundary=administrative", polygon(0, 0, 0.1, 0.1)))
          : { json: {} },
      overpass: (query) => {
        if (!query.includes("nwr")) return answer([building(20, 0.1, 0, 0.2, 0.1)])
        if (query.includes("out count")) return counts(2)
        return answer([building(1, 0.12, 0.01, 0.13, 0.02), building(2, 0.01, 0.01, 0.02, 0.02)])
      },
    })
    const engine = await start(base, services.services)
    try {
      const done = await engine.call("features", {
        area: "R10,W20",
        tags: ["building"],
        output: path.join(engine.directory, "two.gpkg"),
      })
      assert.ok(done.ok, JSON.stringify(done))
      assert.deepEqual((done.result as { layers: object }).layers, { polygons: 2 })
      const lookup = services.asked.find((request) => request.service === "nominatim" && request.where === "lookup")
      assert.equal(lookup?.params.get("osm_ids"), "R10,W20")
      // Guards against asking Overpass for an area Nominatim gave: it costs the busy servers a query.
      const objects = queries(services.asked).filter((query) => !query.includes("nwr"))
      assert.equal(objects.length, 1)
      assert.match(objects[0], /way\(id:20\)/)
      assert.doesNotMatch(objects[0], /rel\(id/)
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "a download by id no Overpass instance would answer writes what Nominatim has, and names the rest as not downloaded",
  { skip: missing },
  async () => {
    const services = await serve({
      overpass: () => ({ status: 503, body: "busy" }),
      nominatim: (where) =>
        where === "lookup"
          ? looked(
              place("way", 1, "building=yes", polygon(0, 0, 0.01, 0.01), {
                namedetails: { name: "Library", "_place_name:ja": "図書館" },
                extratags: { "building:levels": "3", linked_place: "city" },
              }),
              place("way", 4, "highway=residential", polygon(0, 0.02, 0.01, 0.03), { namedetails: { name: "Ring" } }),
              place("node", 2, "amenity=cafe", { type: "Point", coordinates: [0.005, 0.005] }),
            )
          : { json: { status: 0, data_updated: "2026-10-26T03:10:00+00:00" } },
    })
    const engine = await start(base, services.services, { stall: 3, pause: 1 })
    try {
      const done = await engine.call("objects", {
        ids: ["W1", "N2", "W4", "R3", "w1"],
        fields: ["*"],
        output: path.join(engine.directory, "objects.gpkg"),
      })
      assert.ok(done.ok, JSON.stringify(done))
      const result = done.result as { path: string; layers: object; gaps: object[]; timestamp: string }
      assert.deepEqual(result.layers, { points: 1, lines: 1, polygons: 1 })
      assert.deepEqual(result.gaps, [{ undownloaded: ["R3"], code: "stalled" }])
      assert.equal(result.timestamp, "2026-10-26T03:10:00Z")
      const file = read(result.path)
      // Guards against taking Nominatim's shape for GeoCode's rule: a closed residential road is a line.
      assert.deepEqual(
        file.lines.rows.map((row: { osm_id: string }) => row.osm_id),
        ["W4"],
      )
      const tags = JSON.parse(file.polygons.rows[0].osm_tags)
      assert.equal(tags["building:levels"], "3")
      assert.equal(tags.name, "Library")
      // Guards against what Nominatim adds of its own being written as one of the object's tags, and an object named
      // twice being written twice.
      assert.ok(!("linked_place" in tags) && !("_place_name:ja" in tags), JSON.stringify(tags))
      assert.equal(file.polygons.rows.length, 1)
      assert.deepEqual(queries(services.asked), [])
      // Guards against the row still saying the servers are busy once the download goes on without them.
      assert.deepEqual(waitedOn(engine.sent).at(-1), { asking: false, arriving: false, busy: false })
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test(
  "a download by id Overpass keeps turning away, though its probes answered, still writes what Nominatim has",
  { skip: missing },
  async () => {
    const services = await serve({
      overpass: (query) => (isProbe(query) ? answer([]) : { status: 429, body: "rate limited" }),
      nominatim: (where) =>
        where === "lookup"
          ? looked(place("way", 1, "building=yes", polygon(0, 0, 0.01, 0.01), { namedetails: { name: "Library" } }))
          : { json: { status: 0, data_updated: "2026-10-26T03:10:00+00:00" } },
    })
    const engine = await start(base, services.services, { stall: 3, pause: 1 })
    try {
      const done = await engine.call("objects", { ids: ["W1"], output: path.join(engine.directory, "o.gpkg") })
      // Guards against a call whose instances take the probe but not the query ending with nothing written.
      assert.ok(done.ok, JSON.stringify(done))
      assert.deepEqual((done.result as { layers: object; gaps: object[] }).layers, { polygons: 1 })
      assert.deepEqual((done.result as { gaps: object[] }).gaps, [])
      assert.ok(queries(services.asked).length > 0)
    } finally {
      await engine.stop()
      await services.close()
    }
  },
)

test("a download by id no service has an object for asks Nominatim for it once", { skip: missing }, async () => {
  const services = await serve({ overpass: () => ({ status: 503, body: "busy" }) })
  const engine = await start(base, services.services, { stall: 3, pause: 1 })
  try {
    const done = await engine.call("objects", { ids: ["W1"], output: path.join(engine.directory, "o.gpkg") })
    assert.ok(!done.ok)
    assert.equal(done.error.code, "stalled")
    // Guards against Nominatim being asked again, once Overpass stops, for what it did not have before.
    const lookups = services.asked.filter((request) => request.service === "nominatim" && request.where === "lookup")
    assert.equal(lookups.length, 1)
  } finally {
    await engine.stop()
    await services.close()
  }
})
