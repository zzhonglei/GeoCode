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

/* These and the gate below are the module's face (§9.1); importing a submodule directly is how one module ends up
 * with two calling conventions. */
export { QgisCatalog } from "./catalog"
export { QgisDestination } from "./destination"
export { QgisExecutor } from "./executor"
export { QgisGuidance } from "./guidance"
export { QgisReader } from "./reader"
export type { Environment } from "./types"

/* --- GeoCode: the QGIS module's lifecycle (docs/GEOKERNEL.md §4.8–§4.10).
 *
 * Sole writer of the status slot; one round per `machine.json` qgis block value, `config.watch` emitting the
 * current one at startup. Environment verification and catalog construction each commit as they land (§4.10). No
 * self-healing re-probe, unlike GEE: re-probing here voids and rebuilds the catalog, stalling all three
 * capabilities (§4.8 迁移纪律 1). --- */

/** What the unified gate answers (§4.9). */
export type Gate =
  | { readonly ok: true; readonly environment: Environment }
  | { readonly ok: false; readonly status: GeoEvent.QgisStatus }

export interface Interface {
  /**
   * The single readiness verdict all three capabilities share (§4.9). Ready hands back the verified environment
   * object itself, which execution entry points take rather than re-checking (§9.1).
   */
  readonly gate: () => Effect.Effect<Gate>
}

export class Service extends Context.Service<Service, Interface>()("@geocode/GeoQgis") {}

export const use = serviceUse(Service)

/** The internal diagnostics shape, flattened onto the wire schema. */
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

    /**
     * The environment behind the current `ready`. Cleared at the start of every round, so the gate can never hand
     * out one that the round in progress is re-verifying.
     */
    const held = yield* Ref.make<Environment | undefined>(undefined)

    const round = (state: MachineConfig.BlockState<"qgis">) =>
      Effect.gen(function* () {
        const token = yield* writer.claim()
        const commit = (value: GeoEvent.QgisStatus) => writer.commit(token, value)

        yield* body(state, commit).pipe(
          // A defect must not strand the slot mid-round with nobody reporting anything, so whatever blew up
          // becomes a probe failure the user can see. Interruption is not a defect and passes through.
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
        // Ordering rule for every path below: the new status lands BEFORE the held environment or the catalog is
        // dropped. The gate reads status first, so the inverse order leaves a moment where a still-ready status
        // pairs with no environment.

        // An unparsable file arrives as every block failing; showing that as "unconfigured" would contradict the
        // file the user is looking at (§3.1).
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
        // The catalog belongs to the verification that produced it, and this round is redoing it (§4.8 阶段依附).
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
        // (Here the inverse order is the safe one: the environment must exist before any ready status is visible,
        // or the gate could see ready and find nothing to hand out.)

        // The environment object itself never leaves the kernel (§9.1), so facts a status surface needs are
        // nowhere unless they ride every ready frame.
        const facts = {
          interpreter: environment.python,
          track: environment.track,
          versions: environment.versions,
        }

        // Stage one lands NOW; the catalog stage reports its own progress under the same token (§4.10 提交时机).
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

    // One round at a time: a new block value interrupts whatever the previous one was still doing, including a
    // catalog build in flight, and the round's token makes any straggler commit a no-op (§4.8, §3.4).
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
        // Not ready carries the status only; wording the guidance is the tool layer's job (§4.9, §8.6).
        //
        // Re-read when the environment is what is missing: a new round can land between the two reads above, and
        // reporting the ready status it just replaced would hand the reader "not ready: ready".
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
