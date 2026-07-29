import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { GdalInspector } from "@/geo/gdal/inspector"

/* Reading what a file is (docs/GEOKERNEL.md §7.4, §7.5).
 *
 * The fixtures below carry values taken from real `gdalinfo` / `ogrinfo` output
 * on real data — a 1 km China DEM and a UTM shapefile — because the shapes that
 * matter here are the ones the tools actually emit, including the awkward ones
 * a hand-written fixture would never think to include. */

/** China DEM, 1 km: one band, its own overviews, and NO authority code. */
const DEM = JSON.stringify({
  size: [6857, 5537],
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
    // Its own overviews. Free speed for the reprojection, and never something
    // this module builds (§7.5).
    expect(info.hasOverview).toBe(true)
    expect(info.bands[0]!.mean).toBeCloseTo(1762.131, 3)
    expect(info.geographic).toBe(true)
  })

  test("a coordinate system with no authority code still yields a name", () => {
    // Real output: this file's `projjson.id` is null. Falling back to the WKT
    // name is the difference between telling the user "WGS 84" and telling
    // them nothing.
    expect(GdalInspector.parseRaster(DEM).projection).toBe("WGS 84")
    expect(GdalInspector.projectionOf({ projjson: { id: { authority: "EPSG", code: 3857 } } })).toBe("EPSG:3857")
    expect(GdalInspector.projectionOf({})).toBeUndefined()
  })

  test("an image that merely happens to be a TIFF is not geographic data", () => {
    // No coordinate system, and an extent that is exactly the pixel grid. Into
    // the pipeline it would become a reprojection of nothing onto nowhere.
    const plain = GdalInspector.parseRaster(raster({ bands: [{ colorInterpretation: "Red" }] }))
    expect(plain.geographic).toBe(false)

    // Georeferenced but at the origin: the extent alone is not the test.
    const atOrigin = GdalInspector.parseRaster(
      raster({
        coordinateSystem: { projjson: { id: { authority: "EPSG", code: 4326 } } },
        cornerCoordinates: { lowerLeft: [0, 0], upperRight: [1, 1] },
        bands: [{ colorInterpretation: "Gray" }],
      }),
    )
    expect(atOrigin.geographic).toBe(true)
  })

  test("grey with an alpha band colourizes like one band, not like three", () => {
    const withCrs = (bands: object[]) =>
      raster({ coordinateSystem: { projjson: { id: { authority: "EPSG", code: 4326 } } }, bands })
    const greyAlpha = GdalInspector.parseRaster(
      withCrs([{ colorInterpretation: "Gray" }, { colorInterpretation: "Alpha" }]),
    )
    // The second band is transparency, not a channel.
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
    expect(info.featureCount).toBe(1)
    // The interface picks a renderer from this; a wrong answer picks the wrong
    // one (§7.4).
    expect(info.geometryTypes).toEqual(["Polygon"])
    expect(info.properties).toEqual(["name", "adcode", "gb", "level"])
    expect(info.projection).toBe("EPSG:32649")
  })

  test("a file with no layer says so rather than reporting an empty one", () => {
    // Zero features and no layer at all are different facts, and the second is
    // not something to report as the first.
    expect(() => GdalInspector.parseVector(JSON.stringify({ layers: [] }))).toThrow(/no vector layer/)
  })
})

describe("gdal metadata failures reach the caller", () => {
  test("unreadable output is a failure, not a defect", async () => {
    // A throw left inside an Effect becomes a defect: outside the declared
    // error type, uncatchable by every caller, fatal to a request whose honest
    // answer was "this file is not readable".
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
    // Older builds cannot select bands, and the pipeline has to insert a
    // separate step for them. Version-to-feature mapping would be a second
    // thing to get wrong, and users install whatever their platform ships.
    // Real GDAL 3.13 usage: the flag is spelled -srcband here, and a bare -b
    // does not appear at all.
    expect(GdalInspector.warpSelectsBands("[-if <format>]... [-srcband <band>]... [-dstband <band>]...")).toBe(true)
    // Bracketed, which is how other builds format the same capability. A
    // substring check tuned to one spelling answers "no" for the other.
    expect(GdalInspector.warpSelectsBands("Usage: gdalwarp [-b <band>] src dst")).toBe(true)
    expect(GdalInspector.warpSelectsBands("gdalwarp [-r <method>] [-of <format>] src dst")).toBe(false)
  })
})
