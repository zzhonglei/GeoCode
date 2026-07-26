export * as QgisTypes from "./types"

/* --- GeoCode: the vocabulary of QGIS environment resolution
 * (docs/GEOKERNEL.md §4.3–§4.6, §4.9, §4.10).
 *
 * Environment resolution is where this module's complexity lives. A user's
 * QGIS varies along four axes at once — platform, how it was installed, which
 * version, and what shape of path they gave us — and all three capabilities
 * rest on getting past "import qgis" (§4.1). --- */

/** Which assembly track produced an environment. Windows only; macOS has one path. */
export type Track = "bridge" | "manual"

/**
 * A verified QGIS environment.
 *
 * Handed to execution entry points directly rather than having them re-read a
 * status: that closes the window between deciding an environment is usable and
 * actually starting a process in it (§4.9, §9.1).
 */
export interface Environment {
  /** The interpreter to spawn. Derived from the install, not taken from the hint (§4.3 principle 1). */
  readonly python: string
  readonly prefix: string
  /**
   * The environment to hand a subprocess. COMPLETE — never the filtered copy.
   *
   * Execution needs completeness and display needs safety, and the two pull in
   * opposite directions, so they are different values rather than one value
   * used twice (§4.3 principle 8).
   */
  readonly env: Record<string, string>
  /**
   * Directories to register for dynamic library search, Windows only.
   *
   * **Empty on the bridge track, and that is load-bearing** — registering any
   * directory switches the interpreter into a restricted search mode in which
   * the cascade the launcher set up through the executable search path stops
   * working (§4.3 principle 5, §4.5).
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
 * Everything needed to locate a failure without opening a log file (§4.10).
 *
 * `candidates` is here for one specific problem: **the choice itself may be the
 * wrong one**. On a machine carrying two QGIS installs, or two copies of a
 * resource, showing only what was picked cannot explain the failure — showing
 * what else was available lets a user or an agent see that another candidate
 * should have been taken.
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

/**
 * Why resolution failed.
 *
 * These are the failure members of §4.7's state set, named identically so the
 * lifecycle can carry one straight into the status slot without translating.
 */
export type Failure =
  /** The hint points nowhere, or is relative (§4.2). */
  | "path-missing"
  /** The path exists but carries no QGIS marker. */
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
