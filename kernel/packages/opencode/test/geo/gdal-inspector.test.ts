import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { GdalInspector } from "@/geo/gdal/inspector"

/* Reading what a file is (docs/GEOKERNEL.md §7.4, §7.5). The fixtures are real `gdalinfo -json` and
 * `ogrinfo -json -so` output, awkward parts included. */

/** China DEM, 1 km: one band, its own overviews, and no authority code in its coordinate system. */
const DEM = JSON.stringify({
  size: [6857, 5537],
  geoTransform: [73.4911734, 0.008983153, 0, 53.5665404, 0, -0.008983153],
  cornerCoordinates: {
    lowerLeft: [73.4911734, 3.8268231],
    upperRight: [135.0886524, 53.5665404],
  },
  coordinateSystem: {
    wkt: 'GEOGCRS["WGS 84",\n    ENSEMBLE["World Geodetic System 1984 ensemble"]]',
    projjson: { id: null },
  },
  bands: [
    {
      colorInterpretation: "Gray",
      description: "elevation",
      minimum: -138,
      maximum: 7467,
      mean: 1762.131,
      stdDev: 1712.837,
      overviews: [{ size: [3429, 2769] }, { size: [1715, 1385] }],
    },
  ],
})

const SHAPEFILE = JSON.stringify({
  layers: [
    {
      name: "wuchang_utm49n",
      featureCount: 1,
      geometryFields: [{ type: "Polygon", coordinateSystem: { projjson: { id: { authority: "EPSG", code: 32649 } } } }],
      fields: [{ name: "name" }, { name: "adcode" }, { name: "gb" }, { name: "level" }],
    },
  ],
})

const raster = (over: object) =>
  JSON.stringify({
    size: [100, 80],
    cornerCoordinates: { lowerLeft: [0, 0], upperRight: [100, 80] },
    ...over,
  })

describe("gdal raster metadata", () => {
  test("a real single-band raster, down to the awkward parts", () => {
    const info = GdalInspector.parseRaster(DEM)
    expect(info.width).toBe(6857)
    expect(info.height).toBe(5537)
    expect(info.bandCount).toBe(1)
    expect(info.singleBand).toBe(true)
    expect(info.hasOverview).toBe(true)
    expect(info.bands[0]!.mean).toBeCloseTo(1762.131, 3)
    expect(info.georeference).toBe("transform")
  })

  test("a coordinate system with no authority code still yields a name", () => {
    expect(GdalInspector.parseRaster(DEM).projection).toBe("WGS 84")
    expect(GdalInspector.projectionOf({ projjson: { id: { authority: "EPSG", code: 3857 } } })).toBe("EPSG:3857")
    expect(GdalInspector.projectionOf({})).toBeUndefined()
  })

  test("an image that merely happens to be a TIFF is not geographic data", () => {
    const plain = GdalInspector.parseRaster(raster({ bands: [{ colorInterpretation: "Red" }] }))
    expect(plain.georeference).toBe("none")

    // GDAL hands the identity transform back for a file that has none, so a file carrying it literally has to read
    // the same as one carrying nothing.
    const identity = GdalInspector.parseRaster(raster({ geoTransform: [0, 1, 0, 0, 0, 1] }))
    expect(identity.georeference).toBe("none")

    // Zero is a legitimate origin; it is the identity as a whole that reads as no placement.
    const atOrigin = GdalInspector.parseRaster(raster({ geoTransform: [0, 0.01, 0, 1, 0, -0.01] }))
    expect(atOrigin.georeference).toBe("transform")
  })

  test("a scene with no transform is still data when it says where it is another way", () => {
    const gcps = GdalInspector.parseRaster(raster({ gcps: { gcpList: [{ id: "1" }, { id: "2" }, { id: "3" }] } }))
    expect(gcps.georeference).toBe("gcp")

    const rpc = GdalInspector.parseRaster(raster({ metadata: { RPC: { LINE_OFF: "5000" } } }))
    expect(rpc.georeference).toBe("rpc")

    const swath = GdalInspector.parseRaster(raster({ metadata: { GEOLOCATION: { X_BAND: "1" } } }))
    expect(swath.georeference).toBe("geolocation")

    const named = GdalInspector.parseRaster(
      raster({ coordinateSystem: { projjson: { id: { authority: "EPSG", code: 4326 } } } }),
    )
    expect(named.georeference).toBe("crs-only")

    // Present but empty is not evidence.
    const empty = GdalInspector.parseRaster(raster({ metadata: { RPC: {}, GEOLOCATION: {} }, gcps: { gcpList: [] } }))
    expect(empty.georeference).toBe("none")
  })

  test("the answer is the most directly usable one present, not the first one found", () => {
    const orthorectified = GdalInspector.parseRaster(
      raster({ geoTransform: [300000, 30, 0, 3530730, 0, -30], metadata: { RPC: { LINE_OFF: "5000" } } }),
    )
    expect(orthorectified.georeference).toBe("transform")

    const bothRaw = GdalInspector.parseRaster(
      raster({ gcps: { gcpList: [{ id: "1" }] }, metadata: { RPC: { LINE_OFF: "5000" } } }),
    )
    expect(bothRaw.georeference).toBe("gcp")
  })

  test("a transform that cannot be inverted is not a placement", () => {
    expect(GdalInspector.parseRaster(raster({ geoTransform: [100, 0, 0, 200, 0, 0] })).georeference).toBe("none")
  })

  test("grey with an alpha band colourizes like one band, not like three", () => {
    const withCrs = (bands: object[]) =>
      raster({ coordinateSystem: { projjson: { id: { authority: "EPSG", code: 4326 } } }, bands })
    const greyAlpha = GdalInspector.parseRaster(
      withCrs([{ colorInterpretation: "Gray" }, { colorInterpretation: "Alpha" }]),
    )
    expect(greyAlpha.singleBand).toBe(true)

    const rgb = GdalInspector.parseRaster(
      withCrs([{ colorInterpretation: "Red" }, { colorInterpretation: "Green" }, { colorInterpretation: "Blue" }]),
    )
    expect(rgb.singleBand).toBe(false)
  })

  test("the extent is normalized whichever way round the corners came", () => {
    const info = GdalInspector.parseRaster(
      raster({ cornerCoordinates: { lowerLeft: [135, 53], upperRight: [73, 3] }, bands: [] }),
    )
    expect(info.extent).toEqual([73, 3, 135, 53])
  })
})

describe("gdal vector metadata", () => {
  test("a real shapefile layer", () => {
    const info = GdalInspector.parseVector(SHAPEFILE)
    expect(info.name).toBe("wuchang_utm49n")
    expect(info.featureCount).toBe(1)
    expect(info.geometryTypes).toEqual(["Polygon"])
    expect(info.properties).toEqual(["name", "adcode", "gb", "level"])
    expect(info.projection).toBe("EPSG:32649")
  })

  test("a file with no layer says so rather than reporting an empty one", () => {
    expect(() => GdalInspector.parseVector(JSON.stringify({ layers: [] }))).toThrow(/no vector layer/)
  })
})

describe("gdal metadata failures reach the caller", () => {
  test("unreadable output is a failure, not a defect", async () => {
    const outcome = await Effect.runPromise(
      Effect.succeed("<html>not json</html>").pipe(
        Effect.flatMap((stdout) => Effect.try({ try: () => GdalInspector.parseRaster(stdout), catch: (e) => e })),
        Effect.result,
        Effect.catchDefect(() => Effect.succeed({ _tag: "Defect" as const })),
      ),
    )
    expect(outcome._tag).toBe("Failure")
  })
})

describe("gdal version capability", () => {
  test("band selection is read off the binary, not guessed from a version", () => {
    // One line of real `gdalwarp --help` from GDAL 3.13.3, which spells the flag `-srcband` and prints no bare `-b`.
    expect(GdalInspector.warpSelectsBands("[-if <format>]... [-srcband <band>]... [-dstband <band>]...")).toBe(true)
    // The same flag under its other spelling (3.13.3's long usage lists `-b, -srcband`); a check tuned to one
    // spelling answers "no" for the other.
    expect(GdalInspector.warpSelectsBands("Usage: gdalwarp [-b <band>] src dst")).toBe(true)
    expect(GdalInspector.warpSelectsBands("gdalwarp [-r <method>] [-of <format>] src dst")).toBe(false)
  })
})
