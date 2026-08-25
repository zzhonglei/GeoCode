import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { QgisCatalog } from "@/geo/qgis/catalog"
import { QgisDestination } from "@/geo/qgis/destination"

/* Where an algorithm's output goes (docs/GEOKERNEL.md §4.12, §10.1 #6): the numbering that keeps a run from
 * overwriting geographic data undo cannot reach, and the two fences — a destination by parameter type, an absolute
 * value — that keep the re-pointing off anything that was never an output. */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "geo-qgis-dest-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let counter = 0
/** A fresh directory per test, so one test's files cannot number another's. */
function dir(): string {
  const made = path.join(root, `case-${counter++}`)
  fs.mkdirSync(made, { recursive: true })
  return made
}

const param = (name: string, type: string): QgisCatalog.Param => ({
  name,
  description: name,
  type,
  defaultValue: null,
  options: [],
  optional: false,
})

const algorithm = (...parameters: QgisCatalog.Param[]): QgisCatalog.Algorithm => ({
  id: "native:test",
  name: "Test",
  group: "Testing",
  description: "",
  helpText: "",
  parameters,
  outputs: [],
})

describe("numbering", () => {
  test("a free name is handed back untouched", () => {
    const at = dir()
    expect(QgisDestination.free(path.join(at, "out.shp"))).toBe(path.join(at, "out.shp"))
  })

  test("a taken name is numbered the way a browser numbers a repeated download", () => {
    const at = dir()
    const asked = path.join(at, "out.shp")
    fs.writeFileSync(asked, "first")
    expect(QgisDestination.free(asked)).toBe(path.join(at, "out (1).shp"))

    fs.writeFileSync(path.join(at, "out (1).shp"), "second")
    expect(QgisDestination.free(asked)).toBe(path.join(at, "out (2).shp"))
  })

  test("the number goes before the extension, so the format still reads", () => {
    const at = dir()
    const asked = path.join(at, "scene.tif")
    fs.writeFileSync(asked, "raster")
    const numbered = QgisDestination.free(asked)
    expect(path.extname(numbered)).toBe(".tif")
    expect(path.basename(numbered)).toBe("scene (1).tif")
  })

  test("a name with no extension still numbers", () => {
    const at = dir()
    const asked = path.join(at, "report")
    fs.writeFileSync(asked, "x")
    expect(QgisDestination.free(asked)).toBe(path.join(at, "report (1)"))
  })

  test("a name QGIS would grow into an existing file counts as taken", () => {
    // QGIS appends its own extension to a name it does not recognise, so `existsSync` on the literal string calls
    // `noext` free while `noext.gpkg` is about to be written over (destination.ts `occupants`).
    const at = dir()
    fs.writeFileSync(path.join(at, "noext.gpkg"), "previous run")
    expect(QgisDestination.free(path.join(at, "noext"))).toBe(path.join(at, "noext (1)"))

    fs.writeFileSync(path.join(at, "weird.xyz.gpkg"), "previous run")
    expect(QgisDestination.free(path.join(at, "weird.xyz"))).toBe(path.join(at, "weird (1).xyz"))
  })

  test("a longer name that merely starts the same way is not taken", () => {
    // A name plus an extension, not a name plus anything: numbering away from a free name sends the caller after a
    // path it never asked for.
    const at = dir()
    fs.writeFileSync(path.join(at, "census_2020.gpkg"), "unrelated")
    expect(QgisDestination.free(path.join(at, "census"))).toBe(path.join(at, "census"))
  })
})

describe("what counts as a destination", () => {
  test("all six destination types are recognised, and nothing else is", () => {
    const at = dir()
    const destinations = ["sink", "rasterDestination", "fileDestination", "vectorDestination", "vectorTileDestination"]
    for (const type of destinations) {
      const asked = path.join(at, `${type}.dat`)
      fs.writeFileSync(asked, "taken")
      const reserved = QgisDestination.reserve(algorithm(param("OUT", type)), { OUT: asked })
      expect(reserved).toHaveLength(1)
      expect(reserved[0]!.actual).toBe(path.join(at, `${type} (1).dat`))
    }

    // The types a real catalog uses for inputs: treat one as an output and the algorithm is pointed at a numbered
    // name nothing ever wrote.
    for (const type of ["source", "raster", "vector", "file", "string", "enum", "number", "crs", "extent"]) {
      const asked = path.join(at, "input.shp")
      fs.writeFileSync(asked, "taken")
      expect(QgisDestination.reserve(algorithm(param("IN", type)), { IN: asked })).toEqual([])
    }
  })

  test("a destination that is not an absolute path is left entirely alone", () => {
    // The ordinary ways a destination says "QGIS decides"; re-pointing one turns a working call into a write
    // somewhere nobody asked for.
    const known = algorithm(param("OUTPUT", "sink"))
    for (const value of ["TEMPORARY_OUTPUT", "memory:", "out.shp", 42, null]) {
      expect(QgisDestination.reserve(known, { OUTPUT: value })).toEqual([])
    }
    expect(QgisDestination.reserve(known, {})).toEqual([])
  })

  test("an algorithm the catalog does not know yields nothing at all", () => {
    const at = dir()
    const asked = path.join(at, "out.shp")
    fs.writeFileSync(asked, "taken")
    expect(QgisDestination.reserve(undefined, { OUTPUT: asked })).toEqual([])
  })

  test("a folder destination is reported but never numbered", () => {
    // An existing directory is the ordinary case for these, so numbering would answer a correct call by inventing
    // `output (1)/`.
    const at = dir()
    const folder = path.join(at, "tiles")
    fs.mkdirSync(folder)
    const reserved = QgisDestination.reserve(algorithm(param("OUTPUT", "folderDestination")), { OUTPUT: folder })
    expect(reserved).toHaveLength(1)
    expect(reserved[0]!.actual).toBe(folder)
    expect(reserved[0]!.folder).toBe(true)
  })

  test("several destinations in one call are each settled on their own", () => {
    const at = dir()
    const taken = path.join(at, "taken.shp")
    const freeName = path.join(at, "free.shp")
    fs.writeFileSync(taken, "x")
    const reserved = QgisDestination.reserve(
      algorithm(param("OUTPUT", "sink"), param("SIDECAR", "fileDestination"), param("INPUT", "source")),
      { OUTPUT: taken, SIDECAR: freeName, INPUT: taken },
    )
    expect(reserved.map((item) => [item.parameter, item.actual])).toEqual([
      ["OUTPUT", path.join(at, "taken (1).shp")],
      ["SIDECAR", freeName],
    ])
  })

  test("two destinations of one call cannot be sent to the same place", () => {
    // The overwrite this module can arrange by itself: OUTPUT is moved onto the name SIDECAR was asked for, and the
    // report describes the collision as a rescue.
    const at = dir()
    fs.writeFileSync(path.join(at, "out.shp"), "x")
    const reserved = QgisDestination.reserve(algorithm(param("OUTPUT", "sink"), param("SIDECAR", "fileDestination")), {
      OUTPUT: path.join(at, "out.shp"),
      SIDECAR: path.join(at, "out (1).shp"),
    })
    expect(reserved[0]!.actual).toBe(path.join(at, "out (1).shp"))
    // The property, not the spelling: which free name the second output landed on carries no promise.
    expect(reserved[1]!.actual).not.toBe(reserved[0]!.actual)
    expect(fs.existsSync(reserved[1]!.actual)).toBe(false)
  })
})

describe("no parameter name switches the numbering off", () => {
  /* The exemption these guard against: numbering a genuine append leaves the original recoverable, waiving it lets
   * an overwrite land where checkpoints cannot reach (docs/GEOKERNEL.md §10.1 #6, §4.12). */
  const CONTROLS = ["OVERWRITE", "ACTION_ON_EXISTING_FILE"]

  test("a destination is numbered even when the algorithm has a parameter for pre-existing files", () => {
    for (const control of CONTROLS) {
      const at = dir()
      const asked = path.join(at, "atlas.gpkg")
      fs.writeFileSync(asked, "the user's database")
      const reserved = QgisDestination.reserve(algorithm(param("OUTPUT", "fileDestination"), param(control, "enum")), {
        OUTPUT: asked,
      })
      expect(reserved).toHaveLength(1)
      expect(reserved[0]!.actual).toBe(path.join(at, "atlas (1).gpkg"))
      expect(fs.readFileSync(asked, "utf8")).toBe("the user's database")
    }
  })

  test("the report says the new file is NOT an addition to the old one", () => {
    // A relocated append is filed as a success when "already existed and is untouched" is all the caller is told.
    const at = dir()
    const asked = path.join(at, "atlas.gpkg")
    fs.writeFileSync(asked, "the user's database")
    const line = QgisDestination.report(
      QgisDestination.reserve(algorithm(param("OUTPUT", "fileDestination"), param("OVERWRITE", "boolean")), {
        OUTPUT: asked,
      }),
    )
    expect(line).toContain(path.join(at, "atlas (1).gpkg"))
    expect(line).toContain("not an addition")
    expect(
      QgisDestination.report(
        QgisDestination.reserve(algorithm(param("OUTPUT", "fileDestination"), param("OVERWRITE", "boolean")), {
          OUTPUT: path.join(at, "fresh.gpkg"),
        }),
      ),
    ).toBeUndefined()
  })

  test("nor does anything that merely sounds like one", () => {
    // Names a keyword rule would match — `gdal:proximity`'s `REPLACE` is a pixel value — so no such rule can
    // stand in for the exemption.
    for (const lookalike of ["GEOREFERENCE", "REPLACE", "UPDATE_EXISTING", "APPEND_MODE", "OVERWRITE"]) {
      const at = dir()
      const asked = path.join(at, "out.shp")
      fs.writeFileSync(asked, "x")
      const reserved = QgisDestination.reserve(algorithm(param("OUTPUT", "sink"), param(lookalike, "boolean")), {
        OUTPUT: asked,
      })
      expect(reserved[0]!.actual).toBe(path.join(at, "out (1).shp"))
    }
  })
})

describe("where the output really landed", () => {
  test("a file QGIS named for itself is resolved before it is reported", () => {
    // The caller opens the reported path next, and `/x/result` is not openable when the run produced
    // `/x/result.gpkg`.
    const at = dir()
    const asked = path.join(at, "result")
    const reserved = QgisDestination.reserve(algorithm(param("OUTPUT", "sink")), { OUTPUT: asked })
    expect(reserved[0]!.actual).toBe(asked)

    fs.writeFileSync(path.join(at, "result.gpkg"), "what QGIS wrote")
    const settled = QgisDestination.settle(reserved)
    expect(settled[0]!.landed).toBe(path.join(at, "result.gpkg"))
    expect(QgisDestination.report(settled)).toContain(path.join(at, "result.gpkg"))
  })

  test("an output that landed where it was sent is left alone and says nothing", () => {
    const at = dir()
    const asked = path.join(at, "out.shp")
    const reserved = QgisDestination.reserve(algorithm(param("OUTPUT", "sink")), { OUTPUT: asked })
    fs.writeFileSync(asked, "exactly where it was sent")
    const settled = QgisDestination.settle(reserved)
    expect(settled[0]!.landed).toBeUndefined()
    expect(QgisDestination.report(settled)).toBeUndefined()
  })

  test("several candidates mean nobody is named", () => {
    // A driver that wrote a family, or left a sidecar: naming one of them would be a guess presented as a fact.
    const at = dir()
    const asked = path.join(at, "family")
    const reserved = QgisDestination.reserve(algorithm(param("OUTPUT", "sink")), { OUTPUT: asked })
    fs.writeFileSync(path.join(at, "family.shp"), "x")
    fs.writeFileSync(path.join(at, "family.dbf"), "x")
    expect(QgisDestination.settle(reserved)[0]!.landed).toBeUndefined()
  })
})

describe("what the caller is handed back", () => {
  test("only the moved destinations are substituted, and the object is not mutated", () => {
    const at = dir()
    const taken = path.join(at, "taken.shp")
    const freeName = path.join(at, "free.shp")
    fs.writeFileSync(taken, "x")
    const parameters = { OUTPUT: taken, SIDECAR: freeName, DISTANCE: 10 }
    const reserved = QgisDestination.reserve(
      algorithm(param("OUTPUT", "sink"), param("SIDECAR", "fileDestination")),
      parameters,
    )
    const applied = QgisDestination.apply(parameters, reserved)
    expect(applied.OUTPUT).toBe(path.join(at, "taken (1).shp"))
    expect(applied.SIDECAR).toBe(freeName)
    expect(applied.DISTANCE).toBe(10)
    expect(parameters.OUTPUT).toBe(taken)
  })

  test("the report names the moved paths and says nothing when none moved", () => {
    // A note that fires on every run is the noise that gets the whole channel skipped.
    const at = dir()
    const taken = path.join(at, "taken.shp")
    fs.writeFileSync(taken, "x")
    const known = algorithm(param("OUTPUT", "sink"))

    expect(
      QgisDestination.report(QgisDestination.reserve(known, { OUTPUT: path.join(at, "free.shp") })),
    ).toBeUndefined()

    const moved = QgisDestination.report(QgisDestination.reserve(known, { OUTPUT: taken }))
    expect(moved).toContain(`OUTPUT written to ${path.join(at, "taken (1).shp")}`)
    // Both paths, since an algorithm with several outputs needs to know which of its names was the taken one.
    expect(moved).toContain(taken)
    expect(moved).toContain("untouched")
  })

  test("a missing parent directory is created rather than refused", () => {
    const at = dir()
    const deep = path.join(at, "a", "b", "out.shp")
    const reserved = QgisDestination.reserve(algorithm(param("OUTPUT", "sink")), { OUTPUT: deep })
    expect(fs.existsSync(path.dirname(deep))).toBe(false)
    QgisDestination.ensureParents(reserved)
    expect(fs.existsSync(path.dirname(deep))).toBe(true)
  })

  test("a folder destination gets its parent, and the leaf is left to the algorithm", () => {
    const at = dir()
    const folder = path.join(at, "outer", "tiles")
    const reserved = QgisDestination.reserve(algorithm(param("OUTPUT", "folderDestination")), { OUTPUT: folder })
    QgisDestination.ensureParents(reserved)
    expect(fs.existsSync(path.join(at, "outer"))).toBe(true)
  })
})
