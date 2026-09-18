export * as GeeDeps from "./deps"

/* --- GeoCode: the Python packages a GEE run needs end to end, covering what `pylib/geocode.py` imports, or setup
 * reports ready and the script fails halfway (docs/GEOKERNEL.md §5.3). --- */

export interface Dep {
  readonly pkg: string
  /** Import name, which is not the install name: `earthengine-api` imports as `ee`. */
  readonly module: string
  /** Rendered into the guidance as it stands, so write it for the user. */
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
    role: "tile-based download, which geemap needs but does not install",
  },
  {
    pkg: "geopandas",
    module: "geopandas",
    // Covers shapely, which the library imports directly: geopandas requires it outright, so an entry of its own
    // could never fail alone and would only add a line to every install instruction.
    role: "reading the local vector file that defines a study region",
  },
] as const

export const PACKAGES: readonly string[] = DEPS.map((dep) => dep.pkg)

export function byPackage(pkg: string): Dep | undefined {
  return DEPS.find((dep) => dep.pkg === pkg)
}
