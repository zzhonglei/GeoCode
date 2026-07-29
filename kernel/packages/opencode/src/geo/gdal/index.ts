export * as GdalService from "./index"

import { Context, Effect, Layer, Stream } from "effect"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { MachineConfig } from "../config"
import { GeoRuntime } from "../runtime"
import { GeoStatus } from "../status"
import { GdalCache } from "./cache"
import { GdalEnv } from "./env"
import { GdalRaster } from "./raster"
import { GdalVector } from "./vector"
import type { GdalTypes } from "./types"

export { GdalAccess } from "./access"
export { GdalEnv } from "./env"
export { GdalRaster } from "./raster"
export { GdalVector } from "./vector"
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
  /**
   * The two pipelines, built once and owned here.
   *
   * They hold state that has to outlive a request — parsed layers, and the
   * merge that keeps concurrent callers to one production — so they cannot be
   * constructed per call. They are exposed already carrying their runtime, so
   * the data face never learns that a preview is subprocesses.
   */
  readonly vector: {
    readonly meta: (environment: GdalTypes.Environment, file: string) => Effect.Effect<GdalVector.Meta, Error>
    readonly content: (environment: GdalTypes.Environment, file: string) => Effect.Effect<string, Error>
    readonly page: (
      environment: GdalTypes.Environment,
      file: string,
      offset: number,
      limit: number,
    ) => Effect.Effect<GdalVector.Page, Error>
  }
  readonly raster: {
    readonly meta: (environment: GdalTypes.Environment, file: string) => Effect.Effect<GdalRaster.Meta, Error>
    readonly preview: (environment: GdalTypes.Environment, file: string) => Effect.Effect<GdalRaster.Preview, Error>
  }
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

        // A syntax error fails EVERY block (§3.1), and this module says so
        // rather than reporting the same thing as a machine that was never
        // configured. They are different facts and they need different answers
        // from the user: one has a file to fix, the other has a field to fill,
        // and telling the first user to configure GDAL sends them to redo work
        // they already did (§8.1).
        if (!state.ok) {
          current = { status: "config-error", file: state.failure.file, message: state.failure.message }
          environment = undefined
          yield* writer.commit(token, current)
          return
        }

        const directory = state.value
        current = GdalEnv.classify(directory)
        environment =
          directory && current.status !== "unconfigured" && current.status !== "dir-missing"
            ? {
                directory,
                fingerprint: state.fingerprint,
                tools: GdalEnv.toolPaths(directory),
                env: GdalEnv.subprocessEnv(directory),
              }
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

    // Every artifact from the last run goes, and it goes BEFORE the pipelines
    // exist rather than in the background beside them: a wipe racing a fresh
    // production would take the new artifact with the old ones. Blunt on
    // purpose — a cache that survives restarts needs a size budget and an
    // eviction policy, and it makes "what does a first view cost" unaskable
    // after the first run (§7.6).
    yield* GdalCache.clear

    // The pipelines are handed the runtime once, here, rather than yielding it
    // per call: their work outlives the request that triggered it, and a fiber
    // that has already gone is not a context to inherit from (§7.6).
    const runtime = yield* GeoRuntime.Service
    const supplied = <A, E>(effect: Effect.Effect<A, E, GeoRuntime.Service>) =>
      Effect.provideService(effect, GeoRuntime.Service, runtime)
    const vector = yield* GdalVector.make()
    const raster = yield* GdalRaster.make()

    return Service.of({
      status: () => Effect.sync(() => current),
      gate,
      vector: {
        meta: (environment, file) => supplied(vector.meta(environment, file)),
        content: (environment, file) => supplied(vector.content(environment, file)),
        page: (environment, file, offset, limit) => supplied(vector.page(environment, file, offset, limit)),
      },
      raster: {
        meta: (environment, file) => supplied(raster.meta(environment, file)),
        preview: (environment, file) => supplied(raster.preview(environment, file)),
      },
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [MachineConfig.node, GeoRuntime.node, GeoStatus.node],
})
