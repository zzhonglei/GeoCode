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

/* --- GeoCode: the four OSM capabilities (docs/GEOKERNEL.md §6.8).
 *
 * They form one workflow — find, then count, then download — and the counting
 * step is why it is a workflow rather than a list: public services answer an
 * oversized query with a timeout or a truncation, not with an error, so
 * knowing the size beforehand is the difference between a download and a
 * mystery.
 *
 * No status slot and no gate: this module has no environment to be ready
 * (§6.2). Every call solves its own reliability, and failures come back in the
 * result rather than lighting an indicator nobody can act on. --- */

/** Extents accepted in one call, so a single mistake cannot become a flood. */
const MAX_EXTENTS = 12
/**
 * Objects accepted in one call.
 *
 * Past this the batched query stops being the right shape and an extent plus a
 * tag filter is — a hundred ids is a category download written the long way.
 */
export const MAX_IDS = 25
const TAG_STATS_SAMPLE_LIMIT = 10_000
/**
 * The server's budget for a reconnaissance query.
 *
 * Scanning for a key's values is not cheaper than counting: the sample cap
 * bounds what comes BACK, not what the server has to walk to find it. A dense
 * area answers a `building` distribution with the same work as a count, so the
 * budget matches the one counting gets rather than undercutting it — a short
 * budget here buys a partial vocabulary, which reads as a complete one.
 */
const RECON_TIMEOUT_SEC = 90

/**
 * How long the SERVER may spend on one extent, in seconds.
 *
 * Caller-controlled because only the caller knows the area: a dense city block
 * with a broad tag union needs minutes where a village needs seconds, and the
 * service's own answer to running over budget is a soft failure — a normal
 * response carrying a note that the result is incomplete (§6.3 第四种失败).
 * Raising this is the fix for that note; nothing else is.
 *
 * The floor exists because a value below it turns ordinary queries into
 * incomplete ones, which reads as "there is no data here".
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
   * What each engine returned before the merge.
   *
   * Not derivable from the candidates: raw hits include the ones that carried
   * no usable identity, and the merge collapses the two sets. Zero from one
   * engine beside a full list from the other is what makes "half an answer"
   * visible as such (§6.8 任一单独使用都会漏).
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
 * An extent whose answer arrived complete-looking but is not.
 *
 * Carries the service's own words, because they are the difference between
 * "raise the budget" and "this query is too broad to ask at all" — and nothing
 * downstream can tell those apart from the extent name alone (§6.3 第四种失败).
 */
export interface Incomplete {
  readonly extent: string
  readonly remark: string
}

export interface CountResult {
  readonly perExtent: readonly ({ readonly extent: string } & Counts)[]
  /** Summed across extents, keeping the per-type split the response already carries. */
  readonly totals: Counts
  readonly failed: readonly Failure[]
  readonly incomplete: readonly Incomplete[]
  /**
   * False when an extent was approximated, so the count covers more than asked.
   *
   * A count over a convex hull is not the count of the boundary, and a caller
   * sizing a download on it is sizing it on the wrong number (§6.4).
   */
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
   * How many extents actually answered.
   *
   * Not derivable from `failed`: a cancelled run leaves the extents it never
   * reached in neither list, so `asked - failed.length` counts them as covered.
   * `count` gets this for free from `perExtent`; an aggregate answer has to
   * carry it.
   */
  readonly answered: number
  /**
   * True when every extent was queried exactly as asked.
   *
   * The same fact `count` reports, and it matters for the same reason: a
   * distribution taken over a convex hull describes the hull. The values it
   * finds only there are real values of the key, just not of the area the
   * caller named — and a tag union grounded on them is grounded on the wrong
   * area (§6.4). Unlike a download this cannot be narrowed back afterwards:
   * the server returns counts, not the elements they were counted from.
   */
  readonly exact: boolean
}

export interface DownloadResult {
  readonly outputs: readonly OsmOutput.Written[]
  readonly features: number
  /** Total bytes written, across every file this run produced. */
  readonly bytes: number
  /** The columns actually present in the output — the other half of the field contract. */
  readonly keptFields: readonly string[]
  readonly geometry: Record<string, number>
  readonly droppedFields: readonly string[]
  /**
   * Elements that matched but produced no geometry, by identity.
   *
   * Identities rather than a count, because the answer to a lost element is to
   * fetch it on its own — which needs to know which one it was.
   */
  readonly unassembled: readonly string[]
  readonly failed: readonly Failure[]
  readonly incomplete: readonly Incomplete[]
  /** How many extents produced an answer, out of how many were asked. */
  readonly extentsDone: number
  readonly extentsAsked: number
  /** The same object arriving from more than one extent, removed — i.e. how much they overlapped. */
  readonly duplicates: number
  /** Features collapsed from an area or line to a point, in centroid mode. */
  readonly centroidConverted: number
  /**
   * False when the query sent for some extent covered more ground than that
   * extent asked for, and the result still does.
   *
   * NOT "needs clipping", which is what this said until the automatic narrowing
   * (`intersect.ts`) made it wrong: the only shape that now reaches a caller
   * with `exact: false` is a call MIXING boundary files with other extent kinds,
   * and there the other extents legitimately hold features outside those files.
   * Cutting to them deletes exactly what was asked for (§6.4).
   */
  readonly exact: boolean
  /**
   * Which extents were widened, in the words `extent.ts` gave them.
   *
   * Empty whenever `exact` is true. Named rather than counted, for the reason
   * `unassembled` is: with several extents in one call, "something was widened"
   * leaves the caller unable to say WHICH boundary to ask for on its own — and
   * asking for it on its own is the one route that comes back exact.
   */
  readonly widened: readonly string[]
  readonly notes: readonly string[]
}

/**
 * Write, unless there is nothing to write.
 *
 * One condition, and it asks about this run only: did anything come back. Not
 * whether an extent failed, not whether the caller cancelled, not what is
 * already on disk — those all used to matter here, because writing overwrote,
 * and getting the condition wrong destroyed a finished download. Writing no
 * longer overwrites (§6.7), so the only thing left to decide is whether a file
 * is worth creating at all, and an empty one is not.
 *
 * Partial results still go to disk: on a multi-area download some data beats
 * none, as long as the shortfall is stated (§6.7).
 */
/**
 * The write, as a FAILURE rather than a defect — for the reason `checked()`
 * below spells out, arrived at from the other direction.
 *
 * `OsmOutput.write` throws on a full disk, a read-only directory, a path the
 * user cannot write. Called bare inside `Effect.gen`, every one of those became
 * a defect: outside the error type, past `Effect.result`, surfacing as an
 * unattributable tool crash after a download that had already succeeded and
 * had a file's worth of data to show for it.
 *
 * Returned as an Effect rather than wrapped at the two call sites, because the
 * call sites are what forgot the first time and the type is what cannot.
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
 * Entry checks, as a FAILURE rather than a defect.
 *
 * The query builders refuse malformed input by throwing, which is right for
 * pure functions — but a throw inside `Effect.gen` becomes a defect, and a
 * defect is outside the error type every caller handles. A mistyped element
 * list would take the caller down instead of coming back as the sentence
 * explaining what to write instead.
 *
 * These are whole-call mistakes, not per-extent ones: the type list and the tag
 * filters apply to every extent, so unlike an unparseable extent there is no
 * partial result to salvage. Checked BEFORE the extents are resolved, because
 * resolving reads boundary files off disk — work with nothing to show for it
 * once the call is going to be refused anyway.
 */
function checked<A>(thunk: () => A): Effect.Effect<A, Error> {
  return Effect.try({
    try: thunk,
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

/** The columns a policy puts in the output, in a stable order. */
function keptFieldsOf(policy: OsmConvert.FieldPolicy): string[] {
  return [
    ...OsmConvert.CORE_FIELDS,
    ...[...policy.keep].sort(),
    ...(policy.keepAll ? ["osm_tags (all tags, lossless)"] : []),
  ]
}

/**
 * Called as a download finishes each unit of work it can count (§6.2).
 *
 * **A reserved interface, not a feature.** §6.2's judgement stands: OSM is
 * called by a subagent, nothing here is promised a real-time view, and no
 * interface is being built to show one. What this adds is the hook — so that an
 * interface which later decides it wants a progress bar does not have to reopen
 * a kernel contract to get one. Same footing as the other frontend-stage
 * placeholders in §12.
 *
 * The tool layer cannot see this for itself. A shell tool streams because it
 * holds the process and the bytes arrive in its own hands; a download holds
 * nothing — the loop is in here, and how far it has got is a counter only this
 * module can read. RunQgisAlgorithm has the same shape for the same reason
 * (`QgisExecutor.runAlgorithm`'s `onChunk`), and it is deliberately the same
 * shape: two capabilities reporting progress two different ways is a cost paid
 * by every reader of either.
 *
 * What a unit IS belongs to the caller, which knows whether it asked for
 * extents or objects. Passing a number and a total is the whole of it.
 *
 * ⚠️ `settled` is not `extentsDone`. It counts the units no longer being waited
 * on, failures included, because the question a running download is being asked
 * is "how much longer" — and a run whose extents are failing would otherwise
 * sit at 0 of 5 while working hard. The outcome is a separate question, and the
 * result's own `extentsDone` / `failed` answer it when the run is over.
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
    /** Objects settled out of the objects asked for. */
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
    /** Extents settled out of the extents asked for. */
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

        // Both engines at once, which they genuinely can be: the two services
        // keep separate throttle clocks, so neither waits on the other and a
        // search costs the slower of the two rather than their sum. Neither is
        // allowed to fail the call either — their recall sets barely overlap, so
        // one of them is still a useful answer, as long as the caller is told it
        // is only one of them.
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
          // A category-constrained global name search can exhaust the server's
          // own budget. Dropping the constraint and filtering here is cheaper
          // for it and gives the same answer (§6.8 降级路径).
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

        // A site relation's members often carry quite different names, so the
        // name search reaches the parent and stops.
        const sites = elements.filter((element) => element.type === "relation" && element.tags?.type === "site")
        if (sites.length > 0) {
          const expansion = yield* Effect.result(
            client.overpass(OsmQuery.siteExpansion({ query: input.query, timeoutSec: 30 }), {
              abort: input.abort,
              timeoutMs: 60_000,
            }),
          )
          if (expansion._tag === "Success") {
            // The expansion returns members without saying which parent each
            // came from, so the attribution is only made when there is a single
            // candidate parent. Naming the first of several would be a guess
            // presented as a fact.
            const parent = sites.length === 1 ? OsmQuery.formatRef(sites[0]) : undefined
            for (const element of (expansion.success.json as any).elements ?? []) {
              if (element.tags) OsmSearch.upsert(candidates, OsmSearch.fromElement(element, "site", parent))
            }
          } else {
            notes.push("the site-relation expansion failed; member objects may be missing")
          }
        }

        // Nothing area-like came back, but the geocoder matched something. Its
        // canonical name is a better literal query than what was typed.
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

        // The per-type split is what tells a caller WHY a count is large — a
        // hundred thousand nodes and a hundred relations need different
        // decisions, and the response gives both for free.
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
          // Before the request, like `count` does: an extent that was widened
          // taints the distribution whether or not its query then succeeds.
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
          // The server applies the sample cap PER QUERY, so being truncated is a
          // per-extent fact. Measuring it against the cross-extent sum would
          // report three complete answers of four thousand as a partial one.
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

        // One batched query with geometry inlined — never per-object stitching,
        // which silently yields partial boundaries on large relations (§6.8).
        const batched = yield* Effect.result(
          client.overpass(OsmQuery.objects({ refs, timeoutSec: 120 }), { abort: input.abort, timeoutMs: 150_000 }),
        )
        if (batched._tag === "Success") {
          // The soft failure reaches here too, and it matters more here than
          // anywhere: a batch of large boundaries is exactly the query that
          // exhausts the server's budget, and when it does the element set comes
          // back TRUNCATED behind a normal status code. The objects it dropped
          // then fall through to the per-object path, which is the unreliable
          // one — so the caller has to be told that the primary route was cut
          // short, not left to read the fallback's troubles as "these objects
          // are a problem" (§6.3 第四种失败).
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

        /* Progress starts where the batch left off (§6.8).
         *
         * The batched query is one request for every object at once, so it
         * cannot be ticked through — but what it settles is known the moment it
         * returns, and that is usually most of them. The loop below is the part
         * that can take minutes: one request per object, and it only runs when
         * the batch fell short, which is also when there is most to wait for.
         *
         * The denominator is what the caller ASKED for, which is also what the
         * result reports — an id that never parsed is already in `failed` and
         * is as settled as anything gets. Counting only the parseable ones here
         * would give `objects_asked` a second meaning on the live channel, and
         * one word meaning two things is how a channel stops being read.
         */
        const settleable = input.ids.length
        let settled = settleable - missing.length
        if (input.onProgress) yield* input.onProgress(settled, settleable)

        // The fallback's assembly is the unreliable one, so its output is
        // checked against the nodes it was built from before being accepted.
        for (const ref of [...missing]) {
          // Stop on cancellation rather than letting each remaining object add
          // its own "cancelled" entry — a failure list that long reads as a
          // service problem instead of a user pressing stop.
          if (input.abort?.aborted) break
          const single = yield* Effect.result(client.osmApi(ref.type, ref.id, { abort: input.abort }))
          // Before the branches below, all four of which leave this object
          // settled — fetched, refused, unconvertible or partial.
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
          // Objects, not extents: how many of the ids asked for came back. The
          // ids that never parsed are in `failed` and were never fetched, so
          // they belong in the denominator and nowhere else.
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
        // Counted as extents succeed rather than reconstructed afterwards by
        // subtracting failures: `failed` also holds the extents that never
        // parsed, and the two denominators are not the same.
        let done = 0
        // Extents that never parsed are already in `failed`, and they are as
        // settled as anything gets. Starting from them is what keeps the count
        // and its total describing the same set.
        let settled = failed.length
        // Announced before the first request, not after it: a one-extent
        // download would otherwise report nothing at all until it was over,
        // and that is the shape most downloads have.
        if (input.onProgress) yield* input.onProgress(settled, input.extents.length)

        for (const { spec, extent } of resolved) {
          if (input.abort?.aborted) break
          if (!extent.exact) {
            exact = false
            // `extent.ts` already words this — "boundary file X (3 polygons,
            // reduced to convex hulls)" — and nothing read it until now.
            // Collected right next to the flag it explains, so the two cannot
            // drift apart.
            widened.push(extent.label)
          }
          const outcome = yield* Effect.result(
            client.overpass(
              OsmQuery.download({ spatial: extent.spatial, tags: input.tags, types, timeoutSec: budget }),
              { abort: input.abort, timeoutMs: clientBudgetMs(budget) },
            ),
          )
          // Ticked here rather than at the end of the body, because the body
          // has a `continue` in it: an extent that failed is one nobody is
          // waiting on any more, and skipping it would stall the count on
          // exactly the runs that take longest.
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

        /* The boundary test the server could not run, run here (§6.4).
         *
         * A widened query returns a superset. This asks each feature the same
         * question Overpass would have asked — does it intersect the real
         * boundary — and drops the ones only the widening brought in. What the
         * caller receives is then what a simple boundary would have produced,
         * so the two paths agree and nobody downstream has to know which one
         * ran.
         *
         * **Before the centroid collapse, and that order is not cosmetic.** A
         * road crossing the city line is judged by its whole geometry here;
         * judged by the representative point it is about to become, a road
         * whose midpoint fell outside would take its inside half with it —
         * exactly the invisible loss §6.4 exists to prevent.
         *
         * **All or nothing across extents.** One `area:` among them and the
         * answer legitimately holds features outside every boundary we hold,
         * so filtering to those would delete them; the download stays a
         * superset and says so. When it does run, the filter is the UNION of
         * every extent's boundary — including the exact ones, whose features
         * would otherwise be deleted by their neighbours' boundaries.
         *
         * There is no "it removed everything, so it must be wrong" guard, the
         * one `native:clip` needed. That guard exists to distrust a foreign
         * engine handed a foreign overlay; this reads the same file the query
         * was built from, and an empty answer here is an answer — a convex
         * hull can easily hold features that the boundary inside it does not.
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
          // By identity, alongside the elements that never assembled: both are
          // conversion loss, and the answer to either is to fetch the object on
          // its own — which needs to know which object it was. A count alone
          // says something was lost and refuses to say what.
          unassembled.push(...normalized.dropped)
          features = normalized.features
          // How many were areas or lines before this, which is what tells a
          // caller whether asking for point elements alone would have missed
          // most of the answer (§6.8).
          centroidConverted = features.filter((feature) => feature.properties.original_geometry).length
        }

        // Whatever was obtained is written even when some extents failed: on a
        // multi-area download, partial results beat discarding everything
        // (§6.7 失败时保留已获得的部分结果并标记).
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
          // Cleared when the narrowing ran: the query was widened, the RESULT
          // is not, and naming boundaries the caller no longer has to think
          // about is the same noise as a warning that fires every time.
          widened: exact ? [] : widened,
          notes,
        }
      })

    return Service.of({ search, count, distribution, downloadObjects, downloadFeatures })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [OsmClient.node, OsmHttp.node] })
