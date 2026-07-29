export * as GdalService from "./index"

import { Context, Effect, Layer, Stream } from "effect"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { MachineConfig } from "../config"
import { GeoStatus } from "../status"
import { GdalEnv } from "./env"
import type { GdalTypes } from "./types"

export { GdalEnv } from "./env"
export type { Environment, Track } from "./types"

/* --- GeoCode: the GDAL lifecycle (docs/GEOKERNEL.md §7.3).
 *
 * Owns the status slot and is its only writer. The thinnest lifecycle in the
 * kernel, and deliberately so: the probe is file-existence checks, which means
 * **no intermediate state, no polling, and no self-healing**. There is exactly
 * one transition — the configuration changed, so look again.
 *
 * QGIS re-probes on tool retries because its failures include things a user
 * fixes without touching the config (§4.9). Nothing here is like that: every
 * state this module can report is either "the config points somewhere wrong"
 * or "that directory lacks a binary", and installing a binary is not something
 * a retry can be a signal for. The config watcher already covers the rest. --- */

/**
 * Why a track cannot run, or the environment to run it in.
 *
 * The refusal carries the whole status rather than a message, because §7.7
 * requires the data plane's errors to be structured: the interface reacts
 * differently to "not configured yet" than to "this install is missing two
 * binaries", and a rendered sentence would have thrown that away.
 */
export type Gate =
  | { readonly ok: true; readonly environment: GdalTypes.Environment }
  | { readonly ok: false; readonly status: GeoEvent.GdalStatus }

export interface Interface {
  /** The current verdict, for the status face. */
  readonly status: () => Effect.Effect<GeoEvent.GdalStatus>
  /**
   * Whether this track can run, answered with what it needs to run.
   *
   * Per track, not unified — the two tracks depend on disjoint tools, so one
   * being unusable says nothing about the other (§7.3, the opposite of QGIS's
   * single gate at §4.9).
   */
  readonly gate: (track: GdalTypes.Track) => Effect.Effect<Gate>
}

export class Service extends Context.Service<Service, Interface>()("@geocode/GdalService") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* MachineConfig.Service
    const status = yield* GeoStatus.Service
    const scope = yield* Effect.scope

    const initial: GeoEvent.GdalStatus = { status: "unconfigured" }
    const writer = yield* status.register("gdal", initial)

    let current: GeoEvent.GdalStatus = initial
    /**
     * Built alongside the verdict, not on demand.
     *
     * The verdict and the environment describe the same probe, so producing
     * them together is what keeps them from disagreeing. It also keeps the
     * Windows resource lookup off the hot path — a raster preview spawns
     * several subprocesses, and each one would otherwise re-walk the candidate
     * directories to reach the same answer.
     */
    let environment: GdalTypes.Environment | undefined

    const apply = (state: MachineConfig.BlockState<"gdal">) =>
      Effect.gen(function* () {
        const token = yield* writer.claim()
        // An unparsable block leaves us with no directory, which is the same
        // position as never having been told one. The parse failure itself is
        // reported by Config; repeating it here would be a second voice on a
        // subject this module has no information about (§3.1).
        const directory = state.ok ? state.value : undefined
        current = GdalEnv.classify(directory)
        environment =
          directory && current.status !== "unconfigured" && current.status !== "dir-missing"
            ? { directory, tools: GdalEnv.toolPaths(directory), env: GdalEnv.subprocessEnv(directory) }
            : undefined
        yield* writer.commit(token, current)
      })

    // Subscribing delivers the current value first, so this covers startup and
    // every later change with one path rather than an initial probe plus a
    // watcher that could disagree with it.
    yield* Effect.forkIn(Stream.runForEach(config.watch("gdal"), apply), scope)

    const gate = (track: GdalTypes.Track) =>
      Effect.sync((): Gate => {
        const usable = track === "raster" ? GdalEnv.rasterUsable(current) : GdalEnv.vectorUsable(current)
        if (!usable || !environment) return { ok: false, status: current }
        return { ok: true, environment }
      })

    return Service.of({ status: () => Effect.sync(() => current), gate })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [MachineConfig.node, GeoStatus.node] })
