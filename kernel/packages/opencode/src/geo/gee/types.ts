export * as GeeTypes from "./types"

/* --- GeoCode: the verified GEE environment (docs/GEOKERNEL.md §9.1). --- */

/**
 * What the gate hands out, and what the executor takes.
 *
 * An object rather than a status lookup: between "the check passed" and "the
 * process started" the configuration can change, and a caller that looked the
 * status up again would be running under one environment while having been
 * cleared for another (§4.9, the same rule QGIS follows).
 *
 * It never leaves the kernel. The facts a surface needs — interpreter,
 * project, version — travel on the wire in the status instead (§9.1).
 */
export interface Environment {
  readonly python: string
  readonly project: string
  /** Client library version, when the probe managed to read it. */
  readonly version?: string
  /** The route this was cleared over, for the caller's header. */
  readonly route?: string
  /** Base environment: the resolved route in its subprocess form (§3.3). */
  readonly env: Record<string, string>
}
