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

/* The execution pipeline (docs/GEOKERNEL.md §4.12): the pre-flight that advises and never vetoes, and the idle
 * clock whose floor the kernel enforces, a tiny value otherwise turning every quiet algorithm into a timeout. */

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
    const kinds = hints.map((hint) => hint.kind)
    expect(kinds).toEqual(["unknown-parameter", "missing-required", "defaults-applied"])
  })

  test("an absent parameter that has a default is stated once, with its value", () => {
    const hints = QgisExecutor.precheck("native:buffer", BUFFER, { INPUT: "/a.geojson" })
    expect(hints).toHaveLength(1)
    expect(hints[0]!.kind).toBe("defaults-applied")
    expect(hints[0]!.message).toContain("DISTANCE=10")
    expect(hints.filter((hint) => hint.kind === "defaults-applied")).toHaveLength(1)

    const missing = QgisExecutor.precheck("native:buffer", BUFFER, { DISTANCE: 5 })
    expect(missing.map((hint) => hint.kind)).toEqual(["missing-required"])
    expect(missing[0]!.message).toContain("has no default")
    // Catches the message hedging again about a fallback `defaultValue` has already ruled out.
    expect(missing[0]!.message).not.toContain("may fall back")
  })

  test("the in-script check no longer repeats what the catalog already stated", () => {
    // A text pin: this half runs inside QGIS, so what it catches is the guard being dropped in an edit.
    expect(QgisExecutor.RUNNER_SCRIPT).toContain("p.defaultValue() is None")
    expect(QgisExecutor.RUNNER_SCRIPT).not.toContain("QGIS may use defaults if available")
  })

  test("an enum accepts its options and their indices, and flags the rest", () => {
    expect(
      QgisExecutor.precheck("native:buffer", BUFFER, { INPUT: "/a", DISTANCE: 1, END_CAP_STYLE: "Round" }),
    ).toEqual([])
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
    const it = testEffect(
      LayerNode.compile(LayerNode.group([GeoRuntimeModule.node]), [[GeoRuntimeModule.node, capturingRuntime]]),
    )

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
          idleSeconds: 1, // below the floor
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

        // An algorithm must not inherit the reader's PAM guard (reader.ts NO_SIDECARS): some output formats keep
        // their coordinate system in the sidecar it suppresses (§7.6).
        expect(captured[0]!.env).toBe(environment.env)
        expect(captured[0]!.env).not.toHaveProperty("GDAL_PAM_ENABLED")
        expect(captured[0]!.command).toBe(environment.python)
        expect(captured[0]!.args[1]).toContain("ProgressFeedback")
        expect(captured[0]!.args[2]).toBe("native:buffer")
        expect(JSON.parse(captured[0]!.args[3]!)).toEqual({ INPUT: "/a" })
      }),
    )
  }
})
