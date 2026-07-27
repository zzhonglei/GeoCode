export * as GeoEvent from "./geo-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"

/* --- GeoCode: the status face of GeoKernel (docs/GEOKERNEL.md §8.1, §9.2).
 *
 * Three environment status slots — QGIS, GEE, GDAL. OSM has none on purpose:
 * it has no configuration and no local dependency, so a red light there would
 * be neither actionable nor fixable (§6.2, and the tradeoff record in §12).
 *
 * Every slot follows the same shape (§8.1):
 *   - a discriminated union keyed on `status`;
 *   - intermediate states are members, not an absence of state, because probing
 *     and building take tens of seconds and users watch them happen (§2.4);
 *   - failure members carry the facts needed to locate the problem, so the UI
 *     never has to send the user to a log file.
 *
 * Event payloads are the whole state object: the channel is replace-the-slot,
 * not patch-the-slot (§3.4). --- */

// QGIS ----------------------------------------------------------------------

/** How far the algorithm catalog got. Only meaningful once the environment is ready. */
export const QgisCatalog = Schema.Literals(["building", "ready", "failed", "skipped"])
export type QgisCatalog = typeof QgisCatalog.Type

/**
 * Facts gathered while resolving the environment, carried by every failure so
 * the user sees what was chosen AND what else was available — when a machine
 * holds two QGIS installs, "what was selected" alone cannot explain the failure
 * (§4.10).
 */
export const QgisDiagnostics = Schema.Struct({
  /** Which assembly track produced this environment, and which were attempted. */
  track: optional(Schema.String),
  attempted: optional(Schema.Array(Schema.String)),
  interpreter: optional(Schema.String),
  prefix: optional(Schema.String),
  /** Candidate lists paired with the choice made, keyed by what was being chosen. */
  candidates: optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  selected: optional(Schema.Record(Schema.String, Schema.String)),
  /** Per-path existence checks, so a missing file is visible without a log dive. */
  checks: optional(Schema.Record(Schema.String, Schema.Boolean)),
  /**
   * Registered dynamic-library directories, when the track registers any.
   * §4.10 lists them as part of the bundle: on the manual Windows track the
   * WIDTH of this set is load-bearing (§4.5), and a reader cannot judge it
   * without seeing it.
   */
  dllDirectories: optional(Schema.Array(Schema.String)),
  /** Environment variables in effect, filtered at this exit (§4.3 principle 8). */
  environment: optional(Schema.Record(Schema.String, Schema.String)),
  /** Raw probe output. Present when the probe never reached its output marker. */
  output: optional(Schema.String),
  error: optional(Schema.String),
})
export interface QgisDiagnostics extends Schema.Schema.Type<typeof QgisDiagnostics> {}

// Generic so each literal survives as itself: widening these to `string`
// silently breaks discrimination for every consumer of the union.
const qgisFailure = <const S extends string>(status: S) =>
  Schema.Struct({
    status: Schema.Literal(status),
    diagnostics: QgisDiagnostics,
  })

export const QgisStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unconfigured") }),
  /**
   * machine.json cannot be parsed. Mandated by the config contract: a syntax
   * error fails EVERY block, and each module shows that honestly instead of
   * pretending to be merely unconfigured (§3.1). Carries the location so the
   * user can fix the line, not hunt for it.
   */
  Schema.Struct({ status: Schema.Literal("config-error"), file: Schema.String, message: Schema.String }),
  Schema.Struct({ status: Schema.Literal("path-missing"), hint: optional(Schema.String) }),
  Schema.Struct({ status: Schema.Literal("not-qgis"), hint: optional(Schema.String) }),
  Schema.Struct({ status: Schema.Literal("resolving") }),
  Schema.Struct({ status: Schema.Literal("probing") }),
  qgisFailure("gdal-missing"),
  qgisFailure("proj-broken"),
  qgisFailure("core-missing"),
  qgisFailure("probe-timeout"),
  qgisFailure("probe-failed"),
  Schema.Struct({
    status: Schema.Literal("ready"),
    /** Result of probe step 4. When false the catalog stage is never entered. */
    processing: Schema.Boolean,
    catalog: QgisCatalog,
    catalogError: optional(Schema.String),
    /**
     * The facts a status surface shows on the happy path: which interpreter,
     * which versions, which track produced them. Without these the ready state
     * has nothing to render and no source to fetch it from — the verified
     * environment object itself never leaves the kernel (§9.1).
     */
    interpreter: optional(Schema.String),
    track: optional(Schema.String),
    versions: optional(
      Schema.Struct({
        python: Schema.String,
        gdal: Schema.String,
        qgis: Schema.String,
      }),
    ),
  }),
]).annotate({ identifier: "GeoEvent.QgisStatus" })
export type QgisStatus = typeof QgisStatus.Type

// GEE -----------------------------------------------------------------------

/**
 * The local dependency chain, probed in order and short-circuited at the first
 * gap, so guidance can say "step N of 4" instead of listing every problem at
 * once (§5.3, §5.11).
 */
export const GeeSetup = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unconfigured") }),
  Schema.Struct({ status: Schema.Literal("python-missing"), python: Schema.String }),
  Schema.Struct({ status: Schema.Literal("checking") }),
  Schema.Struct({ status: Schema.Literal("packages-missing"), missing: Schema.Array(Schema.String) }),
  Schema.Struct({ status: Schema.Literal("credentials-missing") }),
  Schema.Struct({ status: Schema.Literal("project-missing") }),
  Schema.Struct({ status: Schema.Literal("probe-timeout") }),
  Schema.Struct({ status: Schema.Literal("probe-failed"), error: Schema.String }),
  Schema.Struct({ status: Schema.Literal("ready") }),
]).annotate({ identifier: "GeoEvent.GeeSetup" })
export type GeeSetup = typeof GeeSetup.Type

/** Read from Net, never computed here (§8.3). `route` identifies the path in use. */
export const GeeNetwork = Schema.Union([
  Schema.Struct({ status: Schema.Literal("idle") }),
  Schema.Struct({ status: Schema.Literal("checking") }),
  Schema.Struct({ status: Schema.Literal("reachable"), route: Schema.String }),
  Schema.Struct({ status: Schema.Literal("unreachable") }),
]).annotate({ identifier: "GeoEvent.GeeNetwork" })
export type GeeNetwork = typeof GeeNetwork.Type

/** Why the remote refused. The raw message is kept verbatim beside our attribution. */
export const GeeRejection = Schema.Literals([
  "api-disabled",
  "permission-denied",
  "credentials-expired",
  "project-invalid",
  "unknown",
])
export type GeeRejection = typeof GeeRejection.Type

export const GeeRuntime = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unknown") }),
  Schema.Struct({ status: Schema.Literal("checking") }),
  Schema.Struct({ status: Schema.Literal("valid"), route: optional(Schema.String) }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    reason: GeeRejection,
    message: Schema.String,
  }),
]).annotate({ identifier: "GeoEvent.GeeRuntime" })
export type GeeRuntime = typeof GeeRuntime.Type

/**
 * All three facts plus the layer whose state is the one to act on.
 *
 * `facing` is the short-circuit of §5.6 — local before network before remote —
 * and it exists so the user is shown exactly one problem at a time. The three
 * layers travel with it because diagnostics need them; the priority rule stays
 * a pure function of the three, computed by the GEE module, never here.
 */
export const GeeStatus = Schema.Struct({
  facing: Schema.Literals(["setup", "network", "runtime"]),
  setup: GeeSetup,
  network: GeeNetwork,
  runtime: GeeRuntime,
}).annotate({ identifier: "GeoEvent.GeeStatus" })
export interface GeeStatus extends Schema.Schema.Type<typeof GeeStatus> {}

// GDAL ----------------------------------------------------------------------

/**
 * Two tracks with disjoint tool sets, so the gate is per-track rather than
 * unified — the opposite of QGIS, where three capabilities share one
 * environment and therefore one verdict (§7.3 vs §4.9).
 */
export const GdalStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unconfigured") }),
  Schema.Struct({ status: Schema.Literal("dir-missing"), directory: Schema.String }),
  Schema.Struct({ status: Schema.Literal("unusable"), missing: Schema.Array(Schema.String) }),
  Schema.Struct({ status: Schema.Literal("raster-only"), missing: Schema.Array(Schema.String) }),
  Schema.Struct({ status: Schema.Literal("vector-only"), missing: Schema.Array(Schema.String) }),
  Schema.Struct({ status: Schema.Literal("ready") }),
]).annotate({ identifier: "GeoEvent.GdalStatus" })
export type GdalStatus = typeof GdalStatus.Type

// Events --------------------------------------------------------------------

export const QgisChanged = Event.define({
  type: "geo.qgis.status",
  schema: { status: QgisStatus },
})

export const GeeChanged = Event.define({
  type: "geo.gee.status",
  schema: { status: GeeStatus },
})

export const GdalChanged = Event.define({
  type: "geo.gdal.status",
  schema: { status: GdalStatus },
})

export const Definitions = Event.inventory(QgisChanged, GeeChanged, GdalChanged)
