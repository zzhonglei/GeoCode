// --- GeoCode: the one GIS extension taxonomy, so geo-aware consumers cannot drift apart; each takes only the
// categories its own matching rule tolerates (docs/GEOKERNEL.md §10.1 #5). ---

// Companion (sidecar) extensions, grouped by the dataset family that anchors them.
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

// A dataset stored as a directory rather than a file (Esri File Geodatabase, Zarr), so `*.gdb` excludes a folder.
export const CONTAINER_DIRS = ["gdb", "zarr"]

// Too generic to blanket: under an unconditional `*.ext` these would take a user's non-GIS files as well.
const GATED_ONLY_SIDECARS = new Set(["dat", "map", "id", "ind", "mid", "hdr", "sta", "enp", "stx", "clr", "qml"])

// Every family companion minus those generics, so a companion added to a group above propagates here.
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

// SQLite WAL/SHM/journal companions and QGIS backups, locks and autosaves, which a session rewrites constantly.
// Bare suffixes: the watcher globs them as `**/*.<suffix>`, the snapshot exclude as `*.<suffix>`.
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
