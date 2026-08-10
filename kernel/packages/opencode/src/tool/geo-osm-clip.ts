import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { GeoQgis, GeoRuntime } from "@/geo"
import type { GeoOsm } from "@/geo"

/* --- GeoCode: clipping a widened download back to its boundary
 * (docs/GEOKERNEL.md §6.4).
 *
 * A boundary too detailed or too fragmented to send is widened OUTWARD before
 * querying, because over-downloading can be corrected afterwards and
 * under-downloading cannot even be noticed. "Afterwards" used to mean the
 * caller doing it. This is that correction, done here.
 *
 * Three things decide its shape.
 *
 * **It lives in the tool layer, not the kernel.** GEOKERNEL §2.3's first rule
 * is that capability modules do not call each other — "QGIS 不调用 GDAL,GEE
 * 不调用 OSM" — and §6.1 states OSM starts no subprocess. Both would break if
 * the OSM module reached for the processing engine. The tool layer already
 * depends on both faces; that is its job.
 *
 * **It is optional, always.** OSM is the one capability module with no
 * environment (§6.2), and it does not acquire one here: a machine with no QGIS
 * configured downloads exactly as before. Every reason to give up — no
 * environment, no algorithm, a failed run, a result that looks wrong — lands
 * in the same place, which is the behaviour that existed before this file: the
 * data is a superset, and the report says so.
 *
 * **It never trusts the clip more than the download.** §6.4's asymmetry does
 * not stop applying because a second tool is involved. If clipping empties a
 * result that was not empty, that is far likelier to be a broken overlay than
 * a genuine answer, and the original file is kept. A superset that says it is
 * a superset beats a silently emptied file. --- */

/** Short-lived, ours to remove — the temporary root PATHS.md §3.1 sets aside. */
const SCRATCH = () => path.join(Global.Path.tmp, "osm-clip")

const CLIP = "native:clip"
const MERGE = "native:mergevectorlayers"

/**
 * The boundary files this call was asked about, or undefined when clipping
 * cannot apply.
 *
 * Every extent must be a boundary file. One `bbox:` or `area:` among them and
 * the answer holds features that are legitimately outside the files — clipping
 * to the files would delete them, turning a correction into data loss. Those
 * forms are never widened anyway (`extent.ts` marks only `file:` inexact), so
 * a mixed call has nothing to correct.
 */
export function boundaries(extents: readonly string[]): string[] | undefined {
  const files: string[] = []
  for (const extent of extents) {
    const trimmed = extent.trim()
    if (!trimmed.toLowerCase().startsWith("file:")) return undefined
    files.push(trimmed.slice("file:".length).trim())
  }
  return files.length > 0 ? files : undefined
}

function countFeatures(file: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"))
    return Array.isArray(parsed?.features) ? parsed.features.length : undefined
  } catch {
    return undefined
  }
}

export interface Outcome {
  /** True only when every output file was clipped and replaced. */
  readonly clipped: boolean
}

/**
 * The download as it stands after a correction that may or may not have run.
 *
 * One line, and the only place the two halves meet: a clip that succeeded
 * makes the result exact, which is what silences the superset warning further
 * down. Kept as a function so it can be shown to work — reached through a live
 * QGIS it could not be, and a join nobody tests is where the two halves drift
 * apart while each stays correct on its own.
 */
export function applied(raw: GeoOsm.DownloadResult, outcome: Outcome): GeoOsm.DownloadResult {
  return raw.exact || !outcome.clipped ? raw : { ...raw, exact: true }
}

/**
 * Clip each written file to the boundary, in place.
 *
 * "In place" is not a breach of §6.7's rule against overwriting: that rule
 * protects EARLIER runs, whose minutes are already spent. These files were
 * written by this call moments ago, and replacing one with its own clipped
 * form is finishing the job rather than destroying somebody else's.
 */
export function clip(input: {
  /* Handed in rather than reached for. A tool's `execute` resolves no services
   * — they are taken once when the tool is built — so this takes the faces it
   * needs as ordinary arguments and stays callable from anywhere, including a
   * test with three fakes and no kernel. */
  readonly qgis: GeoQgis.Interface
  readonly catalog: GeoQgis.QgisCatalog.Interface
  readonly runtime: GeoRuntime.Interface
  readonly result: GeoOsm.DownloadResult
  readonly extents: readonly string[]
  readonly abort?: AbortSignal
  /**
   * The way an algorithm is run, defaulted to the real one.
   *
   * A seam rather than a mock: the decision tree below has more refusals than
   * successes, and each has to be shown to leave the download untouched. The
   * same shape `OsmExtent.parse` uses for reading a boundary off disk.
   */
  readonly runAlgorithm?: typeof GeoQgis.QgisExecutor.runAlgorithm
}): Effect.Effect<Outcome> {
  return Effect.gen(function* () {
    const files = boundaries(input.extents)
    if (!files || input.result.outputs.length === 0) return { clipped: false }
    for (const file of files) if (!existsSync(file)) return { clipped: false }

    const gate = yield* input.qgis.gate()
    // No environment, no correction, no complaint. The download already
    // happened and is already usable (§6.2).
    if (!gate.ok) return { clipped: false }

    const catalog = input.catalog
    const runtime = input.runtime
    // Asked of the catalog rather than assumed. A hard-coded algorithm id that
    // a build does not carry is the drift TOOLS.md §8 records from the old
    // build — a name written in one place and resolved in another.
    if (!(yield* catalog.get(CLIP))) return { clipped: false }
    if (files.length > 1 && !(yield* catalog.get(MERGE))) return { clipped: false }

    const scratch = path.join(SCRATCH(), `${process.pid}-${input.result.outputs[0]!.count}`)
    const runAlgorithm = input.runAlgorithm ?? GeoQgis.QgisExecutor.runAlgorithm
    const run = (algorithm: string, parameters: Record<string, unknown>) =>
      runAlgorithm(runtime, gate.environment, {
        algorithm,
        parameters,
        abort: input.abort,
        onChunk: () => Effect.void,
      }).pipe(
        Effect.map((outcome) => outcome.reason === "exit" && outcome.code === 0),
        Effect.catch(() => Effect.succeed(false)),
      )

    return yield* Effect.gen(function* () {
      mkdirSync(scratch, { recursive: true })

      // One overlay for the whole call. Several boundary files describe one
      // study area in parts, and clipping against them one at a time would
      // keep only what lies in all of them at once — an intersection where a
      // union was meant.
      let overlay = files[0]!
      if (files.length > 1) {
        overlay = path.join(scratch, "boundary.geojson")
        if (!(yield* run(MERGE, { LAYERS: [...files], CRS: "EPSG:4326", OUTPUT: overlay }))) return { clipped: false }
        if (!existsSync(overlay)) return { clipped: false }
      }

      const replacements: { from: string; to: string }[] = []
      for (const [index, output] of input.result.outputs.entries()) {
        const target = path.join(scratch, `clipped-${index}.geojson`)
        if (!(yield* run(CLIP, { INPUT: output.path, OVERLAY: overlay, OUTPUT: target }))) return { clipped: false }
        if (!existsSync(target) || statSync(target).size === 0) return { clipped: false }

        // The one check that is not about the algorithm working, but about the
        // answer being credible. A clip that empties a non-empty file is far
        // likelier to be a bad overlay — a boundary of the wrong geometry type,
        // say — than a download that happened to land entirely in the margin.
        // Keeping the superset costs the caller a clipping step it was already
        // told about; trusting this would cost it the data.
        if (output.count > 0 && countFeatures(target) === 0) return { clipped: false }
        replacements.push({ from: target, to: output.path })
      }

      // Nothing is replaced until every file has a clipped form. A run that
      // gave up halfway would leave one family clipped and another not, which
      // is a state no report can describe.
      for (const { from, to } of replacements) renameSync(from, to)
      return { clipped: true }
    }).pipe(
      // Whatever happened — success, refusal, a defect from the filesystem —
      // the scratch directory goes. Nothing here is worth keeping and it is
      // ours, so nobody else will come and clear it.
      Effect.ensuring(Effect.sync(() => rmSync(scratch, { recursive: true, force: true }))),
      Effect.catch(() => Effect.succeed({ clipped: false })),
      Effect.catchDefect(() => Effect.succeed({ clipped: false })),
    )
  })
}

export * as OsmClip from "./geo-osm-clip"
