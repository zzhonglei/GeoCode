import { afterAll, describe, expect } from "bun:test"
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

/* The local dependency chain (docs/GEOKERNEL.md §5.3).
 *
 * The probe script also ran against the real conda environment on this
 * machine — all four packages present, credentials on disk, ee 1.7.24 — and
 * against the system interpreter, which reported exactly the three packages it
 * lacks. These tests freeze the decisions: the chain short-circuits in
 * dependency order, the manifest travels as data, and the probe stays offline. */

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
      // Probe needs the module name, guidance needs the install name and the
      // role. A manifest missing any of the three would force a second list,
      // and a second list is the thing this one exists to prevent (§5.3).
      for (const dep of GeeDeps.DEPS) {
        expect(dep.pkg.length).toBeGreaterThan(0)
        expect(dep.module.length).toBeGreaterThan(0)
        expect(dep.role.length).toBeGreaterThan(0)
      }
      expect(GeeDeps.PACKAGES).toEqual(GeeDeps.DEPS.map((dep) => dep.pkg))
      // The manifest covers what the runtime library imports, not just the
      // client — verified against its source. geedim is the one that proves
      // the point: geemap needs it but does not install it.
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
        // Step one never starts a subprocess: there is nothing to run yet.
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
        expect(state).toEqual({ status: "packages-missing", missing: ["geedim", "geemap"] })

        // The manifest goes over as an ARGUMENT the script parses, never
        // spliced into the source. A package name is a string from a list we
        // edit; pasting strings into source is how a list edit becomes a
        // syntax error (§5.3).
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
    const { it, body } = run([{ stdout: marked({ missing: [], credentials: false, version: "1.7.24" }) }], (runtime) =>
      Effect.gen(function* () {
        // Packages complete, credentials absent — the chain stops here even
        // though the project is also unset. One problem at a time (§5.11).
        expect(yield* GeeSetup.probe(runtime, { python })).toEqual({ status: "credentials-missing" })
      }),
    )
    it.effect("credentials come before the project, and stop the chain alone", body)
  }

  {
    const { it, body } = run(
      [{ stdout: marked({ missing: [], credentials: false, credentials_error: "cannot import name 'oauth'" }) }],
      (runtime) =>
        Effect.gen(function* () {
          // The client library imported fine a moment earlier, so a credential
          // path we cannot reach means the installation is wrong. Calling that
          // "credentials-missing" would send the user to run an authentication
          // command that cannot fix it — the same misattribution class as a
          // diagnostic that marks a healthy path red.
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

        // The offline discipline (§5.3). Note what is asserted: the spawned
        // process INHERITS our environment, so leaving these unset would not
        // remove them — an ambient proxy from the user's shell would still
        // arrive. They have to be blanked, which is Net's own direct-route
        // form. Without it, a dead ambient proxy plus one import that dials
        // out becomes a probe timeout, reported to the user as a broken local
        // environment.
        for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
          expect(env[key]).toBe("")
        }
        // Nor is the project handed to the probe: it is checked here, from
        // config, and the probe has no business knowing it.
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
            // No marker: the raw output IS the diagnosis, led by how the
            // process ended (§4.6 失败分级, applied here too).
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
        // A report without the field the whole grading turns on is not a
        // report. Reading it as "nothing missing" would call a broken probe a
        // healthy environment.
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
        // A spawn that never starts — the path is a directory, or not
        // executable. Normal user input, so it grades rather than dying.
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
