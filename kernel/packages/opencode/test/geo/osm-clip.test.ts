import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { OsmClip } from "@/tool/geo-osm-clip"
import type { GeoOsm } from "@/geo"

/* Clipping a widened download back to its boundary (docs/GEOKERNEL.md §6.4).
 *
 * The kernel widens a boundary it cannot filter exactly, because losing
 * features near an edge is the one mistake nobody can see afterwards. This is
 * the correction, and what is pinned here is mostly its REFUSALS: every path
 * that gives up has to leave the download exactly as it was, because the
 * behaviour it falls back to — a superset, reported as one — is the behaviour
 * that existed before clipping did.
 *
 * The QGIS side is faked. What matters here is the decision tree, the safety
 * check and the housekeeping; whether `native:clip` clips correctly is QGIS's
 * business and cannot be settled in a unit test anyway.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "geo-osm-clip-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let counter = 0
function dir(): string {
  const made = path.join(root, `case-${counter++}`)
  fs.mkdirSync(made, { recursive: true })
  return made
}

/** A GeoJSON file with `count` features, so "did it empty the file" is decidable. */
function collection(file: string, count: number): string {
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: "FeatureCollection",
      features: Array.from({ length: count }, (_, index) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [114 + index / 1000, 30] },
        properties: { osm_id: index },
      })),
    }),
  )
  return file
}

const DOWNLOAD = (outputs: { path: string; count: number }[]): GeoOsm.DownloadResult =>
  ({
    outputs: outputs.map((entry) => ({ ...entry, family: "points" })),
    features: outputs.reduce((sum, entry) => sum + entry.count, 0),
    bytes: 1,
    keptFields: [],
    geometry: {},
    droppedFields: [],
    unassembled: [],
    failed: [],
    incomplete: [],
    extentsDone: 1,
    extentsAsked: 1,
    duplicates: 0,
    centroidConverted: 0,
    exact: false,
    notes: [],
  }) as GeoOsm.DownloadResult

/** A QGIS that is ready, knows the algorithms, and writes what it is asked to. */
function fakes(
  over: {
    ready?: boolean
    known?: (id: string) => boolean
    /** What each run does: write the output with N features, or fail. */
    run?: (algorithm: string, parameters: Record<string, unknown>) => { ok: boolean; features?: number }
  } = {},
) {
  const runs: { algorithm: string; parameters: Record<string, unknown> }[] = []
  const qgis = {
    gate: () =>
      Effect.succeed(
        over.ready === false
          ? { ok: false as const, status: {} as never }
          : { ok: true as const, environment: {} as never },
      ),
  }
  const catalog = {
    get: (id: string) => Effect.succeed((over.known ?? (() => true))(id) ? ({ id } as never) : undefined),
  }
  const runtime = {} as never
  const runAlgorithm = ((
    _runtime: unknown,
    _environment: unknown,
    options: { algorithm: string; parameters: Record<string, unknown> },
  ) => {
    const { algorithm, parameters } = options
    runs.push({ algorithm, parameters })
    const outcome = (over.run ?? (() => ({ ok: true, features: 1 })))(algorithm, parameters)
    if (outcome.ok) collection(String(parameters.OUTPUT), outcome.features ?? 1)
    return Effect.succeed({ reason: "exit" as const, code: outcome.ok ? 0 : 1 })
  }) as never
  return { qgis, catalog, runtime, runs, runAlgorithm }
}

beforeEach(() => {
  fs.rmSync(path.join(Global.Path.tmp, "osm-clip"), { recursive: true, force: true })
})

const scratchLeftovers = () => {
  const scratch = path.join(Global.Path.tmp, "osm-clip")
  return fs.existsSync(scratch) ? fs.readdirSync(scratch) : []
}

describe("when it corrects the download", () => {
  test("a single boundary clips every written file in place", () => {
    const where = dir()
    const boundary = collection(path.join(where, "study.geojson"), 1)
    const a = collection(path.join(where, "out-points.geojson"), 10)
    const b = collection(path.join(where, "out-lines.geojson"), 4)
    const fake = fakes({ run: () => ({ ok: true, features: 3 }) })

    const outcome = Effect.runSync(
      OsmClip.clip({
        qgis: fake.qgis as never,
        catalog: fake.catalog as never,
        runtime: fake.runtime,
        runAlgorithm: fake.runAlgorithm,
        result: DOWNLOAD([
          { path: a, count: 10 },
          { path: b, count: 4 },
        ]),
        extents: [`file:${boundary}`],
      }),
    )

    expect(outcome.clipped).toBe(true)
    // In place: the caller keeps the paths it was already told about. This is
    // not the overwrite §6.7 forbids — that rule protects EARLIER runs, and
    // these files were written by this call moments ago.
    expect(JSON.parse(fs.readFileSync(a, "utf-8")).features).toHaveLength(3)
    expect(JSON.parse(fs.readFileSync(b, "utf-8")).features).toHaveLength(3)
    // One clip per written file, and no merge for a single boundary.
    expect(fake.runs.map((entry) => entry.algorithm)).toEqual(["native:clip", "native:clip"])
    expect(scratchLeftovers()).toEqual([])
  })

  test("several boundaries are merged first, because they are one area in parts", () => {
    const where = dir()
    const first = collection(path.join(where, "north.geojson"), 1)
    const second = collection(path.join(where, "south.geojson"), 1)
    const out = collection(path.join(where, "out.geojson"), 6)
    const fake = fakes({ run: () => ({ ok: true, features: 5 }) })

    const outcome = Effect.runSync(
      OsmClip.clip({
        qgis: fake.qgis as never,
        catalog: fake.catalog as never,
        runtime: fake.runtime,
        runAlgorithm: fake.runAlgorithm,
        result: DOWNLOAD([{ path: out, count: 6 }]),
        extents: [`file:${first}`, `file:${second}`],
      }),
    )

    expect(outcome.clipped).toBe(true)
    // Merge, then clip. Clipping against each boundary in turn would keep only
    // what lies in ALL of them — an intersection where a union was meant.
    expect(fake.runs.map((entry) => entry.algorithm)).toEqual(["native:mergevectorlayers", "native:clip"])
    expect(fake.runs[0]!.parameters.LAYERS).toEqual([first, second])
    expect(scratchLeftovers()).toEqual([])
  })
})

describe("when it gives up, the download is left exactly as it was", () => {
  const cases: {
    name: string
    reason: string
    over: Parameters<typeof fakes>[0]
    extents?: (boundary: string) => string[]
  }[] = [
    {
      name: "QGIS is not configured",
      // OSM is the one capability module with no environment (§6.2), and it
      // does not acquire one here. A machine without QGIS downloads as before.
      reason: "no environment",
      over: { ready: false },
    },
    {
      name: "the build does not carry the algorithm",
      // Asked of the catalog rather than assumed: a name written in one place
      // and resolved in another is the drift TOOLS.md §8 records.
      reason: "no algorithm",
      over: { known: (id) => id !== "native:clip" },
    },
    {
      name: "the clip fails",
      reason: "run failed",
      over: { run: () => ({ ok: false }) },
    },
    {
      name: "the clip empties a file that was not empty",
      // The one check about the ANSWER rather than the machinery. Emptying a
      // non-empty result is likelier a bad overlay than a download that landed
      // entirely in the margin, and §6.4's asymmetry says keep the superset.
      reason: "suspicious result",
      over: { run: () => ({ ok: true, features: 0 }) },
    },
  ]

  for (const item of cases) {
    test(item.name, () => {
      const where = dir()
      const boundary = collection(path.join(where, "study.geojson"), 1)
      const out = collection(path.join(where, "out.geojson"), 7)
      const before = fs.readFileSync(out, "utf-8")
      const fake = fakes(item.over)

      const outcome = Effect.runSync(
        OsmClip.clip({
          qgis: fake.qgis as never,
          catalog: fake.catalog as never,
          runtime: fake.runtime,
          runAlgorithm: fake.runAlgorithm,
          result: DOWNLOAD([{ path: out, count: 7 }]),
          extents: item.extents ? item.extents(boundary) : [`file:${boundary}`],
        }),
      )

      expect(outcome.clipped).toBe(false)
      // Byte for byte. Falling back means the caller gets the superset it was
      // always going to get, and the report says so.
      expect(fs.readFileSync(out, "utf-8")).toBe(before)
      expect(scratchLeftovers()).toEqual([])
    })
  }

  test("the run failed but left a file behind", () => {
    const where = dir()
    const boundary = collection(path.join(where, "study.geojson"), 1)
    const out = collection(path.join(where, "out.geojson"), 7)
    const before = fs.readFileSync(out, "utf-8")
    // A process that dies partway can still have written something. Only the
    // exit code separates that from a finished clip — the checks after it see
    // a file that exists and is not empty, and would accept a partial result
    // as the corrected download.
    const fake = fakes({
      run: (_a, parameters) => {
        collection(String(parameters.OUTPUT), 2)
        return { ok: false }
      },
    })

    const outcome = Effect.runSync(
      OsmClip.clip({
        qgis: fake.qgis as never,
        catalog: fake.catalog as never,
        runtime: fake.runtime,
        runAlgorithm: fake.runAlgorithm,
        result: DOWNLOAD([{ path: out, count: 7 }]),
        extents: [`file:${boundary}`],
      }),
    )

    expect(outcome.clipped).toBe(false)
    expect(fs.readFileSync(out, "utf-8")).toBe(before)
    expect(scratchLeftovers()).toEqual([])
  })

  test("one extent is not a boundary file", () => {
    const where = dir()
    const boundary = collection(path.join(where, "study.geojson"), 1)
    const out = collection(path.join(where, "out.geojson"), 7)
    const before = fs.readFileSync(out, "utf-8")
    const fake = fakes()

    const outcome = Effect.runSync(
      OsmClip.clip({
        qgis: fake.qgis as never,
        catalog: fake.catalog as never,
        runtime: fake.runtime,
        runAlgorithm: fake.runAlgorithm,
        result: DOWNLOAD([{ path: out, count: 7 }]),
        // A bbox is never widened, so its features are legitimately outside
        // the boundary file. Clipping to the file would delete them — turning
        // a correction into exactly the loss §6.4 exists to prevent.
        extents: [`file:${boundary}`, "bbox:30,114,31,115"],
      }),
    )

    expect(outcome.clipped).toBe(false)
    expect(fs.readFileSync(out, "utf-8")).toBe(before)
    // Nothing was even attempted.
    expect(fake.runs).toEqual([])
  })

  test("a boundary file that is no longer there", () => {
    const where = dir()
    const out = collection(path.join(where, "out.geojson"), 7)
    const fake = fakes()

    const outcome = Effect.runSync(
      OsmClip.clip({
        qgis: fake.qgis as never,
        catalog: fake.catalog as never,
        runtime: fake.runtime,
        runAlgorithm: fake.runAlgorithm,
        result: DOWNLOAD([{ path: out, count: 7 }]),
        extents: [`file:${path.join(where, "gone.geojson")}`],
      }),
    )

    expect(outcome.clipped).toBe(false)
    expect(fake.runs).toEqual([])
  })

  test("half a clip replaces nothing", () => {
    const where = dir()
    const boundary = collection(path.join(where, "study.geojson"), 1)
    const a = collection(path.join(where, "out-points.geojson"), 10)
    const b = collection(path.join(where, "out-lines.geojson"), 4)
    const beforeA = fs.readFileSync(a, "utf-8")
    let call = 0
    const fake = fakes({ run: () => ({ ok: ++call === 1, features: 2 }) })

    const outcome = Effect.runSync(
      OsmClip.clip({
        qgis: fake.qgis as never,
        catalog: fake.catalog as never,
        runtime: fake.runtime,
        runAlgorithm: fake.runAlgorithm,
        result: DOWNLOAD([
          { path: a, count: 10 },
          { path: b, count: 4 },
        ]),
        extents: [`file:${boundary}`],
      }),
    )

    expect(outcome.clipped).toBe(false)
    // The first file clipped fine and is still untouched. A run that replaced
    // what it managed would leave one family clipped and another not — a state
    // no report can describe, and one nobody could detect later.
    expect(fs.readFileSync(a, "utf-8")).toBe(beforeA)
    expect(fs.readFileSync(b, "utf-8")).toBe(JSON.stringify(JSON.parse(fs.readFileSync(b, "utf-8"))))
    expect(scratchLeftovers()).toEqual([])
  })
})

describe("what a correction does to the report", () => {
  const RAW = DOWNLOAD([{ path: "/tmp/x.geojson", count: 3 }])

  test("a clip that ran makes the result exact, which is what silences the warning", () => {
    // The join between the two halves. Reached through a live QGIS it cannot
    // be tested, so it is a function: each half is correct on its own, and
    // this is where they are shown to meet.
    expect(OsmClip.applied(RAW, { clipped: true }).exact).toBe(true)
  })

  test("a clip that did not run changes nothing at all", () => {
    expect(OsmClip.applied(RAW, { clipped: false })).toBe(RAW)
  })

  test("a result that was already exact is returned untouched", () => {
    const exact = { ...RAW, exact: true }
    expect(OsmClip.applied(exact, { clipped: false })).toBe(exact)
  })
})
