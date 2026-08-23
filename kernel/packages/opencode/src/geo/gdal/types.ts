export * as GdalTypes from "./types"

import type { GdalEnv } from "./env"

/* --- GeoCode: the verified GDAL toolchain (docs/GEOKERNEL.md §7.3, §9.1). --- */

/**
 * What a track's gate hands to whoever passed it: a snapshot of the probe, held for the whole pipeline rather than
 * re-read between its subprocesses, so a configuration change cannot land halfway and split them across two
 * toolchains (§9.1).
 */
export interface Environment {
  /** The configured directory the status was decided about; no pipeline reads it today. */
  readonly directory: string
  /** As Config fingerprinted the configuration; travels into every cache key (§7.6). */
  readonly fingerprint: string
  readonly tools: Record<GdalEnv.Tool, string>
  /** Injected into every subprocess. Empty on platforms that need nothing (§7.3). */
  readonly env: Record<string, string>
}

/** Which half of the data plane is asking. */
export type Track = "raster" | "vector"
