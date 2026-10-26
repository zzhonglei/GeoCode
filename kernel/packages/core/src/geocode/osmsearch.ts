export * as OsmSearchTool from "./osmsearch.js"

import { ToolFailure } from "@opencode/ai"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Exit, Schema } from "effect"
import type { Permission } from "../permission.js"
import { GeoEngine } from "./geoengine.js"
import { GeoOsm } from "./osm.js"
import DESCRIPTION from "./osmsearch.txt"

export const name = "osmsearch"

export const description = DESCRIPTION

export const Input = Schema.Struct({
  name: Schema.String.annotate({
    description:
      'The name, best the official one in the local language as OSM writes it, such as "國立臺灣大學" or "广州白云国际机场"',
  }),
  context: Schema.optionalKey(Schema.String).annotate({
    description:
      'Where it is, to tell places of the same name apart: a place name, such as "Wuhan" or "新北市", or the id of an area found before, such as "R3076268"',
  }),
  category: Schema.optionalKey(Schema.String).annotate({
    description:
      'What it is, as a tag filter such as "amenity=university" or "aeroway": only such objects are kept; with "context", the named objects of that kind there are listed when no name matches',
  }),
})

const Candidate = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  size: Schema.NullOr(Schema.Tuple([Schema.Number, Schema.Number])),
  preset: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  name_en: Schema.NullOr(Schema.String),
  location: Schema.NullOr(Schema.String),
  center: Schema.NullOr(Schema.Tuple([Schema.Number, Schema.Number])),
  description: Schema.NullOr(Schema.String),
  /** A stop or route named after a place, ranked after it. */
  transit: Schema.Boolean,
})

const Found = Schema.Struct({
  name: Schema.String,
  context: Schema.NullOr(Schema.String),
  context_found: Schema.NullOr(Schema.Boolean),
  category: Schema.NullOr(Schema.String),
  fallback: Schema.Boolean,
  candidates: Schema.Array(Candidate),
  total: Schema.Number,
  incomplete: Schema.Boolean,
})
const decodeFound = Schema.decodeUnknownExit(Found)

/**
 * The search as its tool row shows it (docs/OSM.md, section 9): the candidates without their centre and description.
 */
const shown = (found: typeof Found.Type) => ({
  ...found,
  candidates: found.candidates.map(({ center: _center, description: _description, ...candidate }) => candidate),
})

/**
 * One candidate, on lines of its own: what it is, then its names, where it is and its centre, then what it is known
 * as.
 */
const candidateLines = (candidate: typeof Candidate.Type, index: number) => {
  const what = [
    candidate.preset && candidate.category
      ? `${candidate.preset} (${candidate.category})`
      : (candidate.category ?? "unknown kind"),
    candidate.size && candidate.kind !== "point"
      ? `${candidate.kind}, about ${candidate.size[0]} × ${candidate.size[1]} km`
      : candidate.kind,
  ]
  const names = [candidate.name, candidate.name_en].filter((value, at, all) => value && all.indexOf(value) === at)
  const where = [
    names.join(" / ") || "(no name)",
    candidate.location,
    candidate.center ? `${candidate.center[0]}, ${candidate.center[1]}` : undefined,
  ].filter(Boolean)
  return [
    `${index + 1}. ${candidate.id}: ${what.join(", ")}`,
    `   ${where.join(" — ")}`,
    ...(candidate.description ? [`   ${candidate.description}`] : []),
  ].join("\n")
}

const answer = (found: typeof Found.Type) => {
  const within = found.context && found.context_found ? ` in ${found.context}` : ""
  const notes = [
    ...(found.context && found.context_found === false
      ? [`No place named "${found.context}" was found, so the search was not narrowed to it.`]
      : []),
    ...(found.context && found.context_found === null
      ? [`"${found.context}" could not be looked up, so the search was not narrowed to it.`]
      : []),
    ...(found.incomplete ? ["Part of the search did not complete, so these candidates may be incomplete."] : []),
  ]
  if (!found.candidates.length) {
    return [...notes, `No object named "${found.name}"${within} was found.`].join("\n")
  }
  const opening = found.fallback
    ? `No object named "${found.name}"${within} was found. These are the named ${found.category} objects there:`
    : found.total > found.candidates.length
      ? `${found.total} candidates for "${found.name}"${within}; the ${found.candidates.length} best:`
      : `${found.total} candidate${found.total === 1 ? "" : "s"} for "${found.name}"${within}:`
  return [...notes, opening, "", found.candidates.map(candidateLines).join("\n\n")].join("\n")
}

export const make = (permission: Permission.Interface) => ({
  name,
  // On the provider's tool list, as the built-in tools are, rather than inside Code Mode's catalog.
  options: { codemode: false },
  description,
  input: Input,
  execute: (input: typeof Input.Type, context: Tool.Context) =>
    Effect.gen(function* () {
      const failed = GeoOsm.failed(name, context)
      yield* GeoOsm.check("search", input).pipe(Effect.catch(failed))
      // As websearch asks: allowed by the default rules, so a rule can still make it ask or hide it.
      yield* permission.assert({
        action: name,
        resources: [input.name],
        save: ["*"],
        metadata: input,
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })
      const result = yield* GeoEngine.call("osm.search", input).pipe(Effect.catch(failed))
      const found = decodeFound(result)
      if (Exit.isFailure(found)) {
        return yield* failed(new GeoEngine.Failure({ code: "unreadable", message: String(found.cause) }))
      }
      return { content: answer(found.value), metadata: { found: shown(found.value) } }
    }).pipe(
      Effect.mapError((error) =>
        error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to search OpenStreetMap", error }),
      ),
    ),
})
