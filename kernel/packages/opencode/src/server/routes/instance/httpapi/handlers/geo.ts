import { readFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceState } from "@/effect/instance-state"
import { MachineConfig } from "@/geo/config"
import { GdalAccess, GdalRaster, GdalService, GdalVector } from "@/geo/gdal"
import type { GdalTypes } from "@/geo/gdal/types"
import { GeoStatus } from "@/geo/status"
import { InstanceHttpApi, RootHttpApi } from "../api"
import {
  ApiGeoAccessError,
  ApiGeoEnvironmentError,
  ApiGeoNotFoundError,
  ApiGeoPreviewError,
  PREVIEW_META_HEADER,
} from "../groups/geo"

/* --- GeoCode: handlers for the data face (docs/GEOKERNEL.md §10.1 #3). --- */

export const GeoHandler = HttpApiBuilder.group(RootHttpApi, "geo", (handlers) =>
  handlers
    .handle("status", () =>
      Effect.gen(function* () {
        const status = yield* GeoStatus.Service
        return yield* status.snapshot()
      }),
    )
    .handle("reload", () =>
      Effect.gen(function* () {
        const config = yield* MachineConfig.Service
        yield* config.reload()
        return { reloaded: true as const }
      }),
    ),
)

/**
 * What every preview request has to establish before it can do anything.
 *
 * Path first, environment second, and the order is deliberate: an escaping path
 * is refused whether or not a toolchain is installed, and answering "GDAL is
 * not configured" to a request that was never allowed to name that file would
 * be telling the caller something about a machine they have no business
 * reading (§7.8).
 *
 * The service is yielded here rather than while the handler layer is built —
 * GeoKernel is mounted on the application runtime's service graph rather than
 * the route layer's, so a construction-time requirement has nowhere to be
 * satisfied. The status handlers above do the same.
 */
const opened = (track: GdalTypes.Track, requested: string) =>
  Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const resolved = GdalAccess.resolve(instance, requested)
    if (!resolved.ok) {
      return yield* resolved.reason === "escapes"
        ? Effect.fail(new ApiGeoAccessError({ message: `${requested} resolves outside this project` }))
        : Effect.fail(new ApiGeoNotFoundError({ message: `${requested} does not exist` }))
    }

    const gdal = yield* GdalService.Service
    const gate = yield* gdal.gate(track)
    if (!gate.ok) {
      return yield* Effect.fail(
        new ApiGeoEnvironmentError({
          message: `the GDAL ${track} tools are not available`,
          status: gate.status,
        }),
      )
    }
    return { file: resolved.file, environment: gate.environment, gdal }
  })

/**
 * A pipeline failure, in the terms the interface acts on.
 *
 * Two of these are not faults at all: a plain image gets shown as a picture and
 * an oversized layer gets read by page. Collapsing them into one message would
 * leave the interface with a sentence it cannot reason about (§7.7).
 */
const reported = <A, R>(effect: Effect.Effect<A, Error, R>) =>
  Effect.mapError(effect, (error) => {
    if (error instanceof GdalRaster.GdalRasterError && error.kind === "not-geographic") {
      return new ApiGeoPreviewError({ message: error.message, kind: "not-geographic" })
    }
    if (error instanceof GdalVector.GdalVectorError && error.kind === "too-many-features") {
      return new ApiGeoPreviewError({
        message: error.message,
        kind: "too-many-features",
        featureCount: error.featureCount,
      })
    }
    return new ApiGeoPreviewError({ message: error.message, kind: "unreadable" })
  })

/** The format family, as the interface knows it: `geojson`, `shp`, `gpkg`, … */
const family = (file: string) => path.extname(file).toLowerCase().replace(/^\./, "")

export const GeoPreviewHandler = HttpApiBuilder.group(InstanceHttpApi, "geo-preview", (handlers) =>
  handlers
    .handle("vectorMeta", (ctx) =>
      Effect.gen(function* () {
        const { file, environment, gdal } = yield* opened("vector", ctx.query.path)
        const meta = yield* reported(gdal.vector.meta(environment, file))
        return {
          source: family(file),
          feature_count: meta.featureCount,
          geometry_types: meta.geometryTypes,
          projection: meta.projection,
          properties: meta.properties,
        }
      }),
    )
    .handle("vector", (ctx) =>
      Effect.gen(function* () {
        const { file, environment, gdal } = yield* opened("vector", ctx.query.path)
        return { content: yield* reported(gdal.vector.content(environment, file)) }
      }),
    )
    .handle("vectorPage", (ctx) =>
      Effect.gen(function* () {
        const { file, environment, gdal } = yield* opened("vector", ctx.query.path)
        const offset = ctx.query.offset ?? 0
        const limit = ctx.query.limit ?? 100
        const page = yield* reported(gdal.vector.page(environment, file, offset, limit))
        return { features: page.features, total: page.total, offset: page.offset, limit: page.limit }
      }),
    )
    .handle("rasterMeta", (ctx) =>
      Effect.gen(function* () {
        const { file, environment, gdal } = yield* opened("raster", ctx.query.path)
        const meta = yield* reported(gdal.raster.meta(environment, file))
        return {
          geo: meta.geographic,
          projection: meta.projection,
          width: meta.width,
          height: meta.height,
          band_count: meta.bandCount,
        }
      }),
    )
    .handleRaw("rasterImage", (ctx) =>
      Effect.gen(function* () {
        const { file, environment, gdal } = yield* opened("raster", ctx.query.path)
        const preview = yield* reported(gdal.raster.preview(environment, file))
        const bytes = yield* Effect.try({
          try: () => new Uint8Array(readFileSync(preview.image)),
          catch: () => new ApiGeoPreviewError({ message: "the preview image could not be read", kind: "unreadable" }),
        })

        return HttpServerResponse.raw(bytes, {
          headers: {
            "content-type": "image/webp",
            "content-length": String(bytes.byteLength),
            // Where the image goes rides in a header rather than the body: a
            // multi-megabyte image inside a JSON envelope costs a third more
            // bytes and a conversion at each end (§7.7).
            [PREVIEW_META_HEADER]: Buffer.from(
              JSON.stringify({
                preview_projection: preview.projection,
                preview_extent: preview.extent,
                rgb_bands: preview.bands,
                preview_width: preview.width,
                preview_height: preview.height,
                bytes: preview.bytes,
                limited: preview.downscaled,
              }),
            ).toString("base64"),
            // Without this a browser hides the header from the very script
            // that needs it.
            "access-control-expose-headers": PREVIEW_META_HEADER,
            // The artifact is keyed to the source's size and timestamp, so a
            // stale copy in an intermediate cache would outlive the edit that
            // should have retired it (§7.6).
            "cache-control": "no-store",
          },
        })
      }),
    ),
)
