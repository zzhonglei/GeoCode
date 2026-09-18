export * as GeoQgis from "./index"

import { Context, Effect, Fiber, Layer, Ref, Stream } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import { MachineConfig } from "../config"
import { GeoRuntime } from "../runtime"
import { GeoStatus } from "../status"
import { QgisCatalog } from "./catalog"
import { QgisResolve } from "./resolve"
import type { Diagnostics, Environment } from "./types"

/* Consumers reach submodules through these re-exports, never by importing a submodule directly (§9.1). */
export { QgisCatalog } from "./catalog"
export { QgisDestination } from "./destination"
export { QgisExecutor } from "./executor"
export { QgisGuidance } from "./guidance"
export { QgisReader } from "./reader"
export type { Environment } from "./types"

/* --- GeoCode: the QGIS module's lifecycle and sole writer of its status slot (docs/GEOKERNEL.md §4.8). No
 * self-healing re-probe, unlike GEE: re-probing here voids and rebuilds the catalog, stalling all three
 * capabilities. --- */

export type Gate =
  | { readonly ok: true; readonly environment: Environment }
  | { readonly ok: false; readonly status: GeoEvent.QgisStatus }

export interface Interface {
  readonly gate: () => Effect.Effect<Gate>
}

export class Service extends Context.Service<Service, Interface>()("@geocode/GeoQgis") {}

export const use = serviceUse(Service)

function toWire(diagnostics: Diagnostics): GeoEvent.QgisDiagnostics {
  const candidates: Record<string, string[]> = {}
  const selected: Record<string, string> = {}
  for (const [name, choice] of Object.entries(diagnostics.choices)) {
    candidates[name] = [...choice.candidates]
    if (choice.selected) selected[name] = choice.selected
  }
  return {
    track: diagnostics.track,
    attempted: diagnostics.attempted ? [...diagnostics.attempted] : undefined,
    interpreter: diagnostics.python,
    prefix: diagnostics.prefix,
    candidates,
    selected,
    checks: diagnostics.checks,
    dllDirectories: diagnostics.dllDirectories.length > 0 ? [...diagnostics.dllDirectories] : undefined,
    environment: diagnostics.env,
    output: diagnostics.output,
    error: diagnostics.error,
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* MachineConfig.Service
    const status = yield* GeoStatus.Service
    const runtime = yield* GeoRuntime.Service
    const catalog = yield* QgisCatalog.Service
    const scope = yield* Effect.scope

    const writer = yield* status.register("qgis", { status: "unconfigured" })

    /** Cleared at the start of every round, so the gate can never hand out one the round is re-verifying. */
    const held = yield* Ref.make<Environment | undefined>(undefined)

    const round = (state: MachineConfig.BlockState<"qgis">) =>
      Effect.gen(function* () {
        const token = yield* writer.claim()
        const commit = (value: GeoEvent.QgisStatus) => writer.commit(token, value)

        yield* body(state, commit).pipe(
          // A defect must not strand the slot mid-round, so it becomes a probe failure the user can see. Interruption
          // is not a defect and passes through.
          Effect.catchDefect((defect) =>
            Effect.asVoid(
              commit({
                status: "probe-failed",
                diagnostics: { error: `lifecycle defect: ${String(defect)}` },
              }),
            ),
          ),
        )
      })

    const body = (
      state: MachineConfig.BlockState<"qgis">,
      commit: (value: GeoEvent.QgisStatus) => Effect.Effect<boolean>,
    ) =>
      Effect.gen(function* () {
        // On every path below the new status lands before the held environment or the catalog is dropped: the gate
        // reads status first, so the inverse order leaves a moment where a ready status pairs with no environment.
        if (!state.ok) {
          yield* commit({ status: "config-error", file: state.failure.file, message: state.failure.message })
          yield* Ref.set(held, undefined)
          yield* catalog.invalidate()
          return
        }

        const hint = state.value?.trim()
        if (!hint) {
          yield* commit({ status: "unconfigured" })
          yield* Ref.set(held, undefined)
          yield* catalog.invalidate()
          return
        }

        yield* commit({ status: "resolving" })
        yield* Ref.set(held, undefined)
        yield* catalog.invalidate()
        const resolution = yield* QgisResolve.resolve(hint, runtime, {
          onProbing: Effect.asVoid(commit({ status: "probing" })),
        })

        if (!resolution.ok) {
          const wire = toWire(resolution.diagnostics)
          switch (resolution.failure) {
            case "path-missing":
              yield* commit({ status: "path-missing", hint })
              return
            case "not-qgis":
              yield* commit({ status: "not-qgis", hint })
              return
            default:
              yield* commit({ status: resolution.failure, diagnostics: wire })
              return
          }
        }

        const environment = resolution.environment
        yield* Ref.set(held, environment)
        // Here the environment goes first: set after a ready status, the gate could see ready and find nothing.

        // These ride every ready frame, since the environment object itself never reaches a surface (§9.1).
        const facts = {
          interpreter: environment.python,
          track: environment.track,
          versions: environment.versions,
        }

        if (!environment.processing) {
          yield* commit({ status: "ready", processing: false, catalog: "skipped", ...facts })
          return
        }
        yield* commit({ status: "ready", processing: true, catalog: "building", ...facts })

        const built = yield* catalog.build(environment)
        if (built.ok) {
          yield* commit({ status: "ready", processing: true, catalog: "ready", ...facts })
        } else {
          yield* commit({ status: "ready", processing: true, catalog: "failed", catalogError: built.error, ...facts })
        }
      })

    // A new block value interrupts the previous round, catalog build included, and the round's token makes any
    // straggler commit a no-op.
    let running: Fiber.Fiber<void, never> | undefined
    yield* Effect.forkIn(
      Stream.runForEach(config.watch("qgis"), (state) =>
        Effect.gen(function* () {
          if (running) yield* Fiber.interrupt(running)
          running = yield* Effect.forkIn(round(state), scope)
        }),
      ),
      scope,
    )

    const gate = (): Effect.Effect<Gate> =>
      Effect.gen(function* () {
        const current = yield* status.current("qgis")
        const environment = yield* Ref.get(held)
        if (
          current?.status === "ready" &&
          current.processing &&
          current.catalog === "ready" &&
          environment !== undefined
        ) {
          return { ok: true, environment }
        }
        // A new round can land between the two reads above; re-read so the answer is never "not ready: ready".
        const status_ =
          environment === undefined && current?.status === "ready" ? yield* status.current("qgis") : current
        return { ok: false, status: status_ ?? { status: "unconfigured" } }
      })

    return Service.of({ gate })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [MachineConfig.node, GeoStatus.node, GeoRuntime.node, QgisCatalog.node],
})
