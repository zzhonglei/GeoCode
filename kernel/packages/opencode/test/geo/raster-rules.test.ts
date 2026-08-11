import { describe, expect, test } from "bun:test"
import path from "node:path"
import { GdalInspector } from "@/geo/gdal/inspector"
import { GdalRaster } from "@/geo/gdal/raster"

/* The two faces of a raster preview, answering one list (§7.9 dual engines).
 *
 * Band selection and stretch exist TWICE — in TypeScript for the interface, in
 * Python for ReadGeoData — because the two pipelines run in different
 * languages and neither can call the other. Nothing was holding them level:
 * §7.9 claimed shared test cases and there were none. A user watching a scene
 * on the map while the Agent describes a differently-coloured one is the
 * failure, and it is silent.
 *
 * No production code moved to make this possible. The Python half is lifted
 * out of `raster_preview.py` at run time by fixtures/raster-rule-answer.py and
 * run with a faked GDAL, so what answers here is the shipping code rather than
 * a copy of it. Where there is no python3 that half SKIPS and says so.
 *
 * NOT covered, and not pretended to be: alpha and nodata handling, the third
 * rule §7.9 names. It is numpy arrays on one side and VRT XML on the other —
 * one intention in two expressions, with no shared input and output to
 * compare. That one still rests on review. */

/** A band is `colour` or `colour:description`; a raster is bands, space-separated. */
const BANDS = [
  { case: "one measured quantity", raster: "Gray:elevation", rgb: [1, 1, 1], alpha: null },
  { case: "grey plus alpha keeps its transparency", raster: "Gray Alpha", rgb: [1, 1, 1], alpha: 2 },
  { case: "declared colours are taken as declared", raster: "Red Green Blue", rgb: [1, 2, 3], alpha: null },
  { case: "a declared alpha rides along", raster: "Red Green Blue Alpha", rgb: [1, 2, 3], alpha: 4 },
  {
    case: "Landsat declares no colours but names every band",
    raster: "Gray:B1 Undefined:B2 Undefined:B3 Undefined:B4 Undefined:B5 Undefined:B6",
    rgb: [4, 3, 2],
    alpha: null,
  },
  {
    // The case that proves the names are read at all: by position this is 4,3,2.
    case: "names beat position when a stack is not in band order",
    raster: "Undefined:B4 Undefined:B3 Undefined:B2 Undefined:B1",
    rgb: [1, 2, 3],
    alpha: null,
  },
  {
    case: "zero-padded names are the same names",
    raster: "Undefined:B04 Undefined:B03 Undefined:B02 Undefined:B01",
    rgb: [1, 2, 3],
    alpha: null,
  },
  {
    case: "so is the spelled-out form",
    raster: "Undefined:BAND_4 Undefined:BAND_3 Undefined:BAND_2 Undefined:x",
    rgb: [1, 2, 3],
    alpha: null,
  },
  {
    case: "four unnamed bands fall back to position",
    raster: "Undefined ".repeat(4).trim(),
    rgb: [4, 3, 2],
    alpha: null,
  },
  {
    case: "three unnamed bands are the first three",
    raster: "Undefined ".repeat(3).trim(),
    rgb: [1, 2, 3],
    alpha: null,
  },
  { case: "a two-band pair reads its second as transparency", raster: "Undefined Undefined", rgb: [1, 1, 1], alpha: 2 },
]

/** `[minimum, maximum, mean, stdDev]` in, the window that becomes 0–255 out. */
const STRETCH = [
  { case: "1.8 sigma either side of the mean", statistics: [0, 30000, 9000, 2000], window: [5400, 12600] },
  { case: "clamped to the data, never widened past it", statistics: [8000, 10000, 9000, 2000], window: [8000, 10000] },
  { case: "a constant band has no window", statistics: [5, 5, 5, 0], window: [0, 255] },
  { case: "a range with no deviation falls back to the range", statistics: [0, 100, 50, 0], window: [0, 100] },
  { case: "a real DEM", statistics: [-138, 7467, 1762.131, 1712.837], window: [-138, 4845.2376] },
]

/** Pinned values are compared to six places; the two faces, exactly. */
const rounded = (values: readonly number[]) => values.map((value) => Number(value.toFixed(6)))

/** `BAND_4` in the spec is `BAND 4` in the file — the separator is the spec's, not GDAL's. */
const describedAs = (raster: string) =>
  raster.split(" ").map((part) => {
    const [colorInterpretation, description = ""] = part.split(":")
    return { colorInterpretation, description: description.replace(/_/g, " ") }
  })

const fromTypeScript = () => ({
  bands: BANDS.map((item) => {
    // Through the real parser rather than a hand-built RasterInfo: the
    // single-band derivation is part of the rule here, and it lives there.
    const info = GdalInspector.parseRaster(
      JSON.stringify({
        size: [100, 80],
        cornerCoordinates: { lowerLeft: [0, 0], upperRight: [100, 80] },
        bands: describedAs(item.raster),
      }),
    )
    const choice = GdalRaster.selectBands(info)
    return { rgb: [...choice.rgb], alpha: choice.alpha ?? null }
  }),
  stretch: STRETCH.map((item) => {
    const [minimum, maximum, mean, stdDev] = item.statistics
    return [...GdalRaster.stretch({ index: 1, minimum, maximum, mean, stdDev })]
  }),
})

describe("the raster preview rules, in TypeScript", () => {
  const ours = fromTypeScript()
  test("band selection", () => {
    BANDS.forEach((item, index) => expect(ours.bands[index], item.case).toEqual({ rgb: item.rgb, alpha: item.alpha }))
  })
  test("stretch", () => {
    STRETCH.forEach((item, index) => expect(rounded(ours.stretch[index]!), item.case).toEqual(rounded(item.window)))
  })
})

const python = ["python3", "python"].find(
  (candidate) => Bun.spawnSync([candidate, "--version"], { stdout: "pipe", stderr: "pipe" }).success,
)

describe.skipIf(!python)("the raster preview rules, lifted out of the shipping script", () => {
  test("Python answers the same list, and answers it identically", () => {
    const run = Bun.spawnSync(
      [
        python!,
        path.join(import.meta.dir, "fixtures", "raster-rule-answer.py"),
        path.join(import.meta.dir, "..", "..", "src", "geo", "qgis", "scripts", "raster_preview.py"),
      ],
      {
        stdin: Buffer.from(
          JSON.stringify({ bands: BANDS.map((item) => item.raster), stretch: STRETCH.map((item) => item.statistics) }),
        ),
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    if (!run.success) throw new Error(`raster-rule-answer.py failed:\n${run.stderr.toString()}`)
    const theirs = JSON.parse(run.stdout.toString()) as { bands: unknown[]; stretch: number[][] }
    const ours = fromTypeScript()

    // Against the pinned list AND against the other face. The first alone
    // would let a deliberate change to both sides pass unread; the second
    // alone would let the two drift together.
    BANDS.forEach((item, index) => {
      expect(theirs.bands[index], item.case).toEqual({ rgb: item.rgb, alpha: item.alpha })
      expect(theirs.bands[index], item.case).toEqual(ours.bands[index])
    })
    STRETCH.forEach((item, index) => {
      expect(rounded(theirs.stretch[index]!), item.case).toEqual(rounded(item.window))
      expect(theirs.stretch[index], item.case).toEqual(ours.stretch[index]!)
    })
  })
})
