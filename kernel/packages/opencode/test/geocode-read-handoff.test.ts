import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RASTER_MAIN, VECTOR_MAIN } from "@opencode-ai/core/filesystem/geo-extensions"
import { Agent } from "../src/agent/agent"
import { InstanceState } from "../src/effect/instance-state"
import { Permission } from "../src/permission"
import { RuntimeFlags } from "../src/effect/runtime-flags"
import { ToolRegistry } from "../src/tool/registry"
import { geoHandoff, geoKind, RASTER_SUPPORTED, VECTOR_SUPPORTED } from "../src/tool/geo-handoff"
import READ_DESCRIPTION from "../src/tool/geo-read.txt"
import { MessageID, SessionID } from "../src/session/schema"
import { disposeAllInstances } from "./fixture/fixture"
import { testEffect } from "./lib/effect"

// A merge can quietly undo the read → ReadGeoData handoff patch, and read then gives a plausible-looking answer
// rather than an error (GEOKERNEL §10.1 #10).

const it = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ]),
)

afterEach(async () => {
  await disposeAllInstances()
})

const readFile = Effect.fnUntraced(function* (filepath: string) {
  const registry = yield* ToolRegistry.Service
  const permission = yield* Permission.Service
  const agent = yield* Agent.Service.use((svc) => svc.get("GeoAgent"))
  const read = (yield* registry.all()).find((tool) => tool.id === "read")
  expect(read).toBeDefined()
  return yield* read!.execute(
    { filePath: filepath },
    {
      sessionID: SessionID.make("ses_handoff"),
      messageID: MessageID.make("msg_handoff"),
      agent: "GeoAgent",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: (req) =>
        permission
          .ask({ ...req, sessionID: SessionID.make("ses_handoff"), ruleset: agent!.permission })
          .pipe(Effect.orDie),
    },
  )
})

describe("read hands geographic data to ReadGeoData", () => {
  it.instance("a text geo format is redirected instead of paged through", () =>
    Effect.gen(function* () {
      // Without the handoff GeoJSON passes every check read makes and comes back as coordinates to page through.
      const ctx = yield* InstanceState.context
      const target = path.join(ctx.directory, "scene.geojson")
      fs.writeFileSync(
        target,
        JSON.stringify({
          type: "FeatureCollection",
          features: Array.from({ length: 4_000 }, (_, i) => ({
            type: "Feature",
            properties: { id: i },
            geometry: { type: "Point", coordinates: [121.5 + i * 1e-6, 25.0] },
          })),
        }),
      )
      expect(fs.statSync(target).size).toBeGreaterThan(50 * 1024)

      const result = yield* readFile(target)
      expect(result.output).toContain("Use the ReadGeoData tool")
      expect(result.output).not.toContain("Use offset=")
      expect(result.output).not.toContain("coordinates")
      expect(result.metadata.truncated).toBe(false)
    }),
  )

  it.instance("a binary geo format is redirected instead of dead-ending", () =>
    Effect.gen(function* () {
      // Without the handoff this is "Cannot read binary file", which names no way forward.
      const ctx = yield* InstanceState.context
      const target = path.join(ctx.directory, "layer.shp")
      fs.writeFileSync(target, Buffer.from([0x00, 0x00, 0x27, 0x0a, 0x00, 0x00, 0x00, 0x00]))

      const result = yield* readFile(target)
      expect(result.output).toContain("Use the ReadGeoData tool")
      expect(result.output).not.toContain("Cannot read binary file")
    }),
  )

  it.instance("a sidecar is still read, and so is an ordinary file", () =>
    Effect.gen(function* () {
      // ReadGeoData refuses a .prj as unsupported, so redirecting one would send the caller to a tool that turns
      // it away.
      const ctx = yield* InstanceState.context
      const prj = path.join(ctx.directory, "layer.prj")
      fs.writeFileSync(prj, 'GEOGCS["WGS 84",DATUM["WGS_1984"]]')
      const projected = yield* readFile(prj)
      expect(projected.output).toContain("WGS 84")
      expect(projected.output).not.toContain("ReadGeoData")

      const notes = path.join(ctx.directory, "notes.md")
      fs.writeFileSync(notes, "# plain text\n")
      const plain = yield* readFile(notes)
      expect(plain.output).toContain("plain text")
      expect(plain.output).not.toContain("ReadGeoData")
    }),
  )

  test("the redirect and the acceptance are one judgement", () => {
    expect(geoKind("/tmp/a.geojson")).toBe("vector")
    expect(geoKind("/tmp/a.SHP")).toBe("vector")
    expect(geoKind("/tmp/a.tif")).toBe("raster")
    expect(geoKind("/tmp/a.ASC")).toBe("raster")
    expect(geoKind("/tmp/a.prj")).toBeUndefined()
    expect(geoKind("/tmp/a.nc")).toBeUndefined()
    for (const ext of VECTOR_SUPPORTED) expect(geoKind(`/tmp/a.${ext}`)).toBe("vector")
    for (const ext of RASTER_SUPPORTED) expect(geoKind(`/tmp/a.${ext}`)).toBe("raster")
    // The last loop is the one that matters: read redirects on geoHandoff while ReadGeoData picks its reader with
    // geoKind, so the two cannot come apart into predicates kept in step by hand.
    for (const ext of [...VECTOR_SUPPORTED, ...RASTER_SUPPORTED, "prj", "nc", "md"]) {
      expect(Boolean(geoHandoff(`/tmp/a.${ext}`))).toBe(geoKind(`/tmp/a.${ext}`) !== undefined)
    }
  })

  test("the redirect covers exactly what ReadGeoData accepts", () => {
    // A literal, so widening the arrays edits this line: check first that vector_read.py or raster_read.py opens it.
    expect([...VECTOR_SUPPORTED, ...RASTER_SUPPORTED].sort()).toEqual([
      "asc",
      "dem",
      "fgb",
      "geojson",
      "gml",
      "gpkg",
      "gpx",
      "img",
      "kml",
      "shp",
      "tif",
      "tiff",
    ])

    for (const ext of [...VECTOR_SUPPORTED, ...RASTER_SUPPORTED]) {
      expect(geoHandoff(`/tmp/file.${ext}`)).toContain("ReadGeoData")
      expect(geoHandoff(`/tmp/FILE.${ext.toUpperCase()}`)).toContain("ReadGeoData")
    }

    // Only ReadGeoData can tell whether the file is geographic data, and preview exists for rasters only.
    const message = geoHandoff("/tmp/file.shp")!
    expect(message).not.toContain("geographic data")
    expect(message.toLowerCase()).not.toContain("preview")
    expect(geoHandoff("/tmp/file.tif")).toBe(message)

    // A geographic format no reader script opens stays out, or read hands it to a tool that refuses it.
    for (const ext of ["nc", "jp2", "tab", "mif", "osm", "kmz", "las", "dxf"]) {
      expect([...VECTOR_MAIN, ...RASTER_MAIN, "las", "dxf"]).toContain(ext)
      expect(geoHandoff(`/tmp/file.${ext}`)).toBeUndefined()
    }
    for (const ext of ["prj", "cpg", "dbf", "shx", "qmd", "ts", "md", "json", "csv"]) {
      expect(geoHandoff(`/tmp/file.${ext}`)).toBeUndefined()
    }
    expect(geoHandoff("/tmp/no-extension")).toBeUndefined()
  })

  test("the list the model reads is the list the code uses", () => {
    // geo-read.txt spells the formats out for the model by hand, so widening an array alone leaves it a shorter list.
    const listed = (label: string) =>
      READ_DESCRIPTION.split("\n")
        .find((line) => line.startsWith(`- ${label}:`))!
        .replace(`- ${label}:`, "")
        .split(",")
        .map((item) => item.trim().replace(/^\./, ""))

    expect(listed("Vector")).toEqual([...VECTOR_SUPPORTED])
    expect(listed("Raster")).toEqual([...RASTER_SUPPORTED])
  })
})
