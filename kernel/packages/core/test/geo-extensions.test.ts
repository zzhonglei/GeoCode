import { describe, expect, test } from "bun:test"
import { GeoExtensions } from "../src/filesystem/geo-extensions"

describe("GeoExtensions taxonomy", () => {
  test("snapshot blanket sidecars never include gated-only generic extensions", () => {
    for (const generic of ["dat", "map", "id", "ind", "mid", "hdr", "sta", "enp", "stx", "clr", "qml"]) {
      expect(GeoExtensions.SNAPSHOT_BLANKET_SIDECARS.includes(generic)).toBe(false)
    }
  })

  test("snapshot blanket sidecars include the always-geo companions", () => {
    for (const geo of ["shx", "qpj", "qix", "atx", "gfs", "tfw", "ovr", "qmd", "lax"]) {
      expect(GeoExtensions.SNAPSHOT_BLANKET_SIDECARS.includes(geo)).toBe(true)
    }
    // .dbf is a dBase table, not only a shapefile companion, and is blanketed regardless.
    expect(GeoExtensions.SNAPSHOT_BLANKET_SIDECARS.includes("dbf")).toBe(true)
  })

  test("taxonomy still covers every extension the legacy snapshot exclude listed (no silent removal)", () => {
    // The snapshot's own literals (*.aux.xml, *.shp.xml, *.osm.pbf, .DS_Store) live in snapshot/index.ts, not here.
    const legacy = [
      "shp",
      "geojson",
      "gpkg",
      "kml",
      "kmz",
      "gml",
      "fgb",
      "gdb",
      "osm",
      "tab",
      "shx",
      "dbf",
      "prj",
      "cpg",
      "qmd",
      "sbn",
      "sbx",
      "atx",
      "qix",
      "qpj",
      "gpkg-journal",
      "gpkg-shm",
      "gpkg-wal",
      "tif",
      "tiff",
      "img",
      "ecw",
      "jp2",
      "dem",
      "asc",
      "adf",
      "tfw",
      "ovr",
      "msk",
      "rrd",
      "dxf",
      "dgn",
      "nc",
      "hdf",
      "h5",
      "zarr",
      "grib",
      "grib2",
      "grb",
      "grb2",
      "las",
      "laz",
      "lax",
      "lasx",
      "lasd",
      "mbtiles",
      "pmtiles",
      "tpk",
      "tpkx",
      "vtpk",
      "slpk",
    ]
    const known = new Set([
      ...GeoExtensions.VECTOR_MAIN,
      ...GeoExtensions.RASTER_MAIN,
      ...GeoExtensions.CAD_MAIN,
      ...GeoExtensions.SCIENTIFIC_MAIN,
      ...GeoExtensions.POINTCLOUD_MAIN,
      ...GeoExtensions.TILECACHE_MAIN,
      ...GeoExtensions.CONTAINER_DIRS,
      ...GeoExtensions.SNAPSHOT_BLANKET_SIDECARS,
      ...GeoExtensions.TRANSIENT_SUFFIXES,
    ])
    expect(legacy.filter((ext) => !known.has(ext))).toEqual([])
  })

  test("watcher transient suffixes match the prior hand-maintained ignore list", () => {
    expect(GeoExtensions.TRANSIENT_SUFFIXES.map((suffix) => `**/*.${suffix}`)).toEqual([
      "**/*.gpkg-shm",
      "**/*.gpkg-wal",
      "**/*.gpkg-journal",
      "**/*.sqlite-shm",
      "**/*.sqlite-wal",
      "**/*.sqlite-journal",
      "**/*.geodatabase-shm",
      "**/*.geodatabase-wal",
      "**/*.geodatabase-journal",
      "**/*.db-shm",
      "**/*.db-wal",
      "**/*.db-journal",
      "**/*.qgs~",
      "**/*.qgz~",
      "**/*.qml~",
      "**/*.qgs.lock",
      "**/*.qgz.lock",
      "**/*.qgs.autosave",
      "**/*.qgz.autosave",
    ])
  })
})
