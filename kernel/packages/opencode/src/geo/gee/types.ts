export * as GeeTypes from "./types"

/* --- GeoCode: the verified GEE environment (docs/GEOKERNEL.md §9.1). --- */

/**
 * What the gate hands out and the executor takes — an object rather than a status the executor looks up again,
 * which closes the window between the check passing and the process starting (§4.9). It stays inside the kernel:
 * `env` carries the proxy URL with its credentials, and what a surface needs travels in the status (§9.1).
 */
export interface Environment {
  readonly python: string
  readonly project: string
  /** Client library version, when the probe managed to read it. */
  readonly version?: string
  readonly route?: string
  /** Base environment: the resolved route in its subprocess form (§3.3). */
  readonly env: Record<string, string>
}
