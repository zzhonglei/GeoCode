import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { GeoEvent } from "@opencode-ai/schema/geo-event"
import { optional } from "@opencode-ai/schema/schema"
import { described } from "./metadata"

/* --- GeoCode: the data face of GeoKernel (docs/GEOKERNEL.md §9.3, §10.1 #2).
 *
 * Mounted on the ROOT api rather than the instance api: GeoKernel is built once
 * per server process and is independent of the working directory (§10.2), so it
 * takes no location routing.
 *
 * This group starts with the status snapshot alone. The preview resources —
 * vector meta/content/page and raster meta/image — join it when the GDAL module
 * lands; their contract is §7.7. --- */

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
} as const

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
