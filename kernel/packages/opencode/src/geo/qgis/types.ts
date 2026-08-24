export * as QgisTypes from "./types"

/* --- GeoCode: the vocabulary of QGIS environment resolution (docs/GEOKERNEL.md §4.3–§4.6, §4.9, §4.10). --- */

/** Which assembly track produced an environment. Windows only — macOS resolution leaves it undefined. */
export type Track = "bridge" | "manual"

/**
 * A verified QGIS environment, handed to execution entry points directly rather than looked up again, which closes
 * the window between the gate's verdict and the spawn (§4.9, §9.1).
 */
export interface Environment {
  /** The interpreter to spawn — from the install, unless the hint names an existing one (§4.3 principle 1). */
  readonly python: string
  readonly prefix: string
  /** COMPLETE — never the filtered copy, which exists for display only (§4.3 principle 8). */
  readonly env: Record<string, string>
  /**
   * Directories to register for dynamic library search, Windows manual track only. Empty on the bridge track and
   * that is load-bearing: registering any directory switches the interpreter into a restricted search mode in which
   * the launcher's executable-search-path cascade stops working (§4.3 principle 5, §4.5).
   */
  readonly dllDirectories: readonly string[]
  readonly track?: Track
  readonly versions: {
    readonly python: string
    readonly gdal: string
    readonly qgis: string
  }
  /** Result of probe step 4. When false the catalog stage is never entered (§4.7). */
  readonly processing: boolean
}

/** One ranked choice, kept with the alternatives that were available (§4.10). */
export interface Choice {
  readonly selected?: string
  readonly candidates: readonly string[]
}

/**
 * Everything needed to locate a failure without opening a log file (§4.10). `candidates` is here because the choice
 * itself may be the wrong one: with two installs on the machine, what was picked cannot explain the failure alone.
 */
export interface Diagnostics {
  readonly python: string
  readonly prefix: string
  /** FILTERED for display. The environment used for execution stays complete. */
  readonly env: Record<string, string>
  readonly dllDirectories: readonly string[]
  /** Per-path existence results, so a missing file is visible at a glance. */
  readonly checks: Record<string, boolean>
  readonly choices: Record<string, Choice>
  /** Raw probe output. Present when the probe never reached its result marker. */
  readonly output?: string
  readonly error?: string
  readonly track?: Track
  /** Tracks already attempted, so a reader can see the bridge was tried and fell back. */
  readonly attempted?: readonly Track[]
}

/** Named identically to §4.7's failure states, so the lifecycle commits one into the status slot untranslated. */
export type Failure =
  /** The hint points nowhere, or is relative (§4.2). */
  | "path-missing"
  /** macOS only: the hint names an application bundle carrying no QGIS marker. */
  | "not-qgis"
  /** Probe step 1: the interpreter has no GDAL bindings. */
  | "gdal-missing"
  /** Probe step 2: projection database missing or library mismatched. */
  | "proj-broken"
  /** Probe step 3: QGIS itself will not import. */
  | "core-missing"
  | "probe-timeout"
  /** The probe died, or its output could not be read. */
  | "probe-failed"

export type Resolution =
  | { readonly ok: true; readonly environment: Environment }
  | { readonly ok: false; readonly failure: Failure; readonly diagnostics: Diagnostics }
