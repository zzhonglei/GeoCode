export * as GeeDeps from "./deps"

/* --- GeoCode: the Python packages a GEE run needs end to end
 * (docs/GEOKERNEL.md §5.3 依赖清单是单一真相源).
 *
 * ONE list, two consumers: the probe imports each entry to decide whether the
 * environment is complete, and the guidance renders one install line per
 * missing entry. Adding a package here reaches both without touching either —
 * which is the point, because the failure mode of a split list is silent: the
 * environment reports ready and the script dies halfway through.
 *
 * Wider than "what Earth Engine itself needs", deliberately. The runtime
 * library (§5.10) reads local vector files and downloads imagery, so its
 * imports are part of the contract the user is promised. The list below is
 * exactly what that library imports — verified against its source, not
 * assembled from memory. --- */

export interface Dep {
  /** Install name, as the package manager knows it. */
  readonly pkg: string
  /** Import name, as Python knows it. The two differ often enough to keep both. */
  readonly module: string
  /** What breaks without it — rendered into the guidance, so write it for the user. */
  readonly role: string
}

export const DEPS: readonly Dep[] = [
  {
    pkg: "earthengine-api",
    module: "ee",
    role: "the Earth Engine client itself",
  },
  {
    pkg: "geemap",
    module: "geemap",
    role: "downloading imagery to local files",
  },
  {
    pkg: "geedim",
    module: "geedim",
    // geemap's image download goes through geedim, but geemap declares it as
    // an optional extra — so installing geemap alone does NOT bring it in.
    // Probing for it up front turns a confusing mid-script ImportError into a
    // sentence at setup time.
    role: "tile-based download, which geemap needs but does not install",
  },
  {
    pkg: "geopandas",
    module: "geopandas",
    // Covers shapely too, which the library also imports (to explain why a
    // geometry is invalid). geopandas requires it outright, so a probe entry
    // of its own could never fail on its own — it would only add a line to
    // every install instruction.
    role: "reading the local vector file that defines a study region",
  },
] as const

/** Install names only — for the fallback case where nothing specific is known. */
export const PACKAGES: readonly string[] = DEPS.map((dep) => dep.pkg)

/** Look up a dependency by install name, for rendering guidance about it. */
export function byPackage(pkg: string): Dep | undefined {
  return DEPS.find((dep) => dep.pkg === pkg)
}
