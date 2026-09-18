export * as GdalTypes from "./types"

import type { GdalEnv } from "./env"

/* --- GeoCode: the verified GDAL toolchain (docs/GEOKERNEL.md §7.3, §9.1). --- */

/** Held for the whole pipeline, so a config change cannot land between subprocesses and split it across toolchains. */
export interface Environment {
  readonly directory: string
  /** As Config fingerprinted the configuration; travels into every cache key (§7.6). */
  readonly fingerprint: string
  readonly tools: Record<GdalEnv.Tool, string>
  /** Injected into every subprocess. Empty on platforms that need nothing (§7.3). */
  readonly env: Record<string, string>
}

export type Track = "raster" | "vector"
