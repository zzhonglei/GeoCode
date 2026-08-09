import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { GeoOsm } from "@/geo"
import { OsmReport } from "./geo-osm-report"
import DESCRIPTION from "./geo-osm-features.txt"

/* --- GeoCode: OsmGetFeatures, the bulk download (docs/TOOLS.md §3,
 * GEOKERNEL §6.4, §6.7, §6.8).
 *
 * The last of the four, and the one whose answer is hardest to check. The
 * others hand back something the caller can look at: a list of candidates, a
 * number, a handful of named objects. This one hands back a file of features
 * nobody asked for individually — and a file of the wrong features looks
 * exactly like a file of the right ones.
 *
 * So the report is where the checking has to happen, and two of its lines are
 * not commentary but data contracts.
 *
 * **The superset.** A boundary too detailed to send is widened outward, and
 * the download then contains features from outside it. That is deliberate:
 * over-downloading can be clipped afterwards, under-downloading cannot even be
 * noticed (§6.4). But the caller who is not told will treat the extra features
 * as findings. So it is said plainly, and left as a fact — no algorithm is
 * named, because the agent reading this cannot run one.
 *
 * **The centroid.** Collapsing areas to points is not a convenience. Asking
 * for point ELEMENTS instead is the mistake it prevents: most facilities are
 * mapped as areas, so a point-only query silently returns the minority and
 * looks like a complete POI set (§6.8). --- */

export const Parameters = Schema.Struct({
  extents: Schema.Array(Schema.String).annotate({
    description:
      'One or more extents: "area:R<id>" (relations only), "bbox:S,W,N,E", "around:radius_m,lat,lon", "file:/abs/path.geojson" (EPSG:4326). At most 12 per call; results are merged and cross-extent duplicates removed.',
  }),
  tags: Schema.Array(Schema.String).annotate({
    description:
      'A tag union, e.g. ["amenity=hospital", "amenity=clinic", "healthcare"]. Formats: "key=value", "key" (presence), "key~regex".',
  }),
  output: Schema.String.annotate({
    description:
      "Absolute path for the result. A path not ending in .geojson gets it appended, and the report names the file(s) actually written.",
  }),
  types: Schema.optional(Schema.String).annotate({
    description:
      'Element types: "nwr" (default, all), or a comma list. "way,relation" gives area features only. For a POI dataset do NOT use "node" — area-mapped facilities would be dropped; keep "nwr" and use geometry "centroid".',
  }),
  geometry: Schema.optional(Schema.Literals(["original", "centroid"])).annotate({
    description:
      '"original" (default) keeps geometry as mapped. "centroid" collapses every feature to one representative point, recording its original type in an "original_geometry" column.',
  }),
  fields: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      'Extra tag keys to keep as columns. By default the core identity columns plus the queried tag keys survive; other tags are dropped and reported by key. Pass ["*"] to keep all tags losslessly in an "osm_tags" column.',
  }),
  timeout: Schema.optional(Schema.Int).annotate({
    description:
      "Seconds the server may spend on each extent (default 120; anything lower is raised to 30). Raising it is the fix for an extent that comes back marked incomplete.",
  }),
})

/**
 * `truncated: false` — §5.2's first strategy.
 *
 * The features go to disk; what comes back is a handful of paths, a geometry
 * tally, a field list and the names of what was lost. Its size follows the
 * number of extents (capped at twelve) and the number of dropped tag keys, not
 * the number of features.
 *
 * Failures are `error_code`, never `error: true`: that flag means an
 * environment is not ready, and this group has no environment (§6.2).
 */
type Metadata = {
  [key: string]: unknown
  truncated: boolean
}

export const OsmGetFeaturesTool = Tool.define<typeof Parameters, Metadata, GeoOsm.Service>(
  "OsmGetFeatures",
  Effect.gen(function* () {
    const osm = yield* GeoOsm.Service

    const run = Effect.fn("OsmGetFeaturesTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const title = params.output
      const refuse = (message: string) => ({
        title,
        output: message,
        metadata: { truncated: false, error_code: "InvalidParameters", failed: true } as Metadata,
      })

      // Both refused rather than answered, because the kernel answers them: it
      // checks an upper bound on extents and nothing else, so an empty list
      // loops zero times and comes back with zero features — which is exactly
      // what an area holding none of this category looks like.
      if (params.extents.length === 0) {
        return refuse('"extents" is empty — name at least one area to download from.')
      }
      if (params.tags.length === 0) {
        return refuse('"tags" is empty — name at least one tag filter, e.g. ["amenity=hospital"].')
      }

      // Before the call, because the call is what writes: the kernel creates
      // directories and files inside `downloadFeatures`, and a "file:" extent
      // reads a boundary off disk on the way there.
      yield* ctx.ask({
        permission: "geo_osm_features",
        patterns: [params.output],
        always: ["*"],
        metadata: { extents: params.extents, tags: params.tags, output: params.output },
      })

      const outcome = yield* Effect.result(
        osm.downloadFeatures({
          extents: params.extents,
          tags: params.tags,
          output: params.output,
          types: params.types,
          fields: params.fields,
          geometry: params.geometry,
          timeoutSec: params.timeout,
          abort: ctx.abort,
        }),
      )
      // Whole-call mistakes only — more extents than one call takes, a tag or
      // type list the builder cannot parse. Per-extent trouble never arrives
      // here; it arrives as `failed`, beside a file holding everything else.
      if (outcome._tag === "Failure") return refuse(outcome.failure.message)
      const result = outcome.success

      const lines = OsmReport.caveats(result, {
        lostNoun: "element",
        cancelled: ctx.abort.aborted
          ? "cancelled — extents not reached before it stopped were neither downloaded nor listed above."
          : undefined,
      })
      if (lines.length > 0) lines.push("")

      const asked = result.extentsAsked
      if (result.outputs.length === 0) {
        // That no file exists is the kernel's note, printed above. This line
        // carries what that note cannot, and the two cases it separates ask for
        // opposite responses: a service that never answered is retried, a
        // service that answered with nothing means the tags are wrong for this
        // area. Saying "nothing was obtained" for both would send every empty
        // result to the same wrong conclusion.
        lines.push(
          result.extentsDone === asked
            ? `All ${asked} extent(s) answered, and nothing in them matched these tags.`
            : `No features were obtained: ${result.extentsDone} of ${asked} extent(s) answered at all.`,
        )
        return {
          title,
          output: lines.join("\n"),
          metadata: {
            truncated: false,
            error_code: "NothingObtained",
            failed: true,
            features: 0,
            extents_asked: asked,
            extents_failed: result.failed.length,
          } as Metadata,
        }
      }

      lines.push(...OsmReport.files(result, `${result.features} feature(s)`), ...OsmReport.fields(result))
      // The extent tally sits with the facts rather than the caveats: on a
      // download deliberately split into sub-areas it is an ordinary progress
      // figure, and the ones that did NOT finish are already named above.
      //
      // Only when there is more than one. On a single extent it restates the
      // line above it, and a figure that never varies stops being read.
      if (asked > 1) {
        lines.push(
          `Extents: ${result.extentsDone} of ${asked} completed` +
            (result.duplicates > 0 ? `; ${result.duplicates} cross-extent duplicate(s) removed.` : "."),
        )
      }
      if (result.centroidConverted > 0) {
        // The number that shows what a point-only query would have missed —
        // often most of the answer (§6.8).
        lines.push(
          `Centroid mode: ${result.centroidConverted} area or line feature(s) collapsed to a representative point` +
            ' (their original type is in "original_geometry").',
        )
      }

      const partial = result.extentsDone < asked || result.unassembled.length > 0 || result.failed.length > 0
      return {
        title,
        output: lines.join("\n"),
        metadata: {
          truncated: false,
          features: result.features,
          extents_done: result.extentsDone,
          extents_asked: asked,
          extents_failed: result.failed.length,
          bytes: result.bytes,
          geometry: result.geometry,
          outputs: result.outputs,
          kept_fields: result.keptFields,
          dropped_fields: result.droppedFields,
          unassembled: result.unassembled,
          duplicates: result.duplicates,
          centroid_converted: result.centroidConverted,
          // False means the file is a superset of what was asked for and needs
          // clipping. The frontend branches on it; the prose above says it too.
          exact: result.exact,
          ...(partial ? { partial: true } : {}),
        } as Metadata,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
