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
        // No group at all: groups() lists these under UNGROUPED, so that name
        // has to be a name inGroup() answers to (§4.11).
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
        // A display name that folds differently from its id — the only shape
        // that exercises name lookup rather than id lookup. Real: QGIS ships
        // `native:zonalstatisticsfb` named "Zonal statistics".
        {
          id: "extra:zonalstatisticsfb",
          name: "Zonal statistics",
          group: "Raster analysis",
          description: "Zonal stats.",
          helpText: "zonal help",
          parameters: [],
          outputs: [],
        },
        // One short id, two providers. Real: gdal:slope and native:slope, and
        // ten more pairs on a 3.44 install.
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
        // One display name, two algorithms, and it folds to nothing any id
        // folds to — the only shape where the name lookup itself has to choose.
        // Real: "Raster calculator" names four algorithms on a 3.44 install.
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

  it.effect("lookup answers to the forms the catalog itself prints", () =>
    Effect.gen(function* () {
      const catalog = yield* QgisCatalog.Service
      yield* catalog.build(ENVIRONMENT)

      // The consumer is a language model: it does not mistype, it re-spells.
      // Every form below is a re-spelling of something this catalog printed.
      expect((yield* catalog.get("Native:Buffer"))?.id).toBe("native:buffer") // case
      expect((yield* catalog.get("gdal:CLIPRASTERBYEXTENT"))?.id).toBe("gdal:cliprasterbyextent")
      expect((yield* catalog.get("clip_raster_by_extent"))?.id).toBe("gdal:cliprasterbyextent") // snake
      expect((yield* catalog.get("clip-raster-by-extent"))?.id).toBe("gdal:cliprasterbyextent") // kebab
      expect((yield* catalog.get("Clip raster by extent"))?.id).toBe("gdal:cliprasterbyextent") // spaces
      // A display name that shares no folded form with its id — the case that
      // only the name lookup can answer.
      expect((yield* catalog.get("Zonal statistics"))?.id).toBe("extra:zonalstatisticsfb")
      expect((yield* catalog.get("zonal statistics"))?.id).toBe("extra:zonalstatisticsfb")

      // Ambiguity is a miss, at every tolerance and by the same rule: two
      // algorithms sharing a short id, and two sharing a display name, both
      // answer nothing rather than whichever came first. Running an algorithm
      // the caller never asked for is the one failure it cannot detect.
      expect(yield* catalog.get("slope")).toBeUndefined()
      expect(yield* catalog.get("SLOPE")).toBeUndefined()
      expect(yield* catalog.get("Split lines")).toBeUndefined()
      expect(yield* catalog.get("split_lines")).toBeUndefined()

      // The full id always answers — it is the only key that cannot be
      // ambiguous, which is why it is the one the catalog prints first.
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

      // The whole reason this exists: `get` collapses two outcomes that need
      // opposite advice, and throws away a set it had already computed.
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

      // get stays the thin wrapper it claims to be: ambiguity reads as absence
      // for callers that only act on a hit.
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

      // groups() counts the groupless under UNGROUPED, so inGroup owes an
      // answer under that same name — the two used to disagree, which made a
      // listed group unreachable.
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
      // Subsequence semantics, same as the old build: dropped characters and
      // truncations still match ("bufer" → "buffer"), EXTRA ones never do
      // ("bufffer" → nothing), because the query has to be findable inside the
      // target. That limit is acceptable precisely because the re-spellings a
      // model actually produces — case, spaces, separators, display names —
      // are now resolved by get/inGroup before anything reaches this path.
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
  // Shared sandbox + process-global geo kernel: leave no machine.json behind
  // for a later test that assumes an unconfigured kernel.
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
