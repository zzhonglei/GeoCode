import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { downloader, FRESH_MS } from "../../../src/basemap/download.ts"
import { onlineTile } from "../../../src/basemap/index.ts"
import { online, raster } from "../../../src/basemap/styles.ts"

type Layer = { id: string; layout?: { "text-field"?: unknown } }

// As OpenFreeMap's: one source by TileJSON, one by its tiles, one sprite.
const OPENFREEMAP = {
  version: 8,
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sprite: "https://tiles.openfreemap.org/sprites/ofm_f384/ofm",
  sources: {
    openmaptiles: { type: "vector", url: "https://tiles.openfreemap.org/planet" },
    ne2_shaded: {
      type: "raster",
      maxzoom: 6,
      tileSize: 256,
      tiles: ["https://tiles.openfreemap.org/natural_earth/ne2sr/{z}/{x}/{y}.png"],
    },
  },
  layers: [
    {
      id: "place",
      type: "symbol",
      layout: { "text-field": ["case", ["has", "name:nonlatin"], ["get", "name:latin"], ["get", "name"]] },
    },
    { id: "road_shield", type: "symbol", layout: { "text-field": ["to-string", ["get", "ref"]] } },
  ],
}
const PLANET = { tiles: ["https://tiles.openfreemap.org/planet/20261101/{z}/{x}/{y}.pbf"], minzoom: 0, maxzoom: 14 }

// As VersaTiles': sources with their own credits, sprites as a list.
const VERSATILES = {
  version: 8,
  glyphs: "https://tiles.versatiles.org/assets/glyphs/{fontstack}/{range}.pbf",
  projection: { type: "globe" },
  sky: { "atmosphere-blend": 0.5 },
  sprite: [{ id: "base", url: "https://tiles.versatiles.org/assets/sprites/base" }],
  sources: {
    "versatiles-shortbread": {
      type: "vector",
      tiles: ["https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}"],
      maxzoom: 14,
      attribution: "<a href=x>OSM</a>",
    },
    "versatiles-landcover": {
      type: "vector",
      tiles: ["https://tiles.versatiles.org/tiles/landcover-vectors/{z}/{x}/{y}"],
      maxzoom: 10,
      attribution: "<a href=x>OSM</a>",
    },
  },
  layers: [{ id: "label-place-city", type: "symbol", layout: { "text-field": "{name}" } }],
}

// Guards against an online style reaching a map with an address of its own: the page in the chat could not fetch it,
// and OpenStreetMap's policy asks the engine, not the window, to fetch and cache.
test("an online style names its tiles and icons by the scheme alone, and the engine knows where each leads", () => {
  const made = online(
    "openfreemap",
    OPENFREEMAP,
    { "https://tiles.openfreemap.org/planet": PLANET },
    {
      schema: "openmaptiles",
      locale: "zh-TW",
      credit: "OpenFreeMap © OpenMapTiles © OpenStreetMap contributors",
    },
  )
  const style = made.style as {
    sources: Record<string, { tiles: string[]; maxzoom?: number; attribution?: string }>
    sprite: string
    layers: Layer[]
  }
  assert.ok(!("glyphs" in style), "no glyphs to fetch")
  assert.equal(style.sprite, "geocode-basemap://sprite/openfreemap.ofm")
  assert.deepEqual(style.sources.openmaptiles!.tiles, ["geocode-basemap://tile/openfreemap.openmaptiles/{z}/{x}/{y}"])
  assert.equal(style.sources.openmaptiles!.maxzoom, 14, "the zooms the TileJSON gives")
  assert.deepEqual(style.sources.ne2_shaded!.tiles, ["geocode-basemap://tile/openfreemap.ne2_shaded/{z}/{x}/{y}"])
  assert.deepEqual(made.upstream, {
    tiles: {
      "openfreemap.openmaptiles": PLANET.tiles[0],
      "openfreemap.ne2_shaded": OPENFREEMAP.sources.ne2_shaded.tiles[0],
    },
    sprites: { "openfreemap.ofm": OPENFREEMAP.sprite },
  })
  // One credit, the provider's.
  const credits = Object.values(style.sources).flatMap((source) => (source.attribution ? [source.attribution] : []))
  assert.deepEqual(credits, ["OpenFreeMap © OpenMapTiles © OpenStreetMap contributors"])
  // Place names in the interface's language; road numbers as they were.
  assert.deepEqual(style.layers[0]!.layout?.["text-field"], [
    "coalesce",
    ["get", "name:zh-Hant"],
    ["get", "name:zh"],
    ["get", "name"],
  ])
  assert.deepEqual(style.layers[1]!.layout?.["text-field"], OPENFREEMAP.layers[1]!.layout["text-field"])
})

// Guards against VersaTiles' style reaching a map as it is written: its sprites as a list, its names in another schema,
// and a globe of its own.
test("VersaTiles' sprites and names are read as its schema writes them", () => {
  const made = online(
    "versatiles",
    VERSATILES,
    {},
    { schema: "shortbread", locale: "en", credit: "© VersaTiles © OpenStreetMap contributors" },
  )
  const style = made.style as {
    sprite: { id: string; url: string }[]
    sources: Record<string, { attribution?: string }>
    layers: Layer[]
  }
  assert.deepEqual(style.sprite, [{ id: "base", url: "geocode-basemap://sprite/versatiles.base" }])
  // The projection is the page's: a basemap turning a flat map into a globe would surprise both the user and the page.
  assert.ok(!("projection" in style) && !("sky" in style), "no projection or sky of its own")
  assert.equal(made.upstream.sprites["versatiles.base"], VERSATILES.sprite[0]!.url)
  assert.deepEqual(Object.keys(made.upstream.tiles), [
    "versatiles.versatiles-shortbread",
    "versatiles.versatiles-landcover",
  ])
  assert.equal(
    Object.values(style.sources).filter((source) => source.attribution).length,
    1,
    "the style's own credits go",
  )
  assert.deepEqual(style.layers[0]!.layout?.["text-field"], ["coalesce", ["get", "name_en"], ["get", "name"]])
})

// Guards against the credit the user writes for a custom basemap running as markup: MapLibre shows a credit as HTML,
// in the window as well as in the pages.
test("a credit is shown as text", () => {
  const source = raster([{ name: "custom", maxzoom: 19 }], `<img src=x onerror="alert(1)"> © Me & 'you'`).sources
    .custom
  assert.ok(source?.attribution && !/[<>"']/.test(source.attribution), source?.attribution)
  assert.deepEqual(source?.tiles, ["geocode-basemap://tile/custom/{z}/{x}/{y}"])
})

// Guards against a page in the chat having GeoEngine download from a basemap the user did not choose, spending
// Tianditu's quota or reaching the network unasked, and against a map drawn before a new key or address reading tiles
// under the old one.
test("a page reads online tiles only of the basemap the settings choose, as they are set now", () => {
  const custom = { source: "custom" as const, custom: { url: "https://{s}.tiles.example/{z}/{x}/{y}.png" } }
  assert.ok("refused" in onlineTile({ source: "offline" }, "osm", 1, 0, 0)!, "OpenStreetMap while offline is chosen")
  assert.ok("refused" in onlineTile(custom, "custom.00000000", 1, 0, 0)!, "an address set before")
  const keyed = { source: "tianditu" as const, tianditu: { key: "abc123" } }
  assert.ok("refused" in onlineTile(keyed, "tianditu.vec.00000000", 1, 0, 0)!, "a key set before")
  assert.ok(
    "refused" in onlineTile(custom, "tianditu.vec.00000000", 1, 0, 0)!,
    "Tianditu while a custom basemap is chosen",
  )
  assert.equal(onlineTile({ source: "openfreemap" }, "openfreemap.openmaptiles", 1, 0, 0), undefined)
  // As set now: the address with its server filled, Tianditu's key sent but not part of the name the tile is kept by.
  const mark = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8)
  assert.deepEqual(onlineTile(custom, `custom.${mark(custom.custom.url)}`, 3, 1, 2), {
    url: "https://a.tiles.example/3/1/2.png",
  })
  const tile = onlineTile(keyed, `tianditu.cva.${mark("abc123")}`, 3, 1, 2)
  assert.ok(
    tile && "url" in tile && tile.url.endsWith("&tk=abc123") && tile.identity && !tile.identity.includes("abc123"),
  )
})

/** A tile server that counts what it is asked, by path, and records the User-Agent. */
const serve = async (answers: Record<string, number>) => {
  const asked: string[] = []
  const agents: string[] = []
  const server = http.createServer((req, res) => {
    asked.push(req.url ?? "")
    agents.push(req.headers["user-agent"] ?? "")
    const status = answers[(req.url ?? "").split("?")[0]!] ?? 200
    if (req.url === "/login") return res.writeHead(200, { "content-type": "text/html" }).end("<html>sign in</html>")
    res.writeHead(status).end(status === 200 ? "tile" : "")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, asked, agents, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

// Guards against the cache not holding, when every view of a map would download again, which the tile policies forbid,
// and against the areas seen before going blank offline once their copies are a week old.
test("a downloaded tile, or the lack of one, is read from the cache for a week, and after while it cannot be downloaded", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "geocode-basemap-"))
  const answers: Record<string, number> = { "/none": 404, "/broken": 500 }
  const server = await serve(answers)
  try {
    const downloads = downloader(folder, "GeoCode/test")
    const signal = new AbortController().signal
    assert.equal(new TextDecoder().decode((await downloads.get(`${server.base}/tile`, signal))!), "tile")
    assert.equal(new TextDecoder().decode((await downloads.get(`${server.base}/tile`, signal))!), "tile")
    assert.equal(await downloads.get(`${server.base}/none`, signal, { tile: true }), null)
    assert.equal(await downloads.get(`${server.base}/none`, signal, { tile: true }), null)
    // Under one identity, as Tianditu's tiles are without the key.
    await downloads.get(`${server.base}/keyed?tk=a`, signal, { identity: "keyed" })
    await downloads.get(`${server.base}/keyed?tk=b`, signal, { identity: "keyed" })
    assert.deepEqual(server.asked, ["/tile", "/none", "/keyed?tk=a"])
    assert.ok(server.agents.every((agent) => agent === "GeoCode/test"))
    // A failure is not kept: the next view asks again. Nor is a style the server lacks, a login page a network answers
    // with, or a file that is not what was asked for, each of which would stand for the file for a week.
    for (const [path, error, options] of [
      ["/broken", /answered 500/, {}],
      ["/none", /answered 404/, {}],
      ["/login", /web page/, { tile: true }],
      ["/tile", /something else/, { check: () => false, identity: "checked" }],
    ] as const) {
      await assert.rejects(downloads.get(`${server.base}${path}`, signal, options), error)
      await assert.rejects(downloads.get(`${server.base}${path}`, signal, options), error)
    }
    assert.equal(server.asked.filter((asked) => asked === "/broken").length, 2)
    assert.equal(server.asked.filter((asked) => asked === "/login").length, 2)
    assert.equal(server.asked.filter((asked) => asked === "/tile").length, 3)
    // A week on, a tile is downloaded again; while it cannot be, as offline, the older copy stands in, and trimming,
    // under its limit, keeps it.
    const stale = new Date(Date.now() - FRESH_MS - 60_000)
    const files = fs.readdirSync(folder, { recursive: true, encoding: "utf-8" }).map((file) => path.join(folder, file))
    for (const file of files.filter((file) => fs.statSync(file).isFile())) fs.utimesSync(file, stale, stale)
    await downloads.get(`${server.base}/tile`, signal)
    assert.equal(server.asked.filter((asked) => asked === "/tile").length, 4)
    for (const file of files.filter((file) => fs.statSync(file).isFile())) fs.utimesSync(file, stale, stale)
    await downloads.trim()
    answers["/tile"] = 503
    assert.equal(new TextDecoder().decode((await downloads.get(`${server.base}/tile`, signal))!), "tile")
    assert.equal(server.asked.filter((asked) => asked === "/tile").length, 5)
  } finally {
    await server.close()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
