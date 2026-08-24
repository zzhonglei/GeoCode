export * as GeoOsm from "./index"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { OsmCentroid } from "./centroid"
import { OsmClient } from "./client"
import { OsmConvert } from "./convert"
import { OsmExtent } from "./extent"
import { OsmHttp } from "./http"
import { OsmIntersect } from "./intersect"
import { OsmOutput } from "./output"
import { OsmQuery } from "./query"
import { OsmSearch } from "./search"

export { OsmClient } from "./client"
export { OsmConvert } from "./convert"
export { OsmExtent } from "./extent"
export { OsmIntersect } from "./intersect"
export { OsmQuery } from "./query"
export { OsmSearch } from "./search"

/* --- GeoCode: the four OSM capabilities, as one workflow — find, count, then download (docs/GEOKERNEL.md §6.8).
 *
 * No status slot and no gate: nothing here has an environment to be ready, so each call solves its own reliability
 * and reports what degraded in its own result (§6.2). --- */

const MAX_EXTENTS = 12
/** Also what `tool/geo-osm-report.ts` caps a lost-id list at, since re-fetching that list is one call to here. */
export const MAX_IDS = 25
const TAG_STATS_SAMPLE_LIMIT = 10_000
/** Not tunable, and not small: the sample cap bounds what comes BACK, not the work the server does to find it. */
const RECON_TIMEOUT_SEC = 90

/**
 * How long the SERVER may spend on one extent, caller-controlled because only the caller knows the area.
 *
 * An over-budget query answers with a normal response carrying a remark, not with an error (§6.3 第四种失败), so
 * retrying it unchanged returns the same partial answer, and the floor keeps a caller from asking for one outright.
 */
const DEFAULT_TIMEOUT_SEC = 120
const MIN_TIMEOUT_SEC = 30

/** Our own budget, which has to outlast the server's or we give up on a live answer. */
function clientBudgetMs(timeoutSec: number): number {
  return (timeoutSec + 30) * 1000
}

function serverBudget(requested: number | undefined): number {
  return Math.max(MIN_TIMEOUT_SEC, Math.floor(requested ?? DEFAULT_TIMEOUT_SEC))
}

export interface SearchResult {
  readonly candidates: readonly OsmSearch.Candidate[]
  /**
   * Raw hits per engine, counted before the merge and before the ones with no usable identity were discarded —
   * zero from one beside a full list from the other is what makes half an answer visible (§6.8 任一单独使用都会漏).
   */
  readonly engines: { readonly geocoder: number; readonly features: number }
  /** What degraded, in the caller's words. Never fatal on its own. */
  readonly notes: readonly string[]
}

export interface Counts {
  readonly nodes: number
  readonly ways: number
  readonly relations: number
  readonly total: number
}

export interface Failure {
  readonly extent: string
  readonly reason: string
}

/**
 * An extent whose answer arrived complete-looking but is not, carrying the service's own words: they are the
 * difference between "raise the budget" and "this query is too broad to ask at all" (§6.3 第四种失败).
 */
export interface Incomplete {
  readonly extent: string
  readonly remark: string
}

export interface CountResult {
  readonly perExtent: readonly ({ readonly extent: string } & Counts)[]
  readonly totals: Counts
  readonly failed: readonly Failure[]
  readonly incomplete: readonly Incomplete[]
  /** False when an extent was widened: unlike a download, a count is never narrowed back, so it counts the hull. */
  readonly exact: boolean
}

export interface DistributionResult {
  readonly key: string
  readonly values: readonly { readonly value: string; readonly count: number }[]
  readonly distinct: number
  readonly sampled: number
  /** True when an extent hit the sample limit, so the distribution is partial. */
  readonly truncated: boolean
  readonly failed: readonly Failure[]
  readonly incomplete: readonly Incomplete[]
  /**
   * Not `asked - failed.length`: a cancelled run leaves the extents it never reached in neither list. `count`
   * reads it off `perExtent`; an aggregate answer has to carry it.
   */
  readonly answered: number
  /**
   * False when an extent was widened, and unlike a download this cannot be narrowed back afterwards: `out tags`
   * returns no geometry to retest against the real boundary, so the values found only in the hull stay (§6.4).
   */
  readonly exact: boolean
}

export interface DownloadResult {
  readonly outputs: readonly OsmOutput.Written[]
  readonly features: number
  /** Total bytes written, across every file this run produced. */
  readonly bytes: number
  /** The columns the policy would keep, which is not the same as the columns any feature turned out to carry. */
  readonly keptFields: readonly string[]
  readonly geometry: Record<string, number>
  readonly droppedFields: readonly string[]
  /** Elements that matched but produced no geometry, named rather than counted: the fix is to fetch them alone. */
  readonly unassembled: readonly string[]
  readonly failed: readonly Failure[]
  readonly incomplete: readonly Incomplete[]
  /** Objects rather than extents when the result came from `downloadObjects`, which reuses these two fields. */
  readonly extentsDone: number
  readonly extentsAsked: number
  /** The same object arriving from more than one extent, removed — i.e. how much they overlapped. */
  readonly duplicates: number
  /** Features collapsed from an area or line to a point, in centroid mode. */
  readonly centroidConverted: number
  /**
   * False only on a call MIXING boundary files with other extent kinds: with every boundary in hand the download
   * narrows itself back (`intersect.ts`), while an `area:` among them makes narrowing wrong, since the features
   * that extent legitimately holds outside the files would be the ones deleted (§6.4).
   */
  readonly exact: boolean
  /** Empty whenever `exact`. Named, because asking for that one boundary on its own is the route back to exact. */
  readonly widened: readonly string[]
  readonly notes: readonly string[]
}

/**
 * Runs even when extents failed — partial results beat discarding everything on a multi-area download (§6.7) — and
 * as a FAILURE rather than a defect: `OsmOutput.write` throws on a full disk or an unwritable path, and a throw
 * inside `Effect.gen` lands outside the error type every caller of this module handles.
 */
function writeIfAny(
  output: string,
  features: readonly OsmConvert.Feature[],
  notes: string[],
): Effect.Effect<{ outputs: readonly OsmOutput.Written[]; bytes: number }, Error> {
  return checked(() => {
    if (features.length === 0) {
      notes.push("nothing was obtained, so no file was written")
      return { outputs: [], bytes: 0 }
    }
    return OsmOutput.write(output, features)
  })
}

/**
 * The query builders refuse malformed input by throwing, which is right for pure functions and a defect inside
 * `Effect.gen` — a mistyped type list would crash the caller rather than come back as the sentence naming the fix.
 */
function checked<A>(thunk: () => A): Effect.Effect<A, Error> {
  return Effect.try({
    try: thunk,
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

function keptFieldsOf(policy: OsmConvert.FieldPolicy): string[] {
  return [
    ...OsmConvert.CORE_FIELDS,
    ...[...policy.keep].sort(),
    ...(policy.keepAll ? ["osm_tags (all tags, lossless)"] : []),
  ]
}

/**
 * Called as a download settles each unit it can count — an extent, or an object. `settled` is not `extentsDone`:
 * it counts failures too, so a run whose extents are all timing out does not sit at 0 of 5 while working (§6.2).
 */
export type OnProgress = (settled: number, total: number) => Effect.Effect<void>

export interface Interface {
  readonly search: (input: {
    readonly query: string
    readonly context?: string
    readonly category?: string
    readonly abort?: AbortSignal
  }) => Effect.Effect<SearchResult>
  readonly count: (input: {
    readonly extents: readonly string[]
    readonly tags: readonly string[]
    readonly types?: string
    /** Server-side seconds per extent. Raise it for dense areas (§6.3). */
    readonly timeoutSec?: number
    readonly abort?: AbortSignal
  }) => Effect.Effect<CountResult, Error>
  readonly distribution: (input: {
    readonly extents: readonly string[]
    readonly key: string
    readonly types?: string
    readonly abort?: AbortSignal
  }) => Effect.Effect<DistributionResult, Error>
  readonly downloadObjects: (input: {
    readonly ids: readonly string[]
    readonly output: string
    readonly fields?: readonly string[]
    readonly abort?: AbortSignal
    readonly onProgress?: OnProgress
  }) => Effect.Effect<DownloadResult, Error>
  readonly downloadFeatures: (input: {
    readonly extents: readonly string[]
    readonly tags: readonly string[]
    readonly output: string
    readonly types?: string
    readonly fields?: readonly string[]
    /** "original" keeps geometry as mapped; "centroid" collapses to points. */
    readonly geometry?: "original" | "centroid"
    /** Server-side seconds per extent. Raise it for dense areas (§6.3). */
    readonly timeoutSec?: number
    readonly abort?: AbortSignal
    readonly onProgress?: OnProgress
  }) => Effect.Effect<DownloadResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@geocode/GeoOsm") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const client = yield* OsmClient.Service

    const resolveExtents = (specs: readonly string[]) => {
      const resolved: { spec: string; extent: OsmExtent.Resolved }[] = []
      const failed: { extent: string; reason: string }[] = []
      for (const spec of specs) {
        try {
          resolved.push({ spec, extent: OsmExtent.parse(spec) })
        } catch (error) {
          failed.push({ extent: spec, reason: error instanceof Error ? error.message : String(error) })
        }
      }
      return { resolved, failed }
    }

    const search: Interface["search"] = (input) =>
      Effect.gen(function* () {
        const notes: string[] = []
        const candidates = new Map<string, OsmSearch.Candidate>()

        // Both at once: `client.ts` keeps a separate throttle clock per service, so a search costs the slower of
        // the two rather than their sum. Neither may fail the call — their recall sets barely overlap (§6.8).
        const [geocoded, literal] = yield* Effect.all(
          [
            Effect.result(
              client.nominatim(input.context ? `${input.query}, ${input.context}` : input.query, {
                abort: input.abort,
              }),
            ),
            Effect.result(
              client.overpass(OsmQuery.nameSearch({ query: input.query, category: input.category, timeoutSec: 60 }), {
                abort: input.abort,
                timeoutMs: 90_000,
              }),
            ),
          ],
          { concurrency: 2 },
        )

        let hits: OsmSearch.GeocoderHit[] = []
        if (geocoded._tag === "Success") {
          hits = (geocoded.success as OsmSearch.GeocoderHit[]) ?? []
          for (const hit of hits) {
            const candidate = OsmSearch.fromGeocoder(hit)
            if (candidate) OsmSearch.upsert(candidates, candidate)
          }
        } else {
          notes.push(
            `the geocoder did not answer (${geocoded.failure.message}); these results are literal matches only`,
          )
        }

        let elements: any[] = []
        if (literal._tag === "Success") {
          if (literal.success.remark) notes.push(`the feature service reported: ${literal.success.remark}`)
          elements = (literal.success.json as any).elements ?? []
        } else if (input.category) {
          // A category-constrained global name search can exhaust the server's own budget, so the retry drops the
          // constraint — and filters on the KEY alone, so a `category` of `k=v` comes back wider (§6.8 降级路径).
          const retry = yield* Effect.result(
            client.overpass(OsmQuery.nameSearch({ query: input.query, timeoutSec: 60 }), {
              abort: input.abort,
              timeoutMs: 90_000,
            }),
          )
          if (retry._tag === "Success") {
            const key = OsmQuery.tagKey(input.category)
            elements = ((retry.success.json as any).elements ?? []).filter(
              (element: any) => element.tags?.[key] !== undefined,
            )
            notes.push("the category-filtered search failed; ran it unfiltered and applied the category here")
          } else {
            notes.push(`the feature service did not answer (${retry.failure.message}); these results are geocoded only`)
          }
        } else {
          notes.push(`the feature service did not answer (${literal.failure.message}); these results are geocoded only`)
        }
        for (const element of elements) {
          if (element.tags) OsmSearch.upsert(candidates, OsmSearch.fromElement(element, "features"))
        }

        const sites = elements.filter((element) => element.type === "relation" && element.tags?.type === "site")
        if (sites.length > 0) {
          const expansion = yield* Effect.result(
            client.overpass(OsmQuery.siteExpansion({ query: input.query, timeoutSec: 30 }), {
              abort: input.abort,
              timeoutMs: 60_000,
            }),
          )
          if (expansion._tag === "Success") {
            // The expansion does not say which parent each member came from, so attribution needs a single one.
            const parent = sites.length === 1 ? OsmQuery.formatRef(sites[0]) : undefined
            for (const element of (expansion.success.json as any).elements ?? []) {
              if (element.tags) OsmSearch.upsert(candidates, OsmSearch.fromElement(element, "site", parent))
            }
          } else {
            notes.push("the site-relation expansion failed; member objects may be missing")
          }
        }

        // Nothing area-like came back, so the geocoder's canonical name is tried as a better literal query (§6.8).
        if (!OsmSearch.hasArea(candidates.values()) && hits.length > 0) {
          const names = [...new Set(hits.map(OsmSearch.canonicalName).filter((n): n is string => !!n))].slice(0, 3)
          if (names.length > 0) {
            const pattern = names.map(OsmQuery.escapeRegex).join("|")
            const recovery = yield* Effect.result(
              client.overpass(
                OsmQuery.nameSearch({
                  query: pattern,
                  rawRegex: true,
                  timeoutSec: 45,
                  caps: { relation: 10, way: 10, node: 5 },
                }),
                { abort: input.abort, timeoutMs: 75_000 },
              ),
            )
            if (recovery._tag === "Success") {
              for (const element of (recovery.success.json as any).elements ?? []) {
                if (element.tags) OsmSearch.upsert(candidates, OsmSearch.fromElement(element, "canonical"))
              }
              notes.push(`recovered area candidates through the canonical name: ${names.join(" / ")}`)
            }
            // Best effort throughout: a failed recovery changes nothing.
          }
        }

        return {
          candidates: OsmSearch.rank(candidates.values()),
          engines: { geocoder: hits.length, features: elements.length },
          notes,
        }
      })

    const count: Interface["count"] = (input) =>
      Effect.gen(function* () {
        if (input.extents.length > MAX_EXTENTS) {
          return yield* Effect.fail(
            new Error(`${input.extents.length} extents is more than the ${MAX_EXTENTS} allowed in one call`),
          )
        }
        const types = yield* checked(() => {
          input.tags.forEach(OsmQuery.tagClause)
          return OsmQuery.normalizeTypes(input.types)
        })
        const { resolved, failed } = resolveExtents(input.extents)
        const budget = serverBudget(input.timeoutSec)
        const perExtent: ({ extent: string } & Counts)[] = []
        const incomplete: Incomplete[] = []
        let exact = true

        for (const { spec, extent } of resolved) {
          if (input.abort?.aborted) break
          if (!extent.exact) exact = false
          const outcome = yield* Effect.result(
            client.overpass(OsmQuery.count({ spatial: extent.spatial, tags: input.tags, types, timeoutSec: budget }), {
              abort: input.abort,
              timeoutMs: clientBudgetMs(budget),
            }),
          )
          if (outcome._tag === "Failure") {
            failed.push({ extent: spec, reason: outcome.failure.message })
            continue
          }
          if (outcome.success.remark) incomplete.push({ extent: spec, remark: outcome.success.remark })
          const tags = ((outcome.success.json as any).elements ?? [])[0]?.tags ?? {}
          perExtent.push({
            extent: spec,
            nodes: Number(tags.nodes ?? 0),
            ways: Number(tags.ways ?? 0),
            relations: Number(tags.relations ?? 0),
            total: Number(tags.total ?? 0),
          })
        }

        const totals: Counts = {
          nodes: perExtent.reduce((sum, entry) => sum + entry.nodes, 0),
          ways: perExtent.reduce((sum, entry) => sum + entry.ways, 0),
          relations: perExtent.reduce((sum, entry) => sum + entry.relations, 0),
          total: perExtent.reduce((sum, entry) => sum + entry.total, 0),
        }
        return { perExtent, totals, failed, incomplete, exact }
      })

    const distribution: Interface["distribution"] = (input) =>
      Effect.gen(function* () {
        if (input.extents.length > MAX_EXTENTS) {
          return yield* Effect.fail(
            new Error(`${input.extents.length} extents is more than the ${MAX_EXTENTS} allowed in one call`),
          )
        }
        const types = yield* checked(() => {
          OsmQuery.tagClause(input.key)
          return OsmQuery.normalizeTypes(input.types)
        })
        const { resolved, failed } = resolveExtents(input.extents)
        const counts = new Map<string, number>()
        const incomplete: Incomplete[] = []
        let sampled = 0
        let truncated = false
        let exact = true
        let answered = 0

        for (const { spec, extent } of resolved) {
          if (input.abort?.aborted) break
          // Before the request, as `count` does: a widened extent taints the distribution whether or not it answers.
          if (!extent.exact) exact = false
          const outcome = yield* Effect.result(
            client.overpass(
              OsmQuery.tagStats({
                spatial: extent.spatial,
                key: input.key,
                types,
                timeoutSec: RECON_TIMEOUT_SEC,
                sampleLimit: TAG_STATS_SAMPLE_LIMIT,
              }),
              { abort: input.abort, timeoutMs: clientBudgetMs(RECON_TIMEOUT_SEC) },
            ),
          )
          if (outcome._tag === "Failure") {
            failed.push({ extent: spec, reason: outcome.failure.message })
            continue
          }
          answered += 1
          if (outcome.success.remark) incomplete.push({ extent: spec, remark: outcome.success.remark })
          const elements: any[] = (outcome.success.json as any).elements ?? []
          // The cap is applied per query, so truncation is per-extent: against the summed `sampled` below, three
          // complete answers of four thousand would read as one partial answer.
          if (elements.length >= TAG_STATS_SAMPLE_LIMIT) truncated = true
          for (const element of elements) {
            const value = element.tags?.[input.key]
            if (typeof value !== "string") continue
            counts.set(value, (counts.get(value) ?? 0) + 1)
            sampled += 1
          }
        }

        return {
          key: input.key,
          values: [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count),
          distinct: counts.size,
          sampled,
          truncated,
          failed,
          incomplete,
          answered,
          exact,
        }
      })

    const downloadObjects: Interface["downloadObjects"] = (input) =>
      Effect.gen(function* () {
        if (input.ids.length > MAX_IDS) {
          return yield* Effect.fail(
            new Error(
              `${input.ids.length} ids is more than the ${MAX_IDS} allowed in one call; ` +
                `for a set this size use an extent and a tag filter instead`,
            ),
          )
        }
        const refs: OsmQuery.OsmRef[] = []
        const failed: Failure[] = []
        for (const id of input.ids) {
          try {
            refs.push(OsmQuery.parseRef(id))
          } catch (error) {
            failed.push({ extent: id, reason: error instanceof Error ? error.message : String(error) })
          }
        }
        if (refs.length === 0) return yield* Effect.fail(new Error("no usable OSM ids were given"))

        const policy = OsmConvert.fieldPolicy([], input.fields)
        const notes: string[] = []
        const incomplete: Incomplete[] = []
        const features: OsmConvert.Feature[] = []
        const unassembled: string[] = []
        const droppedFields = new Map<string, number>()
        let missing = [...refs]

        // One batched query with geometry inlined. The per-object loop below is the fallback and stitches across
        // sibling elements, the form that goes partial on large relations — so its output is checked below (§6.6).
        const batched = yield* Effect.result(
          client.overpass(OsmQuery.objects({ refs, timeoutSec: 120 }), { abort: input.abort, timeoutMs: 150_000 }),
        )
        if (batched._tag === "Success") {
          // A batch of large boundaries is exactly the query that exhausts the server's budget, and the objects it
          // then drops fall through to the fallback — whose troubles must not read as a problem with the objects.
          if (batched.success.remark) {
            incomplete.push({ extent: "the batched fetch", remark: batched.success.remark })
          }
          const converted = OsmConvert.convertElements(batched.success.json, policy)
          unassembled.push(...converted.unassembled)
          for (const [key, value] of converted.droppedFields)
            droppedFields.set(key, (droppedFields.get(key) ?? 0) + value)
          missing = missing.filter((ref) => {
            const found = OsmConvert.pick(converted.features, ref)
            if (!found) return true
            features.push(found)
            return false
          })
        } else {
          notes.push(`the batched fetch failed (${batched.failure.message}); falling back to one request per object`)
        }

        // Progress opens at whatever the batch already settled, over what the caller asked for — ids that never
        // parsed included, so the denominator here and `extentsAsked` below stay the same number.
        const settleable = input.ids.length
        let settled = settleable - missing.length
        if (input.onProgress) yield* input.onProgress(settled, settleable)

        for (const ref of [...missing]) {
          // Stop rather than let every remaining object add its own "cancelled" entry — a failure list that long
          // reads as a service problem instead of a user pressing stop.
          if (input.abort?.aborted) break
          const single = yield* Effect.result(client.osmApi(ref.type, ref.id, { abort: input.abort }))
          // Before the four branches below, every one of which leaves this object settled.
          settled += 1
          if (input.onProgress) yield* input.onProgress(settled, settleable)
          if (single._tag === "Failure") {
            failed.push({ extent: OsmQuery.formatRef(ref), reason: single.failure.message })
            continue
          }
          const converted = OsmConvert.convertBatch(single.success, policy)
          for (const [key, value] of converted.droppedFields)
            droppedFields.set(key, (droppedFields.get(key) ?? 0) + value)
          const found = OsmConvert.pick(converted.features, ref)
          if (!found) {
            failed.push({ extent: OsmQuery.formatRef(ref), reason: "no geometry after conversion" })
            continue
          }
          const nodes = ((single.success as any).elements ?? []).filter(
            (element: any) => element.type === "node",
          ).length
          if (ref.type === "relation" && !OsmConvert.assemblyLooksComplete(found.geometry, nodes)) {
            failed.push({
              extent: OsmQuery.formatRef(ref),
              reason: `only ${OsmConvert.countVertices(found.geometry)} of about ${nodes} vertices were stitched; refusing to hand over a partial boundary`,
            })
            continue
          }
          features.push(found)
        }

        const deduped = OsmConvert.dedupe(features)
        const written = yield* writeIfAny(input.output, deduped, notes)
        return {
          outputs: written.outputs,
          features: deduped.length,
          bytes: written.bytes,
          keptFields: keptFieldsOf(policy),
          geometry: OsmConvert.geometrySummary(deduped),
          droppedFields: OsmConvert.formatDroppedFields(droppedFields),
          unassembled,
          failed,
          incomplete,
          extentsDone: deduped.length,
          extentsAsked: input.ids.length,
          duplicates: features.length - deduped.length,
          centroidConverted: 0,
          // Fetch-by-id has no extent to widen: every object asked for is named.
          exact: true,
          widened: [],
          notes,
        }
      })

    const downloadFeatures: Interface["downloadFeatures"] = (input) =>
      Effect.gen(function* () {
        if (input.extents.length > MAX_EXTENTS) {
          return yield* Effect.fail(
            new Error(`${input.extents.length} extents is more than the ${MAX_EXTENTS} allowed in one call`),
          )
        }
        const types = yield* checked(() => {
          input.tags.forEach(OsmQuery.tagClause)
          return OsmQuery.normalizeTypes(input.types)
        })
        const { resolved, failed } = resolveExtents(input.extents)
        const policy = OsmConvert.fieldPolicy(input.tags, input.fields)
        const budget = serverBudget(input.timeoutSec)
        const notes: string[] = []
        const incomplete: Incomplete[] = []
        const collected: OsmConvert.Feature[] = []
        const unassembled: string[] = []
        const widened: string[] = []
        const droppedFields = new Map<string, number>()
        let exact = true
        let done = 0
        // Seeded from the extents that never parsed, and announced before the first request: a one-extent download
        // would otherwise report nothing at all until it was already over.
        let settled = failed.length
        if (input.onProgress) yield* input.onProgress(settled, input.extents.length)

        for (const { spec, extent } of resolved) {
          if (input.abort?.aborted) break
          if (!extent.exact) {
            exact = false
            // `extent.ts` already words this: "boundary file X (3 polygons, reduced to convex hulls)".
            widened.push(extent.label)
          }
          const outcome = yield* Effect.result(
            client.overpass(
              OsmQuery.download({ spatial: extent.spatial, tags: input.tags, types, timeoutSec: budget }),
              { abort: input.abort, timeoutMs: clientBudgetMs(budget) },
            ),
          )
          // Before the `continue` below: an extent that failed is one nobody waits on, and skipping it here would
          // stall the count on exactly the runs that take longest.
          settled += 1
          if (input.onProgress) yield* input.onProgress(settled, input.extents.length)
          if (outcome._tag === "Failure") {
            failed.push({ extent: spec, reason: outcome.failure.message })
            continue
          }
          done += 1
          if (outcome.success.remark) incomplete.push({ extent: spec, remark: outcome.success.remark })
          const converted = OsmConvert.convertElements(outcome.success.json, policy)
          collected.push(...converted.features)
          unassembled.push(...converted.unassembled)
          for (const [key, value] of converted.droppedFields)
            droppedFields.set(key, (droppedFields.get(key) ?? 0) + value)
        }

        let features = OsmConvert.dedupe(collected)
        const duplicates = collected.length - features.length

        /* The boundary test the server could not run, run here (§6.4). Before the centroid collapse, and not
         * cosmetically: a road crossing the city line is judged by its whole geometry here, where judged by the
         * point it is about to become it would take its inside half with it. All extents or none — one `area:`
         * among them and the answer legitimately holds features outside every boundary we hold — and the filter
         * is their UNION, since an exact extent left out of it loses its features to its neighbours' boundaries.
         */
        const boundaries = resolved.map(({ extent }) => extent.boundary)
        if (!exact && boundaries.every((boundary) => boundary !== undefined)) {
          const idx = OsmIntersect.index(boundaries.flatMap((boundary) => boundary!))
          features = features.filter((feature) => OsmIntersect.intersects(feature.geometry, idx))
          exact = true
        }

        let centroidConverted = 0
        if (input.geometry === "centroid") {
          const normalized = OsmCentroid.normalize(features)
          unassembled.push(...normalized.dropped)
          features = normalized.features
          // How many were areas or lines before this — i.e. how much of the answer asking for `node` alone would
          // have missed (§6.8 几何归一化).
          centroidConverted = features.filter((feature) => feature.properties.original_geometry).length
        }

        const written = yield* writeIfAny(input.output, features, notes)
        return {
          outputs: written.outputs,
          features: features.length,
          bytes: written.bytes,
          keptFields: keptFieldsOf(policy),
          geometry: OsmConvert.geometrySummary(features),
          droppedFields: OsmConvert.formatDroppedFields(droppedFields),
          unassembled,
          failed,
          incomplete,
          extentsDone: done,
          extentsAsked: input.extents.length,
          duplicates,
          centroidConverted,
          exact,
          // Cleared when the narrowing ran: the query was widened, the result is not.
          widened: exact ? [] : widened,
          notes,
        }
      })

    return Service.of({ search, count, distribution, downloadObjects, downloadFeatures })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [OsmClient.node, OsmHttp.node] })
