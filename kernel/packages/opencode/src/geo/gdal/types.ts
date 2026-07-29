export * as GdalTypes from "./types"

import type { GdalEnv } from "./env"

/* --- GeoCode: the verified GDAL toolchain (docs/GEOKERNEL.md §7.3, §9.1). --- */

/**
 * What a track's gate hands to whoever passed it.
 *
 * A SNAPSHOT, taken when the probe ran. The pipeline that receives it runs
 * several subprocesses over some seconds, and re-reading the status between
 * them would let a configuration change land in the middle — half the
 * subprocesses on one toolchain, half on another, with no error anywhere to
 * say so (§9.1).
 */
export interface Environment {
  /** The directory the tools were found in — what the status was decided about. */
  readonly directory: string
  /**
   * The configuration this was derived from, as Config fingerprinted it.
   *
   * Travels into every cache key so that pointing the configuration at a
   * different toolchain retires the old artifacts instead of serving them from
   * a build that no longer exists (§7.6).
   */
  readonly fingerprint: string
  readonly tools: Record<GdalEnv.Tool, string>
  /** Injected into every subprocess. Empty on platforms that need nothing (§7.3). */
  readonly env: Record<string, string>
}

/** Which half of the data plane is asking. The two have disjoint dependencies. */
export type Track = "raster" | "vector"
