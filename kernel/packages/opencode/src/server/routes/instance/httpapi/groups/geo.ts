import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { GeoEvent } from "@opencode-ai/schema/geo-event"
import { optional } from "@opencode-ai/schema/schema"
import { Georeference } from "@/geo/georeference"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

/* --- GeoCode: the data face of GeoKernel (docs/GEOKERNEL.md §9.3, §10.1 #2).
 *
 * **Two groups, because they answer to different things.**
 *
 * The status face is process-wide: GeoKernel is built once per server process
 * and is independent of the working directory (§10.2), so it takes no location
 * routing and lives on the root api.
 *
 * The preview resources cannot. They are the only surface in the kernel that
 * accepts a path from outside, and §7.8 requires every such path to fall inside
 * the project — which means they need to know which project they are answering
 * for. That answer comes from location routing, so they sit on the instance api
 * with the same middleware every other path-taking endpoint carries. The paths
 * are absolute in both cases (§7.7 lists them verbatim); only the routing
 * differs. --- */

/**
 * Every status slot's current value.
 *
 * All three are optional because a slot exists only once its owning capability
 * module has registered it. The snapshot reports what is actually known rather
 * than fabricating a placeholder for a module that has not started — the same
 * "honesty over optimism" rule the states themselves follow (§2.4 principle 5).
 */
export const GeoStatusSnapshot = Schema.Struct({
  qgis: optional(GeoEvent.QgisStatus),
  gee: optional(GeoEvent.GeeStatus),
  gdal: optional(GeoEvent.GdalStatus),
}).annotate({ identifier: "GeoStatusSnapshot" })
export interface GeoStatusSnapshot extends Schema.Schema.Type<typeof GeoStatusSnapshot> {}

export const GeoPaths = {
  status: "/geo/status",
  reload: "/geo/reload",
  vectorMeta: "/geo/vector/meta",
  vector: "/geo/vector",
  vectorPage: "/geo/vector/page",
  rasterMeta: "/geo/raster/meta",
  rasterImage: "/geo/raster/image",
} as const

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** Every preview request names a file, and location routing names the project. */
const PathQuery = Schema.Struct({ ...WorkspaceRoutingQueryFields, path: Schema.String })

const PageQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  path: Schema.String,
  offset: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(500)),
  ),
})

/**
 * The path resolved outside the project.
 *
 * Separate from "not found" on purpose. They are different facts, and reporting
 * an escape as a missing file would hide a refusal behind an unrelated answer —
 * the caller would go looking for a typo (§7.8).
 */
export class ApiGeoAccessError extends Schema.TaggedErrorClass<ApiGeoAccessError>()(
  "GeoAccessError",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

export class ApiGeoNotFoundError extends Schema.TaggedErrorClass<ApiGeoNotFoundError>()(
  "GeoNotFoundError",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/**
 * The toolchain cannot serve this track, and the whole status travels with it.
 *
 * The interface reacts differently to "not configured yet" — which is a setup
 * prompt — than to "this install is missing two binaries", which is a repair
 * instruction. A rendered sentence would have thrown that difference away
 * (§7.7).
 */
export class ApiGeoEnvironmentError extends Schema.TaggedErrorClass<ApiGeoEnvironmentError>()(
  "GeoEnvironmentError",
  { message: Schema.String, status: GeoEvent.GdalStatus },
  { httpApiStatus: 503 },
) {}

/**
 * The file is reachable and the toolchain works, but this preview cannot exist.
 *
 * `kind` is what the interface acts on: a plain image gets shown as a picture,
 * an oversized layer gets read by page, and only the rest are faults.
 */
export class ApiGeoPreviewError extends Schema.TaggedErrorClass<ApiGeoPreviewError>()(
  "GeoPreviewError",
  {
    message: Schema.String,
    kind: Schema.Literals(["not-geographic", "too-many-features", "unreadable"]),
    /** On `too-many-features`: how far over, so the caller can size its pages. */
    featureCount: Schema.optional(NonNegativeInt),
  },
  { httpApiStatus: 400 },
) {}

/**
 * Declared on every preview endpoint, as an ARRAY rather than a union.
 *
 * Each class carries its own status code, and that is per-member metadata: a
 * `Schema.Union` of them encodes the right body under the wrong status, which
 * looks correct in a test that only reads the payload.
 */
const previewErrors = [ApiGeoAccessError, ApiGeoNotFoundError, ApiGeoEnvironmentError, ApiGeoPreviewError]

export const GeoVectorMeta = Schema.Struct({
  /** The format family, lowercased and without its dot: `geojson`, `shp`, … */
  source: Schema.String,
  feature_count: NonNegativeInt,
  /**
   * A HARD contract: the interface picks its renderer from this, and a
   * point-only layer takes a path the general one cannot match (§7.4).
   */
  geometry_types: Schema.Array(Schema.String),
  /** The SOURCE system. Content and pages are always web mercator. */
  projection: optional(Schema.String),
  properties: Schema.Array(Schema.String),
}).annotate({ identifier: "GeoVectorMeta" })

export const GeoVectorContent = Schema.Struct({ content: Schema.String }).annotate({
  identifier: "GeoVectorContent",
})

export const GeoVectorPage = Schema.Struct({
  features: Schema.Array(Schema.Unknown),
  total: NonNegativeInt,
  offset: NonNegativeInt,
  limit: PositiveInt,
}).annotate({ identifier: "GeoVectorPage" })

export const GeoRasterMeta = Schema.Struct({
  /**
   * Where the raster's placement comes from; `none` is a plain image that
   * happens to be a TIFF — show it, do not map it. `gcp` and `rpc` are data
   * whose corners are still pixel indices, which a map can say rather than
   * quietly place wrong.
   */
  georeference: Schema.Literals([...Georeference.KINDS]),
  projection: optional(Schema.String),
  width: PositiveInt,
  height: PositiveInt,
  band_count: PositiveInt,
}).annotate({ identifier: "GeoRasterMeta" })

/**
 * The preview metadata that rides in the image response's header.
 *
 * Not a response body anywhere — it is documented as a schema so the header's
 * shape has one definition rather than being spelled out at both ends.
 */
export const GeoPreviewMeta = Schema.Struct({
  preview_projection: Schema.String,
  preview_extent: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]),
  rgb_bands: Schema.Array(PositiveInt),
  preview_width: PositiveInt,
  preview_height: PositiveInt,
  bytes: NonNegativeInt,
  limited: Schema.Boolean,
}).annotate({ identifier: "GeoPreviewMeta" })

/** The header the image response carries its placement in, base64 of the above. */
export const PREVIEW_META_HEADER = "x-preview-meta"

export const GeoApi = HttpApi.make("geo").add(
  HttpApiGroup.make("geo")
    .add(
      HttpApiEndpoint.get("status", GeoPaths.status, {
        success: described(GeoStatusSnapshot, "Current geographic environment status"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "geo.status",
          summary: "Get geographic environment status",
          description:
            "Current status of every geographic environment slot. Subscribe to the event stream BEFORE " +
            "reading this snapshot, and re-read it on every reconnect: a change landing between the read " +
            "and the subscription is lost by both paths (GEOKERNEL.md §9.2).",
        }),
      ),
      HttpApiEndpoint.post("reload", GeoPaths.reload, {
        success: described(Schema.Struct({ reloaded: Schema.Literal(true) }), "Configuration re-read"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "geo.reload",
          summary: "Re-read machine.json now",
          description:
            "Force a synchronous re-read of machine.json. The config module watches the file, but a watch can " +
            "die with the platform's blessing (§3.1 documents the watcher; this is the pull escape hatch) — and " +
            "a settings surface that just WROTE the file gets a deterministic apply instead of racing the " +
            "watcher's debounce.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "geo", description: "Geographic execution kernel routes." })),
)

export const GeoPreviewApi = HttpApi.make("geo-preview").add(
  HttpApiGroup.make("geo-preview")
    .add(
      HttpApiEndpoint.get("vectorMeta", GeoPaths.vectorMeta, {
        query: PathQuery,
        success: described(GeoVectorMeta, "Vector layer metadata"),
        error: previewErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "geo.vectorMeta",
          summary: "Read vector metadata",
          description:
            "Feature count, geometry types, field names and source coordinate system, read from the file's " +
            "header. Cheap and independent of the layer's size, so the interface can draw a skeleton before " +
            "any content exists (GEOKERNEL.md §7.4).",
        }),
      ),
      HttpApiEndpoint.get("vector", GeoPaths.vector, {
        query: PathQuery,
        success: described(GeoVectorContent, "The whole layer, in web mercator"),
        error: previewErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "geo.vector",
          summary: "Read a whole vector layer",
          description:
            "The complete layer as GeoJSON, reprojected to EPSG:3857 — the client performs no projection " +
            "arithmetic. Layers past the deliverable limit are refused with `too-many-features` and its " +
            "count; read those by page instead (§7.4).",
        }),
      ),
      HttpApiEndpoint.get("vectorPage", GeoPaths.vectorPage, {
        query: PageQuery,
        success: described(GeoVectorPage, "One page of features"),
        error: previewErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "geo.vectorPage",
          summary: "Read one page of features",
          description:
            "A window of features in EPSG:3857, with the layer's total. Answered from memory, from the " +
            "converted layer on disk, or by querying the engine for just this window — the last is what lets " +
            "a file too large to deliver whole still be browsed (§7.4).",
        }),
      ),
      HttpApiEndpoint.get("rasterMeta", GeoPaths.rasterMeta, {
        query: PathQuery,
        success: described(GeoRasterMeta, "Raster metadata"),
        error: previewErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "geo.rasterMeta",
          summary: "Read raster metadata",
          description:
            "Size, band count, coordinate system, and where the raster's placement comes from. " +
            "`georeference` is a kind, not a boolean: `none` is an ordinary image that happens to carry " +
            "a raster extension — show those as pictures, and expect the image endpoint to refuse them " +
            "with `not-geographic`. Every other kind previews (§7.5).",
        }),
      ),
      HttpApiEndpoint.get("rasterImage", GeoPaths.rasterImage, {
        query: PathQuery,
        // Placeholder: the handler is raw and answers with `image/webp` bytes.
        success: Schema.Unknown,
        error: previewErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "geo.rasterImage",
          summary: "Read the raster preview image",
          description:
            "A WebP in EPSG:3857, downscaled under the preview caps, with nodata transparent. The placement " +
            "— extent, chosen bands, size, whether it was downscaled — travels in the base64 `x-preview-meta` " +
            "header rather than the body, so one request yields both the image and where it goes (§7.7).",
        }),
      ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization)
    .annotateMerge(
      OpenApi.annotations({ title: "geo-preview", description: "Vector and raster preview data for the interface." }),
    ),
)
