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

/* The `read` → ReadGeoData handoff (GEOKERNEL §10.1 #10; docs/TOOLS.md §7).
 *
 * This is a source patch on an upstream tool, so it needs a tripwire that
 * survives a merge undoing it. The behavioural half runs `read` for real on
 * files of each kind, because the failure this prevents is not an exception —
 * it is a plausible-looking answer: a .geojson read as plain text, capped
 * mid-coordinate, with an invitation to page through the rest of it.
 */

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
      // The dangerous half. GeoJSON is text, so it passes every check `read`
      // makes and comes back as a truncated fragment of a coordinate array
      // ending in "Use offset=N to continue" — an answer that looks like data
      // and invites the model to keep asking for more of it.
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
      // The other half: without the handoff this is "Cannot read binary file",
      // which is true and names no way forward.
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
      // Sidecars are small text files worth reading directly, and ReadGeoData
      // refuses them as input — redirecting would send the caller somewhere
      // that turns them away. This is the old build's boundary, kept.
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
    // Not two predicates kept in agreement — one function, called from both
    // sides of the handoff. ReadGeoData branches vector/raster on this same
    // answer, so a file `read` redirects is by construction a file the reader
    // opens, and it opens it as the kind named here.
    expect(geoKind("/tmp/a.geojson")).toBe("vector")
    expect(geoKind("/tmp/a.SHP")).toBe("vector")
    expect(geoKind("/tmp/a.tif")).toBe("raster")
    expect(geoKind("/tmp/a.ASC")).toBe("raster")
    expect(geoKind("/tmp/a.prj")).toBeUndefined()
    expect(geoKind("/tmp/a.nc")).toBeUndefined()
    for (const ext of VECTOR_SUPPORTED) expect(geoKind(`/tmp/a.${ext}`)).toBe("vector")
    for (const ext of RASTER_SUPPORTED) expect(geoKind(`/tmp/a.${ext}`)).toBe("raster")
    // The redirect fires on exactly the set that has a kind.
    for (const ext of [...VECTOR_SUPPORTED, ...RASTER_SUPPORTED, "prj", "nc", "md"]) {
      expect(Boolean(geoHandoff(`/tmp/a.${ext}`))).toBe(geoKind(`/tmp/a.${ext}`) !== undefined)
    }
  })

  test("the redirect covers exactly what ReadGeoData accepts", () => {
    // Spelled out rather than derived from the arrays under test: deriving the
    // expectation from the same list makes the assertion true by construction,
    // and widening the list would then never turn it red. Changing this literal
    // is the deliberate act — and the thing to check when changing it is that
    // ReadGeoData really opens the new format, because the rule is to redirect
    // only to a tool that will do the job.
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

    // Two things the redirect must NOT say, both of which it once did.
    //
    // A claim about the file: this function has an extension and nothing else,
    // while whether the thing IS geographic data is decided by ReadGeoData
    // from the file itself — and comes back `none` often enough to matter,
    // because a scan saved as `.tif` is exactly what started this.
    //
    // And a promise about a mode: `preview` is raster-only, so offering it for
    // every format sends a caller that believes it to a refusal it earned by
    // doing as it was told.
    const message = geoHandoff("/tmp/file.shp")!
    expect(message).not.toContain("geographic data")
    expect(message.toLowerCase()).not.toContain("preview")
    // The same sentence whatever the format: nothing here can tell them apart.
    expect(geoHandoff("/tmp/file.tif")).toBe(message)

    // Narrower than the taxonomy on purpose: a format the taxonomy calls
    // geographic but ReadGeoData cannot open would be refused here AND turned
    // away there — a dead end with no reader at all.
    for (const ext of ["nc", "jp2", "tab", "mif", "osm", "kmz", "las", "dxf"]) {
      expect([...VECTOR_MAIN, ...RASTER_MAIN, "las", "dxf"]).toContain(ext)
      expect(geoHandoff(`/tmp/file.${ext}`)).toBeUndefined()
    }
    // Sidecars and ordinary files.
    for (const ext of ["prj", "cpg", "dbf", "shx", "qmd", "ts", "md", "json", "csv"]) {
      expect(geoHandoff(`/tmp/file.${ext}`)).toBeUndefined()
    }
    expect(geoHandoff("/tmp/no-extension")).toBeUndefined()
  })

  test("the list the model reads is the list the code uses", () => {
    /* The one copy the shared array does not cover.
     *
     * `read.ts` and `geo-read.ts` were deliberately made to share one array so
     * the two sides of the handoff cannot disagree — the old build kept a
     * hand-copy in `read.ts` and relied on someone editing both. But there is a
     * third side: `geo-read.txt` spells the formats out for the model, and that
     * spelling is a hand-copy again. Widening the array without touching the
     * description leaves the model refusing a file the tool would open, and the
     * refusal names the shorter list as if it were the whole truth.
     *
     * Asserted against the description text, not derived from it, because a
     * derivation would be true by construction.
     */
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
