// --- GeoCode: canonical GIS file taxonomy. Single source of truth for the three subsystems that
// reason about geo files, each selecting only what its semantics allow:
//   1. file-tree sidecar collapse (@geocode/app, utils/geo-tree-filter.ts) — PARENT-GATED, so it
//      may use the generic companion extensions (.dat/.hdr/.qml/...) safely.
//   2. snapshot exclude (opencode, snapshot/index.ts) — an UNCONDITIONAL `*.ext` gitignore, so it
//      may only blanket UNAMBIGUOUS geo extensions; SNAPSHOT_BLANKET_SIDECARS drops the gated-only
//      generics that would otherwise also drop a user's non-GIS files of the same extension.
//   3. watcher ignore (core, filesystem/ignore.ts) — only transient churn (WAL / locks / autosaves).
// Pure data, ZERO imports, so the browser bundle can import it like core/util/* without pulling in
// any Node-only code. Add a new format here once and every consumer that selects its category picks
// it up — this is what stops the three lists from drifting apart.
// ---

// Companion (sidecar) extensions grouped by the dataset family that anchors them. The file-tree
// collapse keys each group to a same-stem parent; orphan companions stay visible.
export const SHAPEFILE_SIDECARS = [
  "shx",
  "sbn",
  "sbx",
  "dbf",
  "prj",
  "cpg",
  "qpj",
  "qix",
  "atx",
  "fbn",
  "fbx",
  "ain",
  "aih",
  "ixs",
  "mxs",
]
export const MAPINFO_TAB_SIDECARS = ["dat", "map", "id", "ind"]
export const MAPINFO_MIF_SIDECARS = ["mid"]
export const RASTER_SIDECARS = [
  "tfw",
  "tifw",
  "wld",
  "j2w",
  "blw",
  "bilw",
  "bipw",
  "bsqw",
  "ovr",
  "msk",
  "rrd",
  "hdr",
  "sta",
  "enp",
  "stx",
  "clr",
]
export const QGIS_SIDECARS = ["qml", "qmd"]
export const GML_SIDECARS = ["gfs"]
export const POINTCLOUD_SIDECARS = ["lax", "lasx", "lasd"]

// Dataset main extensions, by category.
export const VECTOR_MAIN = ["shp", "geojson", "gpkg", "gml", "kml", "kmz", "gpx", "fgb", "tab", "mif", "osm"]
export const RASTER_MAIN = [
  "tif",
  "tiff",
  "img",
  "hdf",
  "nc",
  "grd",
  "asc",
  "dem",
  "jp2",
  "ecw",
  "bil",
  "bip",
  "bsq",
  "adf",
]
export const CAD_MAIN = ["dxf", "dgn"]
export const SCIENTIFIC_MAIN = ["h5", "grib", "grib2", "grb", "grb2"]
export const POINTCLOUD_MAIN = ["las", "laz"]
export const TILECACHE_MAIN = ["mbtiles", "pmtiles", "tpk", "tpkx", "vtpk", "slpk"]

// Container-dataset directories: a single dataset stored AS a folder of opaque internals (Esri File
// Geodatabase .gdb, Zarr .zarr). The tree renders these as one non-expandable row.
export const CONTAINER_DIRS = ["gdb", "zarr"]

// Companion extensions too generic to exclude unconditionally: an unconditional `*.ext` (snapshot)
// would drop a user's non-GIS files of the same extension, so snapshot omits these. The file-tree
// collapse is parent-gated and uses them safely. `.dbf` is deliberately NOT here — snapshot has
// always blanketed it (a stray dBASE table is acceptable to skip from a checkpoint).
const GATED_ONLY_SIDECARS = new Set(["dat", "map", "id", "ind", "mid", "hdr", "sta", "enp", "stx", "clr", "qml"])

// Sidecars safe to exclude unconditionally (snapshot blanket): every family companion minus the
// gated-only generics. Adding a companion to a family group above propagates here automatically.
export const SNAPSHOT_BLANKET_SIDECARS = [
  ...new Set([
    ...SHAPEFILE_SIDECARS,
    ...MAPINFO_TAB_SIDECARS,
    ...MAPINFO_MIF_SIDECARS,
    ...RASTER_SIDECARS,
    ...QGIS_SIDECARS,
    ...GML_SIDECARS,
    ...POINTCLOUD_SIDECARS,
  ]),
].filter((ext) => !GATED_ONLY_SIDECARS.has(ext))

// Transient churn: SQLite WAL/SHM/journal (GeoPackage / SpatiaLite / Esri mobile geodatabase /
// generic .db) + QGIS project/style backups, locks, autosaves. Stored as bare suffixes; the watcher
// formats them as `**/*.<suffix>` globs, the snapshot exclude as `*.<suffix>`.
export const TRANSIENT_SUFFIXES = [
  "gpkg-shm",
  "gpkg-wal",
  "gpkg-journal",
  "sqlite-shm",
  "sqlite-wal",
  "sqlite-journal",
  "geodatabase-shm",
  "geodatabase-wal",
  "geodatabase-journal",
  "db-shm",
  "db-wal",
  "db-journal",
  "qgs~",
  "qgz~",
  "qml~",
  "qgs.lock",
  "qgz.lock",
  "qgs.autosave",
  "qgz.autosave",
]

export * as GeoExtensions from "./geo-extensions"
