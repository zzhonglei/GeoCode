import { afterAll, describe, expect } from "bun:test"
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

/* The algorithm catalog (docs/GEOKERNEL.md §4.11). */

/** Shaped for the queries below: `Vector geometry` sits in two providers, and `slope` names two algorithms. */
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
          // Odd spacing on purpose: the help text is passed through untouched (§4.11).
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
        // No group at all, which groups() lists under UNGROUPED and inGroup() therefore owes an answer for.
        {
          id: "gdal:orphan",
          name: "Orphan",
          group: "",
          description: "Belongs nowhere.",
          helpText: "orphan help",
          parameters: [],
          outputs: [],
        },
      ],
    },
    {
      id: "extra",
      name: "Extra",
      algorithms: [
        // A display name folding to nothing the id folds to, the only shape the name tier can answer for. QGIS
        // ships `native:zonalstatisticsfb` named "Zonal statistics".
        {
          id: "extra:zonalstatisticsfb",
          name: "Zonal statistics",
          group: "Raster analysis",
          description: "Zonal stats.",
          helpText: "zonal help",
          parameters: [],
          outputs: [],
        },
        // One short id, two providers, as `gdal:slope` and `native:slope` are on a real install.
        {
          id: "extra:slope",
          name: "Slope one",
          group: "Raster terrain analysis",
          description: "Slope, one way.",
          helpText: "slope help",
          parameters: [],
          outputs: [],
        },
        {
          id: "other:slope",
          name: "Slope two",
          group: "Raster terrain analysis",
          description: "Slope, another way.",
          helpText: "slope help",
          parameters: [],
          outputs: [],
        },
        // One display name over two algorithms, the shape where the name tier itself would have to guess.
        {
          id: "extra:splitlinesbylength",
          name: "Split lines",
          group: "Vector overlay",
          description: "Split by length.",
          helpText: "split help",
          parameters: [],
          outputs: [],
        },
        {
          id: "other:splitlinesbypoints",
          name: "Split lines",
          group: "Vector overlay",
          description: "Split by points.",
          helpText: "split help",
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
    LayerNode.compile(LayerNode.group([QgisCatalog.node]), [
      [GeoRuntime.node, runtimeReturning([{ stdout: REGISTRY_OK }])],
    ]),
  )

  it.effect("build extracts the registry from noisy output and holds it", () =>
    Effect.gen(function* () {
      const catalog = yield* QgisCatalog.Service
      expect((yield* catalog.build(ENVIRONMENT)).ok).toBe(true)

      const groups = yield* catalog.groups()
      // One group counting both providers' members, not one entry per provider.
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

  it.effect("lookup answers to the forms the catalog itself prints", () =>
    Effect.gen(function* () {
      const catalog = yield* QgisCatalog.Service
      yield* catalog.build(ENVIRONMENT)

      expect((yield* catalog.get("Native:Buffer"))?.id).toBe("native:buffer") // case
      expect((yield* catalog.get("gdal:CLIPRASTERBYEXTENT"))?.id).toBe("gdal:cliprasterbyextent")
      expect((yield* catalog.get("clip_raster_by_extent"))?.id).toBe("gdal:cliprasterbyextent") // snake
      expect((yield* catalog.get("clip-raster-by-extent"))?.id).toBe("gdal:cliprasterbyextent") // kebab
      expect((yield* catalog.get("Clip raster by extent"))?.id).toBe("gdal:cliprasterbyextent") // spaces
      expect((yield* catalog.get("Zonal statistics"))?.id).toBe("extra:zonalstatisticsfb")
      expect((yield* catalog.get("zonal statistics"))?.id).toBe("extra:zonalstatisticsfb")

      // Ambiguity answers nothing rather than whichever came first: running an algorithm the caller never asked
      // for is the one failure it cannot detect.
      expect(yield* catalog.get("slope")).toBeUndefined()
      expect(yield* catalog.get("SLOPE")).toBeUndefined()
      expect(yield* catalog.get("Split lines")).toBeUndefined()
      expect(yield* catalog.get("split_lines")).toBeUndefined()

      // The full id still answers, so the tolerance costs nothing to a caller that spells one out.
      expect((yield* catalog.get("extra:slope"))?.description).toBe("Slope, one way.")
      expect((yield* catalog.get("other:slope"))?.description).toBe("Slope, another way.")
      expect((yield* catalog.get("extra:splitlinesbylength"))?.description).toBe("Split by length.")

      // A key that folds to nothing is no key, not a wildcard.
      expect(yield* catalog.get("///")).toBeUndefined()
    }),
  )

  it.effect("resolve says WHICH way a lookup failed, and hands back the candidates", () =>
    Effect.gen(function* () {
      const catalog = yield* QgisCatalog.Service
      yield* catalog.build(ENVIRONMENT)

      const shortId = yield* catalog.resolve("slope")
      expect(shortId.kind).toBe("ambiguous")
      if (shortId.kind === "ambiguous") expect([...shortId.candidates].sort()).toEqual(["extra:slope", "other:slope"])

      const byName = yield* catalog.resolve("Split lines")
      expect(byName.kind).toBe("ambiguous")
      if (byName.kind === "ambiguous") {
        expect([...byName.candidates].sort()).toEqual(["extra:splitlinesbylength", "other:splitlinesbypoints"])
      }

      expect((yield* catalog.resolve("native:buffer")).kind).toBe("found")
      expect((yield* catalog.resolve("Zonal statistics")).kind).toBe("found")
      expect((yield* catalog.resolve("native:nosuchthing")).kind).toBe("missing")
      expect((yield* catalog.resolve("///")).kind).toBe("missing")

      // And `get` stays the thin wrapper, so the two cannot disagree about one key.
      expect(yield* catalog.get("slope")).toBeUndefined()
    }),
  )

  it.effect("a group answers to every spelling it is listed under", () =>
    Effect.gen(function* () {
      const catalog = yield* QgisCatalog.Service
      yield* catalog.build(ENVIRONMENT)

      for (const spelling of ["Vector geometry", "vector geometry", "Vector Geometry", "vectorgeometry"]) {
        expect((yield* catalog.inGroup(spelling)).map((algorithm) => algorithm.id).sort()).toEqual([
          "gdal:warpreproject",
          "native:buffer",
        ])
      }

      // A group `groups()` lists and `inGroup` does not answer for is a listing that points at nothing.
      const groups = yield* catalog.groups()
      expect(groups.find((group) => group.name === QgisCatalog.UNGROUPED)?.count).toBe(1)
      expect((yield* catalog.inGroup(QgisCatalog.UNGROUPED)).map((algorithm) => algorithm.id)).toEqual(["gdal:orphan"])

      expect(yield* catalog.inGroup("no such group")).toEqual([])
      expect(yield* catalog.inGroup("   ")).toEqual([])
    }),
  )

  it.effect("search and suggestion rank by closeness", () =>
    Effect.gen(function* () {
      const catalog = yield* QgisCatalog.Service
      yield* catalog.build(ENVIRONMENT)
      const found = yield* catalog.search("clip")
      expect(found.length).toBeGreaterThanOrEqual(2)
      // Subsequence matching, so a dropped character still finds its target.
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
      // A query that rebuilt on its own would spawn a QGIS startup wherever it was called; when to build is the
      // lifecycle's alone (§4.8).
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
  // Other test files read this same path, so a machine.json left behind decides their starting state.
  afterAll(() => {
    fs.rmSync(bundles, { recursive: true, force: true })
    fs.rmSync(path.join(Global.Path.config, "machine.json"), { force: true })
  })
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
    LayerNode.compile(
      LayerNode.group([GeoQgis.node, QgisCatalog.node, EventV2.node, MachineConfig.node, GeoStatus.node]),
      [[GeoRuntime.node, runtimeByLabel]],
    ),
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

        // The verified environment never leaves the kernel, so a status surface has these from the ready frame or
        // not at all (§9.1).
        if (ready.status === "ready") {
          expect(ready.versions?.qgis).toBe("3.44.9")
          expect(ready.interpreter?.endsWith("python3.12")).toBe(true)
        }

        // The gate wants a built catalog too, so the stage above has to have completed for this to open (§4.9).
        const gate = yield* qgis.gate()
        expect(gate.ok).toBe(true)

        expect((yield* catalog.get("native:buffer"))?.name).toBe("Buffer")
        expect((yield* catalog.groups()).length).toBeGreaterThan(0)
      }),
    { timeout: 30000 },
  )
})
