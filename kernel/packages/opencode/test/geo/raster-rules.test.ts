import { describe, expect, test } from "bun:test"
import path from "node:path"
import { GdalInspector } from "@/geo/gdal/inspector"
import { GdalRaster } from "@/geo/gdal/raster"
import { RASTER_PREVIEW_PY } from "@/geo/qgis/scripts.generated"

/* One list of cases answered by both faces of the raster preview (docs/GEOKERNEL.md §7.9): band selection and
 * stretch exist in TypeScript and in Python, and nothing else holds them level. */

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
    // By position these four would be 4,3,2.
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
  {
    // The Python half needs an explicit length guard here where the TypeScript half reads `bands[0]?.color`.
    case: "a container has no bands to choose between, and does not crash either face",
    raster: "",
    rgb: [1, 1, 1],
    alpha: null,
  },
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

/** `_` stands for a space, so `BAND_4` above is `BAND 4` in the file; the empty string is a raster with no bands. */
const describedAs = (raster: string) =>
  raster
    .split(" ")
    .filter((part) => part !== "")
    .map((part) => {
      const [colorInterpretation, description = ""] = part.split(":")
      return { colorInterpretation, description: description.replace(/_/g, " ") }
    })

const fromTypeScript = () => ({
  bands: BANDS.map((item) => {
    // Through the real parser rather than a hand-built RasterInfo: the single-band derivation lives there.
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

test("the two faces cap a preview at DIFFERENT sizes, and are meant to", () => {
  // A map preview is zoomed into, so it is drawn at 4096; a model attachment is read once and charged for, so it
  // is drawn at 2048 (raster_preview.py).
  expect(GdalRaster.previewSize(10_000, 10_000).width).toBe(4096)
  expect(RASTER_PREVIEW_PY).toContain("MAX_SIDE = 2048")
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

    // Both faces against the pinned list, and against each other: the pinned stretch comparison rounds to six
    // places, so only the face-to-face check catches a difference below that.
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
