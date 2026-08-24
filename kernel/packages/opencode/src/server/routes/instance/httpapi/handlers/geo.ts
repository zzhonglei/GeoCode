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
 * Path first, gate second: a request that was never allowed to name this file must not learn from the answer
 * whether the machine has a toolchain (§7.8).
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
          georeference: meta.georeference,
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
            // Placement in a header, not the body: JSON costs a third more bytes on a multi-megabyte image (§7.7).
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
            // Without this a browser hides the header from the script that reads it (§11).
            "access-control-expose-headers": PREVIEW_META_HEADER,
            // The URL is the same after an edit, so a cached copy would outlive the file it was made from (§7.6).
            "cache-control": "no-store",
          },
        })
      }),
    ),
)
