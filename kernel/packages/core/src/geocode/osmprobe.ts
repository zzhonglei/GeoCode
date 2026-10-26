export * as OsmProbeTool from "./osmprobe.js"

import { ToolFailure } from "@opencode/ai"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Exit, Schema } from "effect"
import type { FileAccess } from "../file-access.js"
import type { Permission } from "../permission.js"
import { GeoEngine } from "./geoengine.js"
import { GeoOsm } from "./osm.js"
import DESCRIPTION from "./osmprobe.txt"

export const name = "osmprobe"

export const description = DESCRIPTION

export const Input = Schema.Struct({
  area: GeoOsm.Area,
  term: Schema.optionalKey(Schema.String).annotate({
    description: 'An everyday English word or phrase for a kind of thing, such as "hospital" or "bus stop"',
  }),
  tags: Schema.optionalKey(GeoOsm.Tags),
  keys: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(5))).annotate({
    description: 'Up to 5 tag keys whose values to list, such as ["amenity", "shop"]',
  }),
})

const Counted = Schema.Struct({
  nodes: Schema.Number,
  ways: Schema.Number,
  relations: Schema.Number,
  total: Schema.Number,
})

const Looked = Schema.Union([
  Schema.Struct({
    area: Schema.String,
    term: Schema.String,
    rows: Schema.Array(
      Schema.Struct({
        ...Counted.fields,
        filter: Schema.String,
        preset: Schema.String,
        why: Schema.Literals(["preset", "added", "deprecated"]),
      }),
    ),
    uncounted: Schema.Array(Schema.String),
    remark: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    area: Schema.String,
    rows: Schema.Array(Schema.Struct({ ...Counted.fields, filter: Schema.String })),
    uncounted: Schema.Array(Schema.String),
    together: Schema.NullOr(Counted),
    remark: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    area: Schema.String,
    keys: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        features: Schema.Number,
        values: Schema.Array(Schema.Tuple([Schema.String, Schema.Number])),
        others: Schema.Number,
        others_features: Schema.Number,
      }),
    ),
    sampled: Schema.Boolean,
    remark: Schema.NullOr(Schema.String),
  }),
])
const decodeLooked = Schema.decodeUnknownExit(Looked)

const counted = (count: typeof Counted.Type) =>
  `${count.total.toLocaleString("en-US")} (nodes ${count.nodes}, ways ${count.ways}, relations ${count.relations})`

const WHY = {
  preset: (preset: string) => preset,
  added: (preset: string) => `added to new features of ${preset}`,
  deprecated: (preset: string) => `deprecated tagging of ${preset}`,
}

const answer = (looked: typeof Looked.Type) => {
  const stopped = looked.remark ? [`Overpass stopped early, so the counts may be low: ${looked.remark}`] : []
  const uncounted =
    "uncounted" in looked && looked.uncounted.length
      ? [`Not counted before Overpass stopped: ${looked.uncounted.join(", ")}`]
      : []
  if ("term" in looked) {
    if (!looked.rows.length && !looked.uncounted.length) {
      return `No kind of thing in OSM's tagging conventions is called "${looked.term}".`
    }
    const found = looked.rows.filter((row) => row.total > 0)
    const none = looked.rows.filter((row) => row.total === 0)
    return [
      `Tags for "${looked.term}" in ${looked.area}, by OSM's tagging conventions, with how many features carry each:`,
      ...found.map((row) => `${row.filter}: ${counted(row)}, ${WHY[row.why](row.preset)}`),
      ...(none.length
        ? [`None in the area: ${none.map((row) => `${row.filter} (${WHY[row.why](row.preset)})`).join(", ")}`]
        : []),
      ...uncounted,
      ...stopped,
    ].join("\n")
  }
  if ("rows" in looked) {
    return [
      `In ${looked.area}:`,
      ...looked.rows.map((row) => `${row.filter}: ${counted(row)}`),
      ...(looked.together ? [`Any of them: ${counted(looked.together)}`] : []),
      ...uncounted,
      ...stopped,
    ].join("\n")
  }
  return [
    `In ${looked.area}:`,
    ...looked.keys.map((key) => {
      const values = key.values.map(([value, features]) => `${value} ${features}`).join(", ")
      const others = key.others ? `; ${key.others} other values on ${key.others_features} features` : ""
      return `${key.key}, on ${key.features.toLocaleString("en-US")} features: ${values || "none"}${others}`
    }),
    ...(looked.sampled ? ["The area has more features than were read; these are the values of those read."] : []),
    ...stopped,
  ].join("\n")
}

export const make = (permission: Permission.Interface, access: FileAccess.Interface) => ({
  name,
  // On the provider's tool list, as the built-in tools are, rather than inside Code Mode's catalog.
  options: { codemode: false },
  description,
  input: Input,
  execute: (input: typeof Input.Type, context: Tool.Context) =>
    Effect.gen(function* () {
      const failed = GeoOsm.failed(name, context)
      // Refused before the user is asked, as the look itself would refuse it.
      if ([input.term, input.tags, input.keys].filter(Boolean).length !== 1) {
        return yield* failed(
          new GeoEngine.Failure({ code: "invalid-params", message: "give exactly one of term, tags and keys" }),
        )
      }
      // A boundary file is only where to look, which GeoAgent has most likely read already: read's rules do not ask.
      const area = yield* GeoOsm.resolveArea(access, input.area)
      yield* GeoOsm.check("probe", { ...input, area }).pipe(Effect.catch(failed))
      // As websearch asks: allowed by the default rules, so a rule can still make it ask or hide it.
      yield* permission.assert({
        action: name,
        resources: [area],
        save: ["*"],
        metadata: input,
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })
      const result = yield* GeoEngine.call("osm.probe", { ...input, area }, GeoOsm.queue(context)).pipe(
        Effect.catch(failed),
      )
      const looked = decodeLooked(result)
      if (Exit.isFailure(looked)) {
        return yield* failed(new GeoEngine.Failure({ code: "unreadable", message: String(looked.cause) }))
      }
      // The counts as the tool row shows them (docs/OSM.md, section 9).
      return { content: answer(looked.value), metadata: { looked: looked.value } }
    }).pipe(
      Effect.mapError((error) =>
        error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to look at OpenStreetMap", error }),
      ),
    ),
})
