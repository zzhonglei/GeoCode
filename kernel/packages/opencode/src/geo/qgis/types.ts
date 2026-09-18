export * as QgisTypes from "./types"

/* --- GeoCode: the vocabulary of QGIS environment resolution (docs/GEOKERNEL.md §4.3–§4.10). --- */

/** Which assembly track produced an environment; Windows only, macOS resolution leaves it undefined. */
export type Track = "bridge" | "manual"

/**
 * Handed from the gate to execution entry points rather than looked up again, which closes the window between the
 * gate's verdict and the spawn (§4.9).
 */
export interface Environment {
  readonly python: string
  readonly prefix: string
  /** Complete; only the display copy in Diagnostics is filtered (§4.3 principle 8). */
  readonly env: Record<string, string>
  /**
   * Windows manual track only. Empty on the bridge track and that is load-bearing: registering any directory
   * switches the interpreter into a restricted search mode in which the launcher's executable-search-path cascade
   * stops working (§4.3 principle 5).
   */
  readonly dllDirectories: readonly string[]
  readonly track?: Track
  readonly versions: {
    readonly python: string
    readonly gdal: string
    readonly qgis: string
  }
  readonly processing: boolean
}

export interface Choice {
  readonly selected?: string
  readonly candidates: readonly string[]
}

export interface Diagnostics {
  readonly python: string
  readonly prefix: string
  /** Filtered for display; never spawn with it. */
  readonly env: Record<string, string>
  readonly dllDirectories: readonly string[]
  readonly checks: Record<string, boolean>
  readonly choices: Record<string, Choice>
  readonly output?: string
  readonly error?: string
  readonly track?: Track
  readonly attempted?: readonly Track[]
}

export type Failure =
  | "path-missing"
  /** macOS only. */
  | "not-qgis"
  | "gdal-missing"
  | "proj-broken"
  | "core-missing"
  | "probe-timeout"
  | "probe-failed"

export type Resolution =
  | { readonly ok: true; readonly environment: Environment }
  | { readonly ok: false; readonly failure: Failure; readonly diagnostics: Diagnostics }
