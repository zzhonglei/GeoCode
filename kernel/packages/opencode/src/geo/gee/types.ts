export * as GeeTypes from "./types"

/* --- GeoCode: the verified GEE environment (docs/GEOKERNEL.md §9.1). --- */

/** Kernel-internal: `env` carries the proxy URL with its credentials; what a surface needs travels in the status. */
export interface Environment {
  readonly python: string
  readonly project: string
  /** Client library version, when the probe managed to read it. */
  readonly version?: string
  readonly route?: string
  /** Base environment: the resolved route in its subprocess form (§3.3). */
  readonly env: Record<string, string>
}
