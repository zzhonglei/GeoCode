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

export { QgisCatalog } from "./catalog"
export type { Environment } from "./types"

/* --- GeoCode: the QGIS module's lifecycle (docs/GEOKERNEL.md §4.8–§4.10).
 *
 * Owns the status slot as its only writer, answers the two triggers — startup
 * and a change to the machine.json qgis block — and chains the two stages:
 * environment verification, then catalog construction. Each stage commits as
 * it lands rather than waiting for the next (§4.10), which is why users see
 * resolving → probing → ready(building) → ready instead of one long silence.
 *
 * There is deliberately NO self-healing re-probe here, unlike GEE (§4.8, and
 * the tradeoff record in §12): a re-probe in this module is a compound action
 * — it voids and rebuilds the catalog, stalling all three capabilities — and
 * nearly every fix a user can make goes through the config file, which is
 * already watched. --- */

/** What the unified gate answers (§4.9). */
export type Gate =
  | { readonly ok: true; readonly environment: Environment }
  | { readonly ok: false; readonly status: GeoEvent.QgisStatus }

export interface Interface {
  /**
   * The single readiness verdict all three capabilities share (§4.9): one
   * environment, one conclusion. Ready hands back the verified environment
   * object itself — execution entry points receive it rather than re-checking
   * (§9.1), closing the window between verdict and spawn.
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
     * The environment behind the current `ready`, if any. Cleared at the start
     * of every round so the gate can never hand out an environment the round
     * in progress is re-verifying.
     */
    const held = yield* Ref.make<Environment | undefined>(undefined)

    const round = (state: MachineConfig.BlockState<"qgis">) =>
      Effect.gen(function* () {
        const token = yield* writer.claim()
        const commit = (value: GeoEvent.QgisStatus) => writer.commit(token, value)

        yield* body(state, commit).pipe(
          // A defect in a round must not strand the slot on an intermediate
          // state with nobody reporting anything: whatever blew up becomes a
          // probe failure the user can see. Interruption is not a defect and
          // passes through — a superseded round just stops.
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
        // Ordering rule for every path below: the slot's new state lands
        // BEFORE the held environment or catalog is dropped. The gate reads
        // status first, so the inverse order has a moment where a still-ready
        // status pairs with no environment — an answer that contradicts
        // itself. This way the stale extras sit unreachable behind a
        // no-longer-ready status until the next line clears them.

        // A syntax error fails every block; showing it as "unconfigured" would
        // contradict the file the user is looking at (§3.1).
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
        // The catalog belongs to the verification that produced it; a new
        // round means that verification is being redone (§4.8 阶段依附).
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
        // (Here the inverse order is the safe one: the environment must exist
        // before any ready status is visible, or the gate could see ready and
        // find nothing to hand out.)

        // Stage one lands NOW; the catalog stage reports its own progress
        // under the same token (§4.10 提交时机, §3.4 令牌覆盖整轮).
        if (!environment.processing) {
          yield* commit({ status: "ready", processing: false, catalog: "skipped" })
          return
        }
        yield* commit({ status: "ready", processing: true, catalog: "building" })

        const built = yield* catalog.build(environment)
        if (built.ok) {
          yield* commit({ status: "ready", processing: true, catalog: "ready" })
        } else {
          yield* commit({ status: "ready", processing: true, catalog: "failed", catalogError: built.error })
        }
      })

    // One round at a time: a new block value interrupts whatever the previous
    // one was still doing — including a catalog build in flight — and the
    // generation token makes any of its stragglers uncommittable (§4.8).
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
        // Not ready is ONE verdict for all three capabilities: the environment
        // is one fact, and three different stories about it would read as
        // three different problems (§4.9). Guidance wording is the tool
        // layer's job (§8.6); the status carries the facts.
        return { ok: false, status: current ?? { status: "unconfigured" } }
      })

    return Service.of({ gate })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [MachineConfig.node, GeoStatus.node, GeoRuntime.node, QgisCatalog.node],
})
