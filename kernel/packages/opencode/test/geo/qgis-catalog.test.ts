import { describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { MachineConfig } from "@/geo/config"
import { GeoQgis } from "@/geo/qgis"
import { QgisCatalog } from "@/geo/qgis/catalog"
import { QgisProbe } from "@/geo/qgis/probe"
import { GeoRuntime } from "@/geo/runtime"
import { GeoStatus } from "@/geo/status"
import { pollWithTimeout, testEffect } from "../lib/effect"

/* The algorithm catalog (docs/GEOKERNEL.md §4.11).
 *
 * The export itself ran against real QGIS 3.44.9: 422 algorithms from exactly
 * the three official providers, help text captured verbatim, 658ms. These
 * tests freeze the query semantics and the failure paths on a synthetic
 * registry, plus the one wiring fact no unit test can show: with the real
 * catalog layer in place of the stub, the unified gate actually opens. */

/** Two providers sharing a group name, to catch cross-provider dedup. */
const REGISTRY: QgisCatalog.Registry = {
  qgisVersion: "3.44.9-Test",
  providers: [
    {
      id: "native",
      name: "QGIS (native c++)",
      algorithms: [
        {
          id: "native:buffer",
          name: "Buffer",
          group: "Vector geometry",
          description: "Computes a buffer.",
          // Deliberately odd spacing: verbatim means VERBATIM (§4.11).
          helpText: "Buffer\n\n  keeps   its    whitespace\n\tand its tabs",
          parameters: [
            {
              name: "DISTANCE",
              description: "Distance",
              type: "distance",
              defaultValue: "10",
              options: [],
              optional: false,
            },
          ],
          outputs: [{ name: "OUTPUT", description: "Buffered", type: "outputVector" }],
        },
        {
          id: "native:clip",
          name: "Clip",
          group: "Vector overlay",
          description: "Clips a layer.",
          helpText: "clip help",
          parameters: [],
          outputs: [],
        },
      ],
    },
    {
      id: "gdal",
      name: "GDAL",
      algorithms: [
        {
          id: "gdal:cliprasterbyextent",
          name: "Clip raster by extent",
          group: "Raster extraction",
          description: "Clips a raster.",
          helpText: "raster clip help",
          parameters: [],
          outputs: [],
        },
        {
          id: "gdal:warpreproject",
          name: "Warp (reproject)",
          group: "Vector geometry", // same group name as a native algorithm
          description: "Reprojects.",
          helpText: "warp help",
          parameters: [],
          outputs: [],
        },
      ],
    },
  ],
}

const REGISTRY_OK = `import noise\n${QgisCatalog.MARKER}${JSON.stringify(REGISTRY)}\nteardown`

const ENVIRONMENT: GeoQgis.Environment = {
  python: "/fake/python3.12",
  prefix: "/fake/prefix",
  env: {},
  dllDirectories: [],
  versions: { python: "3.12.11", gdal: "3.12.0", qgis: "3.44.9" },
  processing: true,
}

function runtimeReturning(results: Partial<GeoRuntime.Result>[]) {
  let call = 0
  return Layer.mock(GeoRuntime.Service)({
    run: () => {
      const result = results[Math.min(call++, results.length - 1)]!
      return Effect.succeed({
        code: 0,
        reason: "exit",
        stdout: "",
        stderr: "",
        durationMs: 1,
        truncated: false,
        drainIncomplete: false,
        ...result,
      } satisfies GeoRuntime.Result)
    },
    killAllSync: () => {},
  })
}

describe("qgis catalog queries", () => {
  const it = testEffect(
    LayerNode.compile(LayerNode.group([QgisCatalog.node]), [[GeoRuntime.node, runtimeReturning([{ stdout: REGISTRY_OK }])]]),
  )

  it.effect("build extracts the registry from noisy output and holds it", () =>
    Effect.gen(function* () {
      const catalog = yield* QgisCatalog.Service
      expect((yield* catalog.build(ENVIRONMENT)).ok).toBe(true)

      const groups = yield* catalog.groups()
      // Cross-provider dedup: "Vector geometry" appears in both providers and
      // must be one group counting both members.
      expect(groups.find((group) => group.name === "Vector geometry")?.count).toBe(2)
      expect(groups.map((group) => group.name)).toEqual([...groups.map((group) => group.name)].sort())

      const inGroup = yield* catalog.inGroup("Vector geometry")
      expect(inGroup.map((algorithm) => algorithm.id).sort()).toEqual(["gdal:warpreproject", "native:buffer"])
    }),
  )

  it.effect("help text survives verbatim, whitespace and all", () =>
    Effect.gen(function* () {
      const catalog = yield* QgisCatalog.Service
      yield* catalog.build(ENVIRONMENT)
      const buffer = yield* catalog.get("native:buffer")
      // The QGIS-maintained authority is preserved byte for byte: a trimmed-
      // but-subtly-wrong document is worse than a longer faithful one (§4.11).
      expect(buffer?.helpText).toBe("Buffer\n\n  keeps   its    whitespace\n\tand its tabs")
    }),
  )

  it.effect("lookup takes the exact id first and the short form as fallback", () =>
    Effect.gen(function* () {
      const catalog = yield* QgisCatalog.Service
      yield* catalog.build(ENVIRONMENT)
      expect((yield* catalog.get("gdal:cliprasterbyextent"))?.id).toBe("gdal:cliprasterbyextent")
      expect((yield* catalog.get("buffer"))?.id).toBe("native:buffer")
      expect(yield* catalog.get("nonexistent:thing")).toBeUndefined()
    }),
  )

  it.effect("search and suggestion rank by closeness", () =>
    Effect.gen(function* () {
      const catalog = yield* QgisCatalog.Service
      yield* catalog.build(ENVIRONMENT)
      const found = yield* catalog.search("clip")
      expect(found.length).toBeGreaterThanOrEqual(2)
      // Subsequence semantics, same as the old build: a DROPPED character
      // still matches ("bufer" → "buffer"), a SUBSTITUTED one does not — the
      // replacement character has to exist in the target. Real-machine run
      // confirmed the dropped-character case is the one users actually hit.
      const suggested = yield* catalog.suggest("native:bufer", "algorithm")
      expect(suggested[0]).toBe("native:buffer")
      const groups = yield* catalog.suggest("Vector geomtry", "group")
      expect(groups[0]).toBe("Vector geometry")
    }),
  )

  it.effect("invalidate leaves nothing behind", () =>
    Effect.gen(function* () {
      const catalog = yield* QgisCatalog.Service
      yield* catalog.build(ENVIRONMENT)
      yield* catalog.invalidate()
      // Queries answer from what is held and never rebuild on their own: WHEN
      // to build is the lifecycle's decision alone (§4.8).
      expect(yield* catalog.groups()).toEqual([])
      expect(yield* catalog.get("native:buffer")).toBeUndefined()
    }),
  )
})

describe("qgis catalog build failures", () => {
  {
    const it = testEffect(
      LayerNode.compile(LayerNode.group([QgisCatalog.node]), [
        [GeoRuntime.node, runtimeReturning([{ code: 1, stdout: "ImportError: processing", stderr: "boom" }])],
      ]),
    )
    it.effect("a dump that never reached its marker reports the raw output", () =>
      Effect.gen(function* () {
        const catalog = yield* QgisCatalog.Service
        const outcome = yield* catalog.build(ENVIRONMENT)
        expect(outcome.ok).toBe(false)
        if (!outcome.ok) {
          expect(outcome.error).toContain("ImportError")
          expect(outcome.error).toContain("boom")
        }
        expect(yield* catalog.groups()).toEqual([])
      }),
    )
  }

  {
    const it = testEffect(
      LayerNode.compile(LayerNode.group([QgisCatalog.node]), [
        [GeoRuntime.node, runtimeReturning([{ reason: "timeout", code: null }])],
      ]),
    )
    it.effect("a timeout names itself instead of dumping noise", () =>
      Effect.gen(function* () {
        const catalog = yield* QgisCatalog.Service
        const outcome = yield* catalog.build(ENVIRONMENT)
        expect(outcome.ok).toBe(false)
        if (!outcome.ok) expect(outcome.error).toContain("exceeded")
      }),
    )
  }
})

describe("qgis catalog wired into the lifecycle", () => {
  const bundles = fs.mkdtempSync(path.join(os.tmpdir(), "geo-catalog-"))
  const bundle = (() => {
    const dir = path.join(bundles, "QGIS.app")
    const macos = path.join(dir, "Contents", "MacOS")
    fs.mkdirSync(macos, { recursive: true })
    fs.writeFileSync(path.join(macos, "qgis_process"), "")
    fs.writeFileSync(path.join(macos, "python3.12"), "")
    return dir
  })()

  const PROBE_OK = `${QgisProbe.MARKER}${JSON.stringify({
    pythonVersion: "3.12.11",
    gdalVersion: "3.12.0",
    projTransformReady: true,
    qgisVersion: "3.44.9",
    processingReady: true,
  })}`

  // One runtime, two scripts: the label says which subprocess this stands for.
  const runtimeByLabel = Layer.mock(GeoRuntime.Service)({
    run: (options) =>
      Effect.succeed({
        code: 0,
        reason: "exit",
        stdout: options.label === "qgis:catalog" ? REGISTRY_OK : PROBE_OK,
        stderr: "",
        durationMs: 1,
        truncated: false,
        drainIncomplete: false,
      } satisfies GeoRuntime.Result),
    killAllSync: () => {},
  })

  const it = testEffect(
    LayerNode.compile(LayerNode.group([GeoQgis.node, QgisCatalog.node, EventV2.node, MachineConfig.node, GeoStatus.node]), [
      [GeoRuntime.node, runtimeByLabel],
    ]),
  )

  it.live(
    "with the real catalog layer the gate opens, and queries serve through it",
    () =>
      Effect.gen(function* () {
        const qgis = yield* GeoQgis.Service
        const catalog = yield* QgisCatalog.Service
        const config = yield* MachineConfig.Service
        const status = yield* GeoStatus.Service

        yield* Effect.promise(() =>
          fs.promises.writeFile(path.join(Global.Path.config, "machine.json"), JSON.stringify({ qgis: bundle })),
        )
        yield* config.reload()

        const ready = yield* pollWithTimeout(
          Effect.gen(function* () {
            const current = yield* status.current("qgis")
            return current?.status === "ready" && current.catalog === "ready" ? current : undefined
          }),
          "the catalog stage never completed",
          "15 seconds",
        )

        // The ready frame carries what a status surface shows on the happy
        // path. The verified environment never leaves the kernel, so these
        // facts exist on the wire or nowhere.
        if (ready.status === "ready") {
          expect(ready.versions?.qgis).toBe("3.44.9")
          expect(ready.interpreter?.endsWith("python3.12")).toBe(true)
        }

        // This is 2c's whole point: the stub that honestly failed is gone, and
        // the same seam now opens the gate (§4.9).
        const gate = yield* qgis.gate()
        expect(gate.ok).toBe(true)

        expect((yield* catalog.get("native:buffer"))?.name).toBe("Buffer")
        expect((yield* catalog.groups()).length).toBeGreaterThan(0)
      }),
    { timeout: 30000 },
  )
})
