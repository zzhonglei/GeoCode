import { describe, expect, test } from "bun:test"
import { Duration, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GeoOutput } from "@/geo/runtime/output"
import type { GeoRuntime } from "@/geo/runtime"
import { GeoRuntime as GeoRuntimeModule } from "@/geo/runtime"
import type { Algorithm } from "@/geo/qgis/catalog"
import { QgisExecutor } from "@/geo/qgis/executor"
import type { Environment } from "@/geo/qgis/types"
import { testEffect } from "../lib/effect"

/* The execution pipeline (docs/GEOKERNEL.md §4.12).
 *
 * The pipeline also ran against real QGIS 3.44.9 — native:buffer over a small
 * GeoJSON, progress lines and all. These tests freeze the pieces that carry
 * design decisions: the pre-flight that advises and never vetoes, and the
 * idle clock whose floor the kernel enforces because a tiny value turns every
 * quiet algorithm into a timeout. */

const BUFFER: Algorithm = {
  id: "native:buffer",
  name: "Buffer",
  group: "Vector geometry",
  description: "",
  helpText: "",
  parameters: [
    { name: "INPUT", description: "", type: "source", defaultValue: null, options: [], optional: false },
    { name: "DISTANCE", description: "", type: "distance", defaultValue: "10", options: [], optional: false },
    { name: "OUTPUT", description: "", type: "sink", defaultValue: null, options: [], optional: true },
    {
      name: "END_CAP_STYLE",
      description: "",
      type: "enum",
      defaultValue: "0",
      options: ["Round", "Flat", "Square"],
      optional: true,
    },
  ],
  outputs: [],
}

describe("qgis executor precheck", () => {
  test("a clean call earns no hints", () => {
    expect(QgisExecutor.precheck("native:buffer", BUFFER, { INPUT: "/a.geojson", DISTANCE: 5 })).toEqual([])
  })

  test("an unknown algorithm carries the nearest candidates", () => {
    const hints = QgisExecutor.precheck("native:bufer", undefined, {}, ["native:buffer", "native:wedgebuffers"])
    expect(hints).toHaveLength(1)
    expect(hints[0]!.kind).toBe("unknown-algorithm")
    expect(hints[0]!.message).toContain("native:buffer")
  })

  test("unknown and missing parameters are separate findings", () => {
    const hints = QgisExecutor.precheck("native:buffer", BUFFER, { INPUTT: "/a.geojson" })
    const kinds = hints.map((hint) => hint.kind).sort()
    // INPUTT unknown; INPUT and DISTANCE missing — but each is a hint, and
    // none of them stops anything: the metadata cannot express every
    // constraint, so blocking on it would turn its gaps into "cannot run"
    // (§4.12, §12).
    expect(kinds).toEqual(["missing-required", "missing-required", "unknown-parameter"])
  })

  test("an enum accepts its options and their indices, and flags the rest", () => {
    expect(QgisExecutor.precheck("native:buffer", BUFFER, { INPUT: "/a", DISTANCE: 1, END_CAP_STYLE: "Round" })).toEqual([])
    expect(QgisExecutor.precheck("native:buffer", BUFFER, { INPUT: "/a", DISTANCE: 1, END_CAP_STYLE: 2 })).toEqual([])
    const hints = QgisExecutor.precheck("native:buffer", BUFFER, { INPUT: "/a", DISTANCE: 1, END_CAP_STYLE: "Rounded" })
    expect(hints).toHaveLength(1)
    expect(hints[0]!.kind).toBe("invalid-choice")
  })
})

describe("qgis executor pipeline", () => {
  test("the display name is read from the runner's early line", () => {
    expect(QgisExecutor.displayName("Algorithm name: Buffer\nStarting algorithm: native:buffer\n")).toBe("Buffer")
    expect(QgisExecutor.displayName("no name here")).toBeUndefined()
  })

  test("a structured script error upgrades the message, absence changes nothing", () => {
    expect(GeoOutput.structuredError('Traceback...\n{"error": "input layer has no features"}\n')).toBe(
      "input layer has no features",
    )
    expect(GeoOutput.structuredError("plain traceback")).toBeUndefined()
    expect(GeoOutput.structuredError('{"error": 42}')).toBeUndefined()
  })

  {
    const captured: GeoRuntime.Options[] = []
    const capturingRuntime = Layer.mock(GeoRuntimeModule.Service)({
      run: (options) => {
        captured.push(options)
        return Effect.succeed({
          code: 0,
          reason: "exit",
          stdout: "",
          stderr: "",
          durationMs: 1,
          truncated: false,
          drainIncomplete: false,
        } satisfies GeoRuntime.Result)
      },
      killAllSync: () => {},
    })
    const it = testEffect(LayerNode.compile(LayerNode.group([GeoRuntimeModule.node]), [[GeoRuntimeModule.node, capturingRuntime]]))

    const environment: Environment = {
      python: "/fake/python3.12",
      prefix: "/fake",
      env: { QGIS_PREFIX_PATH: "/fake" },
      dllDirectories: [],
      versions: { python: "3", gdal: "3", qgis: "3" },
      processing: true,
    }

    it.effect("the idle clock is caller-given, floored, and defaulted", () =>
      Effect.gen(function* () {
        const runtime = yield* GeoRuntimeModule.Service

        yield* QgisExecutor.runAlgorithm(runtime, environment, {
          algorithm: "native:buffer",
          parameters: { INPUT: "/a" },
          idleSeconds: 1, // below the floor: would kill every quiet algorithm
          onChunk: () => Effect.void,
        })
        yield* QgisExecutor.runAlgorithm(runtime, environment, {
          algorithm: "native:buffer",
          parameters: { INPUT: "/a" },
          onChunk: () => Effect.void,
        })
        yield* QgisExecutor.runAlgorithm(runtime, environment, {
          algorithm: "native:buffer",
          parameters: { INPUT: "/a" },
          idleSeconds: 300,
          onChunk: () => Effect.void,
        })

        const idles = captured.map((options) => Duration.toMillis(options.clocks.idle!))
        expect(idles).toEqual([10_000, 60_000, 300_000])

        // The verified environment rides the spawn whole, and the parameters
        // travel as the argument the runner reads.
        expect(captured[0]!.env).toBe(environment.env)
        expect(captured[0]!.command).toBe(environment.python)
        expect(captured[0]!.args[1]).toContain("ProgressFeedback")
        expect(captured[0]!.args[2]).toBe("native:buffer")
        expect(JSON.parse(captured[0]!.args[3]!)).toEqual({ INPUT: "/a" })
      }),
    )
  }
})
