import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { QgisCatalog } from "@/geo/qgis/catalog"
import { QgisDestination } from "@/geo/qgis/destination"

/* Where an algorithm's output goes (docs/GEOKERNEL.md §4.12, §10.1 #6).
 *
 * The rule this file exists for: **RunQgisAlgorithm never overwrites**. It is
 * the same rule OSM's writer follows (§6.7) and it is here for a sharper
 * reason — geographic data is deliberately outside the checkpoint mechanism, so
 * a scene written over is gone with nothing to restore it from. Not
 * overwriting is the only defence there is.
 *
 * The other half is restraint. Re-pointing a parameter is a stronger act than
 * the advice §4.12 permits, so the two fences around it — the catalog calls it
 * a destination, AND the value looks like an absolute path — are asserted as
 * carefully as the numbering itself. A check that re-points something that was
 * never an output does more damage than the overwrite it was meant to stop.
 */

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
    // `out (1).shp`, not `out-1.shp` and not `out_1.shp`. The audience is
    // geographers rather than programmers, and this is the shape they already
    // read every time they download the same file twice. Asserted literally
    // because the whole value of the choice is that it is THAT shape.
    const at = dir()
    const asked = path.join(at, "out.shp")
    fs.writeFileSync(asked, "first")
    expect(QgisDestination.free(asked)).toBe(path.join(at, "out (1).shp"))

    fs.writeFileSync(path.join(at, "out (1).shp"), "second")
    expect(QgisDestination.free(asked)).toBe(path.join(at, "out (2).shp"))
  })

  test("the number goes before the extension, so the format still reads", () => {
    // `out (1).shp` and never `out.shp (1)`. Every GIS reader in the chain
    // dispatches on the extension; moving it makes the file unopenable by the
    // very tool that was asked to produce it.
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
    // Measured on 3.44: `native:buffer` with OUTPUT=/x/noext writes noext.gpkg,
    // and with OUTPUT=/x/weird.xyz writes weird.xyz.gpkg — QGIS appends its own
    // extension to anything it does not recognise. Asking `existsSync` about
    // the literal string therefore answers "free" for a name that is about to
    // be written over, which is the single outcome this module exists to
    // prevent and the one no test was making.
    const at = dir()
    fs.writeFileSync(path.join(at, "noext.gpkg"), "previous run")
    expect(QgisDestination.free(path.join(at, "noext"))).toBe(path.join(at, "noext (1)"))

    // The number still goes before the extension, unrecognised or not — the
    // rule above about a format staying readable does not get an exception for
    // a name QGIS is going to add to anyway.
    fs.writeFileSync(path.join(at, "weird.xyz.gpkg"), "previous run")
    expect(QgisDestination.free(path.join(at, "weird.xyz"))).toBe(path.join(at, "weird (1).xyz"))
  })

  test("a longer name that merely starts the same way is not taken", () => {
    // The rule is "a name plus an extension", not "a name plus anything". A
    // dataset called `census_2020.gpkg` says nothing about whether `census` is
    // free, and numbering away from a name nothing occupies would leave the
    // caller chasing paths it never asked for.
    const at = dir()
    fs.writeFileSync(path.join(at, "census_2020.gpkg"), "unrelated")
    expect(QgisDestination.free(path.join(at, "census"))).toBe(path.join(at, "census"))
  })
})

describe("what counts as a destination", () => {
  test("all six destination types are recognised, and nothing else is", () => {
    // The six come from a real 3.44 registry: 432 destination parameters across
    // native/gdal/qgis, and no non-destination parameter anywhere answers with
    // any of these strings. That measurement is what makes a name comparison
    // sound enough to re-point a path on, so the list is pinned rather than
    // trusted to memory.
    const at = dir()
    const destinations = ["sink", "rasterDestination", "fileDestination", "vectorDestination", "vectorTileDestination"]
    for (const type of destinations) {
      const asked = path.join(at, `${type}.dat`)
      fs.writeFileSync(asked, "taken")
      const reserved = QgisDestination.reserve(algorithm(param("OUT", type)), { OUT: asked })
      expect(reserved).toHaveLength(1)
      expect(reserved[0]!.actual).toBe(path.join(at, `${type} (1).dat`))
    }

    // The types a real catalog uses for INPUTS. If any of these ever started
    // being treated as an output, a correct call would have its input silently
    // renamed and the algorithm would read a file that is not there.
    for (const type of ["source", "raster", "vector", "file", "string", "enum", "number", "crs", "extent"]) {
      const asked = path.join(at, "input.shp")
      fs.writeFileSync(asked, "taken")
      expect(QgisDestination.reserve(algorithm(param("IN", type)), { IN: asked })).toEqual([])
    }
  })

  test("a destination that is not an absolute path is left entirely alone", () => {
    // Both fences have to hold, not just the catalog one. These three are the
    // ordinary ways a destination says "QGIS decides", and re-pointing any of
    // them would turn a working call into a write somewhere nobody asked for.
    const known = algorithm(param("OUTPUT", "sink"))
    for (const value of ["TEMPORARY_OUTPUT", "memory:", "out.shp", 42, null]) {
      expect(QgisDestination.reserve(known, { OUTPUT: value })).toEqual([])
    }
    // An absent parameter is the fourth, and the most common of all.
    expect(QgisDestination.reserve(known, {})).toEqual([])
  })

  test("an algorithm the catalog does not know yields nothing at all", () => {
    // Without metadata there is no way to tell a destination from any other
    // string. Guessing here would re-point a parameter that was never an
    // output — the failure §4.12 exists to prevent.
    const at = dir()
    const asked = path.join(at, "out.shp")
    fs.writeFileSync(asked, "taken")
    expect(QgisDestination.reserve(undefined, { OUTPUT: asked })).toEqual([])
  })

  test("a folder destination is reported but never numbered", () => {
    // Eight algorithms produce a set whose size is not known in advance, and
    // for those an EXISTING directory is the ordinary case: the user means
    // "put it in here". Numbering would answer a correct call by inventing
    // `output (1)/` and leaving the files where they were not asked for.
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
    // The collision this module can cause by itself: OUTPUT is moved off a
    // taken name onto `out (1).shp`, and `out (1).shp` is exactly what SIDECAR
    // was asked for. Both then write to one path — the same overwrite as any
    // other, only arranged here rather than by the caller — and the report
    // would describe it as a rescue.
    const at = dir()
    fs.writeFileSync(path.join(at, "out.shp"), "x")
    const reserved = QgisDestination.reserve(
      algorithm(param("OUTPUT", "sink"), param("SIDECAR", "fileDestination")),
      { OUTPUT: path.join(at, "out.shp"), SIDECAR: path.join(at, "out (1).shp") },
    )
    expect(reserved[0]!.actual).toBe(path.join(at, "out (1).shp"))
    // The property, not the spelling: what matters is that the second output
    // was moved off the first one's name, not which free name it landed on.
    expect(reserved[1]!.actual).not.toBe(reserved[0]!.actual)
    expect(fs.existsSync(reserved[1]!.actual)).toBe(false)
  })
})

describe("no parameter name switches the numbering off", () => {
  /* ⚠️ This block asserted the OPPOSITE until 2026-08-20, and the reversal is
   * the point — read the note at the top of destination.ts before changing it
   * back.
   *
   * There was an exemption: an algorithm carrying `OVERWRITE` or
   * `ACTION_ON_EXISTING_FILE` had its destination left alone, because for
   * `native:package` and `native:savefeatures` an existing target is the point
   * of the call. Two measurements on a real 3.44 registry killed it. The
   * exemption tested whether the parameter EXISTED and never what the call set
   * it to, while the defaults run the other way — `ACTION_ON_EXISTING_FILE`
   * defaults to 0, "Create or overwrite file", and `native:exporttospreadsheet`
   * defaults `OVERWRITE` to True — so an ordinary call that left the parameter
   * alone had its protection waived and its file overwritten. And a list of
   * names measured on this machine cannot describe the QGIS a user installed.
   *
   * The trade that remains is between two failures of different size: numbering
   * an append leaves the original intact and the result recoverable; waiving it
   * lets an overwrite land on data checkpoints do not hold. Take the
   * recoverable one.
   */
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
      // And the user's file is still the user's file.
      expect(fs.readFileSync(asked, "utf8")).toBe("the user's database")
    }
  })

  test("the report says the new file is NOT an addition to the old one", () => {
    /* The sentence that makes the trade honest. A call that meant to append now
     * writes beside the target instead, and "already existed and is untouched"
     * on its own reads as pure good news — the caller would file a silently
     * relocated append as a success. */
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
    // Nothing at all is said when the target was not there: the promise is
    // whole in that case, and a note that fires anyway is noise.
    expect(
      QgisDestination.report(
        QgisDestination.reserve(algorithm(param("OUTPUT", "fileDestination"), param("OVERWRITE", "boolean")), {
          OUTPUT: path.join(at, "fresh.gpkg"),
        }),
      ),
    ).toBeUndefined()
  })

  test("nor does anything that merely sounds like one", () => {
    /* Kept from the version of this block that had a name list, because it is
     * now guarding the opposite thing: that nobody reintroduces one. Every
     * structural alternative was probed against a real registry and each failed
     * — `supports_append` is a property of the sink type and matches 83
     * algorithms, `widget_wrapper.dontconfirmoverwrite` matches 2 of the 3 and
     * is a GUI hint, and a keyword test matches `GEOREFERENCE` ("Append
     * georeference information", onto a PDF) and `gdal:proximity`'s `REPLACE`
     * (a pixel value). */
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
    // `free()` keeps the data safe without knowing what QGIS will write, but
    // the report has to name a file that is THERE: the caller is told to use
    // that path for its next step, and `/x/result` is not openable when the
    // run produced `/x/result.gpkg`.
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
    // A driver that wrote a family, or left a sidecar beside its output. There
    // is no way to tell which one the caller should open next, and naming one
    // of them would be a guess presented as a fact — `actual` is at least what
    // was asked for.
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
    // The caller still holds the original for its own reporting.
    expect(parameters.OUTPUT).toBe(taken)
  })

  test("the report names the moved paths and says nothing when none moved", () => {
    // A note that fires on every run is the kind of noise that gets the whole
    // channel skipped. An output that landed where it was asked for needs no
    // sentence. (This used to cite §6.4 for the reasoning; §6.4 is the spatial
    // extent contract and says nothing of the kind. The argument stands on its
    // own, and a citation to a section that does not carry it is worth less
    // than none — it sends the next reader looking for an authority that is
    // not there.)
    const at = dir()
    const taken = path.join(at, "taken.shp")
    fs.writeFileSync(taken, "x")
    const known = algorithm(param("OUTPUT", "sink"))

    expect(
      QgisDestination.report(QgisDestination.reserve(known, { OUTPUT: path.join(at, "free.shp") })),
    ).toBeUndefined()

    const moved = QgisDestination.report(QgisDestination.reserve(known, { OUTPUT: taken }))
    // Where the data IS comes first — that is the one thing the caller has to
    // carry into its next step.
    expect(moved).toContain(`OUTPUT written to ${path.join(at, "taken (1).shp")}`)
    // Both paths, because an algorithm with several outputs needs to know WHICH
    // of the names it chose was the taken one.
    expect(moved).toContain(taken)
    // And that the earlier file survived, not merely that the path changed:
    // "already existed" on its own reads as though it was replaced.
    expect(moved).toContain("untouched")
  })

  test("a missing parent directory is created rather than refused", () => {
    // Upstream's write tool does the same, for the same reason (writeWithDirs):
    // a missing parent is a typo's worth of work and refusing it teaches
    // nothing.
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
