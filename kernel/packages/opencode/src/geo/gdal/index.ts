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

/* --- GeoCode: the GDAL lifecycle, sole writer of the `gdal` status slot (docs/GEOKERNEL.md §7.3). --- */

/** The refusal carries the whole status, not a sentence: the data plane's errors have to be structured (§7.7). */
export type Gate =
  | { readonly ok: true; readonly environment: GdalTypes.Environment }
  | { readonly ok: false; readonly status: GeoEvent.GdalStatus }

export interface Interface {
  readonly status: () => Effect.Effect<GeoEvent.GdalStatus>
  /** Per track, not unified: the two depend on disjoint tools, so one being unusable says nothing about the other. */
  readonly gate: (track: GdalTypes.Track) => Effect.Effect<Gate>
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
    // Built with the verdict rather than on demand, so the two describe the same probe and the Windows resource
    // walk happens once per configuration instead of once per request.
    let environment: GdalTypes.Environment | undefined

    const apply = (state: MachineConfig.BlockState<"gdal">) =>
      Effect.gen(function* () {
        const token = yield* writer.claim()

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

    // `watch` emits the current value before any change, so startup and every later configuration take one path.
    yield* Effect.forkIn(Stream.runForEach(config.watch("gdal"), apply), scope)

    const gate = (track: GdalTypes.Track) =>
      Effect.sync((): Gate => {
        const usable = track === "raster" ? GdalEnv.rasterUsable(current) : GdalEnv.vectorUsable(current)
        if (!usable || !environment) return { ok: false, status: current }
        return { ok: true, environment }
      })

    // Before the pipelines exist, never beside them: a wipe racing a production takes the new artifact too (§7.6).
    yield* GdalCache.clear

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
