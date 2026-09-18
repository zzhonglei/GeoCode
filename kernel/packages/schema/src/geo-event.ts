export * as GeoEvent from "./geo-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"

/* --- GeoCode: the status face of GeoKernel (docs/GEOKERNEL.md §8.1, §9.2). A config syntax error fails every
 * block, so each set keeps `config-error` apart from `unconfigured`; an event carries a slot's whole state. --- */

// QGIS ----------------------------------------------------------------------

export const QgisCatalog = Schema.Literals(["building", "ready", "failed", "skipped"])
export type QgisCatalog = typeof QgisCatalog.Type

/**
 * Facts for locating a failure without a log file (§4.10), carried by the five probe outcomes below. Candidates
 * travel with the choice made: on a machine holding two QGIS installs, what was selected cannot explain the
 * failure on its own.
 */
export const QgisDiagnostics = Schema.Struct({
  /** The track in effect, and every track attempted — only Windows has more than one (§4.10). */
  track: optional(Schema.String),
  attempted: optional(Schema.Array(Schema.String)),
  interpreter: optional(Schema.String),
  prefix: optional(Schema.String),
  candidates: optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  selected: optional(Schema.Record(Schema.String, Schema.String)),
  checks: optional(Schema.Record(Schema.String, Schema.Boolean)),
  /** Registered dynamic-library directories: the manual Windows track needs a wide set (§4.5), and a reader
   * cannot judge the width without seeing it. Absent on the tracks that register none (§4.3 principle 5). */
  dllDirectories: optional(Schema.Array(Schema.String)),
  /** Filtered to a display keep-list before it reaches here; execution keeps the complete set (§4.3 principle 8). */
  environment: optional(Schema.Record(Schema.String, Schema.String)),
  /** Raw probe output, present when the probe never reached its result marker. */
  output: optional(Schema.String),
  error: optional(Schema.String),
})
export interface QgisDiagnostics extends Schema.Schema.Type<typeof QgisDiagnostics> {}

// Generic over the literal: widening `status` to `string` breaks discrimination for every consumer of the union.
const qgisFailure = <const S extends string>(status: S) =>
  Schema.Struct({
    status: Schema.Literal(status),
    diagnostics: QgisDiagnostics,
  })

export const QgisStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unconfigured") }),
  /** Carries the location so the user can fix the line rather than hunt for it. */
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
    /** A ready face has no other source for these: the verified environment never leaves the kernel (§9.1). */
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
 * The local dependency chain, probed in order and short-circuited at the first gap, so guidance can render "step N
 * of 4" instead of listing every problem at once (§5.3, §5.11).
 */
export const GeeSetup = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unconfigured") }),
  /** On this layer of the three, because the local chain is the one machine.json describes (§3.1). */
  Schema.Struct({ status: Schema.Literal("config-error"), file: Schema.String, message: Schema.String }),
  Schema.Struct({ status: Schema.Literal("python-missing"), python: Schema.String }),
  Schema.Struct({ status: Schema.Literal("checking") }),
  /**
   * Carries the interpreter, as credentials-missing does, because the guidance is a command built from it; without it
   * the copy can only say "the interpreter you configured", and a user installs into the wrong environment (§5.11).
   */
  Schema.Struct({
    status: Schema.Literal("packages-missing"),
    python: Schema.String,
    missing: Schema.Array(Schema.String),
  }),
  /**
   * Installed but unusable, such as a native library that will not load: not `packages-missing`, whose fix would loop
   * back here, and not `probe-failed`, which means the check gave no answer.
   */
  Schema.Struct({
    status: Schema.Literal("packages-broken"),
    python: Schema.String,
    pkg: Schema.String,
    error: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal("credentials-missing"), python: Schema.String }),
  Schema.Struct({ status: Schema.Literal("project-missing") }),
  Schema.Struct({ status: Schema.Literal("probe-timeout") }),
  Schema.Struct({ status: Schema.Literal("probe-failed"), error: Schema.String }),
  /** The tool layer's environment header renders all three, and has no other source for them. */
  Schema.Struct({
    status: Schema.Literal("ready"),
    python: Schema.String,
    project: Schema.String,
    version: optional(Schema.String),
  }),
]).annotate({ identifier: "GeoEvent.GeeSetup" })
export type GeeSetup = typeof GeeSetup.Type

/**
 * Read from Net, never computed here (§8.3). The three route fields are identifiers assembled from parsed
 * scheme/host/port and so cannot carry a credential; the underlying error stays inside as diagnostics (§3.3).
 * `skipped` is the only thing that tells a user whose network works solely through a refused SOCKS declaration
 * (§12) apart from a user with no network at all — both otherwise read "cannot be reached".
 */
export const GeeNetwork = Schema.Union([
  Schema.Struct({ status: Schema.Literal("idle") }),
  Schema.Struct({ status: Schema.Literal("checking") }),
  Schema.Struct({ status: Schema.Literal("reachable"), route: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("unreachable"),
    tried: optional(Schema.Array(Schema.String)),
    skipped: optional(Schema.Array(Schema.String)),
  }),
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
 * `facing` is §5.6's short-circuit — local before network before remote — so exactly one problem is shown at a
 * time; the three layers travel with it because diagnostics need them. It is a pure function of the three,
 * computed by the GEE module, never here.
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
 * Raster and vector depend on disjoint tools, so readiness is per track rather than one verdict as in QGIS
 * (§7.3 vs §4.9) — one half being unusable says nothing about the other.
 */
export const GdalStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unconfigured") }),
  /** Not interchangeable with `unconfigured`: the user did configure this, and the file is simply unreadable. */
  Schema.Struct({ status: Schema.Literal("config-error"), file: Schema.String, message: Schema.String }),
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
