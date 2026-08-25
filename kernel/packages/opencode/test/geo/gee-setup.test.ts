import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { GeoRuntime } from "@/geo/runtime"
import { GeoRuntime as GeoRuntimeModule } from "@/geo/runtime"
import { GeeDeps } from "@/geo/gee/deps"
import { GeeSetup } from "@/geo/gee/setup"
import { testEffect } from "../lib/effect"

/* The local dependency chain (docs/GEOKERNEL.md §5.3): it short-circuits in dependency order so the guidance starts
 * where it stopped, the manifest travels as data, and the probe reaches nothing over the network. */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "geo-gee-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const python = path.join(root, "python3")
fs.writeFileSync(python, "")

const marked = (payload: unknown) => `${GeeSetup.MARKER}${JSON.stringify(payload)}\n`

interface StubCall {
  readonly options: GeoRuntime.Options
}

const run = <A>(
  results: Partial<GeoRuntime.Result>[],
  body: (runtime: GeoRuntime.Interface, calls: StubCall[]) => Effect.Effect<A, Error>,
) => {
  const calls: StubCall[] = []
  let index = 0
  const layer = Layer.mock(GeoRuntimeModule.Service)({
    run: (options: GeoRuntime.Options) => {
      calls.push({ options })
      const result = results[Math.min(index++, results.length - 1)] ?? {}
      return Effect.succeed({
        reason: "exit",
        code: 0,
        stdout: "",
        stderr: "",
        durationMs: 5,
        truncated: false,
        drainIncomplete: false,
        ...result,
      } satisfies GeoRuntime.Result)
    },
    killAllSync: () => {},
  })
  const it = testEffect(LayerNode.compile(LayerNode.group([GeoRuntimeModule.node]), [[GeoRuntimeModule.node, layer]]))
  return {
    it,
    body: () =>
      Effect.gen(function* () {
        const runtime = yield* GeoRuntimeModule.Service
        return yield* body(runtime, calls)
      }),
  }
}

describe("gee dependency manifest", () => {
  const it = testEffect(LayerNode.compile(LayerNode.group([GeoRuntimeModule.node])))

  it.effect("is one list with both consumers' fields", () =>
    Effect.sync(() => {
      // The probe reads `module`, the guidance renders `pkg` and `role`; a gap in any of the three forces the second
      // list §5.3 exists to prevent.
      for (const dep of GeeDeps.DEPS) {
        expect(dep.pkg.length).toBeGreaterThan(0)
        expect(dep.module.length).toBeGreaterThan(0)
        expect(dep.role.length).toBeGreaterThan(0)
      }
      expect(GeeDeps.PACKAGES).toEqual(GeeDeps.DEPS.map((dep) => dep.pkg))
      // What the runtime library imports, not just the client: geemap needs geedim and does not install it.
      expect(GeeDeps.PACKAGES).toContain("geedim")
      expect(GeeDeps.byPackage("geedim")?.module).toBe("geedim")
      expect(GeeDeps.byPackage("nothing-like-this")).toBeUndefined()
    }),
  )
})

describe("gee setup chain", () => {
  {
    const { it, body } = run([], (runtime, calls) =>
      Effect.gen(function* () {
        expect(yield* GeeSetup.probe(runtime, undefined)).toEqual({ status: "unconfigured" })
        expect(yield* GeeSetup.probe(runtime, {})).toEqual({ status: "unconfigured" })
        // Whitespace is not a configuration.
        expect(yield* GeeSetup.probe(runtime, { python: "   " })).toEqual({ status: "unconfigured" })
        expect(calls).toHaveLength(0)
      }),
    )
    it.effect("an unconfigured interpreter stops the chain before any spawn", body)
  }

  {
    const { it, body } = run([], (runtime, calls) =>
      Effect.gen(function* () {
        const state = yield* GeeSetup.probe(runtime, { python: path.join(root, "gone"), project: "p" })
        expect(state).toEqual({ status: "python-missing", python: path.join(root, "gone") })
        expect(calls).toHaveLength(0)
      }),
    )
    it.effect("a missing interpreter is named, and still nothing is spawned", body)
  }

  {
    const { it, body } = run([{ stdout: marked({ missing: ["geedim", "geemap"] }) }], (runtime, calls) =>
      Effect.gen(function* () {
        const state = yield* GeeSetup.probe(runtime, { python, project: "p" })
        // The interpreter travels with the gap: the guidance for this step is `<python> -m pip install <pkg>`.
        expect(state).toEqual({ status: "packages-missing", python, missing: ["geedim", "geemap"] })

        // An argument the script parses, never spliced into its source, so editing the list cannot make it a syntax
        // error (§5.3).
        const options = calls[0]!.options
        expect(options.args[0]).toBe("-c")
        const manifest = JSON.parse(options.args[2]!)
        expect(manifest).toEqual(GeeDeps.DEPS.map((dep) => ({ pkg: dep.pkg, module: dep.module })))
        expect(options.args[1]).not.toContain("import ee")
      }),
    )
    it.effect("missing packages are named individually and travel as data", body)
  }

  {
    const { it, body } = run(
      // Shaped as the script emits it: `missing` is always present, and `broken` rides alongside it when an import
      // raised something other than ImportError.
      [
        {
          stdout: marked({
            missing: [],
            broken: { pkg: "geopandas", error: "ImportError: DLL load failed while importing _fiona" },
          }),
        },
      ],
      (runtime) =>
        Effect.gen(function* () {
          const state = yield* GeeSetup.probe(runtime, { python, project: "p" })
          // Reported as absent, the fix offered is `pip install` of what the user already has.
          expect(state.status).toBe("packages-broken")
          if (state.status === "packages-broken") {
            expect(state.pkg).toBe("geopandas")
            expect(state.python).toBe(python)
            expect(state.error).toContain("DLL load failed")
          }
        }),
    )
    it.effect("a package that is installed and unusable is not reported as absent", body)
  }

  test("the distinction is drawn in the Python, where no scripted runtime can see it", () => {
    // The runtime is scripted everywhere above, so a single broad `except` would collapse broken into missing at the
    // source with every one of those tests still green.
    expect(GeeSetup.SCRIPT).toContain("except ImportError:")
    expect(GeeSetup.SCRIPT).toMatch(/except Exception as e:[\s\S]*report\["broken"\]/)
  })

  {
    const { it, body } = run([{ stdout: marked({ missing: [], credentials: false, version: "1.7.24" }) }], (runtime) =>
      Effect.gen(function* () {
        // The project is unset too, and is not what the user is sent to fix: one problem at a time (§5.11).
        expect(yield* GeeSetup.probe(runtime, { python })).toEqual({ status: "credentials-missing", python })
      }),
    )
    it.effect("credentials come before the project, and stop the chain alone", body)
  }

  {
    const { it, body } = run(
      [{ stdout: marked({ missing: [], credentials: false, credentials_error: "cannot import name 'oauth'" }) }],
      (runtime) =>
        Effect.gen(function* () {
          // `credentials-missing` would send the user to an authentication command that cannot fix a bad install.
          const state = yield* GeeSetup.probe(runtime, { python, project: "p" })
          expect(state.status).toBe("probe-failed")
          if (state.status === "probe-failed") expect(state.error).toContain("cannot import name 'oauth'")
        }),
    )
    it.effect("a credential check that broke is not a missing credential", body)
  }

  {
    const { it, body } = run([{ stdout: marked({ missing: [], credentials: true }) }], (runtime) =>
      Effect.gen(function* () {
        expect(yield* GeeSetup.probe(runtime, { python })).toEqual({ status: "project-missing" })
        expect(yield* GeeSetup.probe(runtime, { python, project: "  " })).toEqual({ status: "project-missing" })
        expect(yield* GeeSetup.probe(runtime, { python, project: "my-project" })).toEqual({
          status: "ready",
          python,
          project: "my-project",
          version: undefined,
        })
      }),
    )
    it.effect("the project is the last link, and completes the chain", body)
  }

  {
    const { it, body } = run([{ stdout: marked({ missing: [], credentials: true }) }], (runtime, calls) =>
      Effect.gen(function* () {
        yield* GeeSetup.probe(runtime, { python, project: "my-project" })
        const env = calls[0]!.options.env!

        // Blanked, not merely unset: the spawn inherits our environment, so an ambient proxy from the user's shell
        // would otherwise arrive and turn one import that dials out into a probe timeout (§3.3 直连需显式清除).
        for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
          expect(env[key]).toBe("")
        }
        expect(JSON.stringify(env)).not.toContain("my-project")
        expect(env.PYTHONUTF8).toBe("1")
      }),
    )
    it.effect("the probe runs offline and knows nothing about the project", body)
  }

  {
    const { it, body } = run([{ reason: "timeout", code: null, stdout: "" }], (runtime) =>
      Effect.gen(function* () {
        expect(yield* GeeSetup.probe(runtime, { python, project: "p" })).toEqual({ status: "probe-timeout" })
      }),
    )
    it.effect("a timeout is its own state, not a generic failure", body)
  }

  {
    const { it, body } = run(
      [{ stdout: "Traceback: something native died\n", stderr: "stack", reason: "crash", code: null }],
      (runtime) =>
        Effect.gen(function* () {
          const state = yield* GeeSetup.probe(runtime, { python, project: "p" })
          expect(state.status).toBe("probe-failed")
          if (state.status === "probe-failed") {
            // No marker, so the raw output is the whole diagnosis, led by how the process ended.
            expect(state.error).toContain("no report")
            expect(state.error).toContain("[process crash]")
            expect(state.error).toContain("something native died")
            expect(state.error).toContain("stack")
          }
        }),
    )
    it.effect("a crash without a report keeps the raw output", body)
  }

  {
    const { it, body } = run([{ stdout: `${GeeSetup.MARKER}{not json at all` }], (runtime) =>
      Effect.gen(function* () {
        const state = yield* GeeSetup.probe(runtime, { python, project: "p" })
        expect(state.status).toBe("probe-failed")
        if (state.status === "probe-failed") expect(state.error).toContain("would not parse")
      }),
    )
    it.effect("an unreadable report is distinguished from a missing one", body)
  }

  {
    const { it, body } = run([{ stdout: marked({ credentials: true }) }], (runtime) =>
      Effect.gen(function* () {
        // Reading an absent `missing` as "nothing missing" would grade a broken probe as a healthy environment.
        const state = yield* GeeSetup.probe(runtime, { python, project: "p" })
        expect(state.status).toBe("probe-failed")
        if (state.status === "probe-failed") expect(state.error).toContain("expected shape")
      }),
    )
    it.effect("a report missing its key field is a failure, not a pass", body)
  }

  {
    const { it, body } = run([], (runtime) =>
      Effect.gen(function* () {
        // A path that names a directory, or a file that is not executable — normal user input, not a defect.
        const failing = {
          ...runtime,
          run: () => Effect.fail(new Error("spawn EACCES\nwith a very long command line attached")),
        } as GeoRuntime.Interface
        const state = yield* GeeSetup.probe(failing, { python, project: "p" })
        expect(state.status).toBe("probe-failed")
        if (state.status === "probe-failed") {
          expect(state.error).toContain("spawn EACCES")
          // First line only — the spawner's message embeds the whole script.
          expect(state.error).not.toContain("very long command line")
        }
      }),
    )
    it.effect("a spawn that fails outright is graded, not thrown", body)
  }
})
