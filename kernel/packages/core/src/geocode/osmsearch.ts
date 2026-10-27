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
      'The name to search for, as OSM writes it, such as "Massachusetts Institute of Technology", "武汉大学" or "香港大學". Only the name: give where the place is in "context"',
  }),
  context: Schema.optionalKey(Schema.String).annotate({
    description:
      'Where the place is, to tell places of the same name apart: its city, such as "Cambridge, United States", "武汉" or "香港". Not a district or a smaller place. Objects far from it are left out',
  }),
  category: Schema.optionalKey(Schema.String).annotate({
    description:
      'A tag filter for what the place is, such as "amenity=university", or "aeroway" for any value. Only objects meeting it are returned, so a wrong filter hides the right one. With "context", if nothing found meets it, lists named objects of this kind there instead',
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
 * The search as its tool row shows it: the candidates without their centre and description.
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
      : candidate.preset || candidate.category || "unknown kind",
    candidate.size && candidate.kind !== "point"
      ? `${candidate.kind}, about ${candidate.size[0]} × ${candidate.size[1]} km`
      : candidate.kind,
  ]
  const names = [candidate.name, candidate.name_en].filter((value, at, all) => value && all.indexOf(value) === at)
  const where = [
    names.join(" / ") || "(no name)",
    candidate.location,
    candidate.center ? `centre ${candidate.center[0]}, ${candidate.center[1]} (lat, lon)` : undefined,
  ].filter(Boolean)
  return [
    `${index + 1}. ${candidate.id}: ${what.join(", ")}`,
    `   ${where.join(" — ")}`,
    ...(candidate.description ? [`   ${candidate.description}`] : []),
  ].join("\n")
}

const answer = (found: typeof Found.Type) => {
  const within = found.context && found.context_found ? ` in ${found.context}` : ""
  const narrowed = [
    ...(found.context && found.context_found === false
      ? [`No place named "${found.context}" was found, so the search was not narrowed to it.`]
      : []),
    ...(found.context && found.context_found === null
      ? [`"${found.context}" could not be looked up, so the search was not narrowed to it.`]
      : []),
  ]
  const none = `No ${found.category ? `${found.category} object` : "object"} named "${found.name}"${within} was found`
  // Said apart from a search that completed: the object may well be there.
  const missed = found.incomplete
    ? `${none}, but part of the search did not complete, so it may still exist.`
    : `${none}.`
  const listed = found.candidates.length
  if (!listed) return [...narrowed, missed].join("\n")
  const opening = found.fallback
    ? `${missed} These are ${found.total > listed ? `${listed} of the` : "the"} named ${found.category} objects there:`
    : found.total > listed
      ? `${found.total} candidates for "${found.name}"${within}; the ${listed} best:`
      : `${found.total} candidate${found.total === 1 ? "" : "s"} for "${found.name}"${within}:`
  // A list the search fell back to says already that the search did not complete.
  return [
    ...narrowed,
    ...(found.incomplete && !found.fallback
      ? ["Part of the search did not complete, so these candidates may be incomplete."]
      : []),
    opening,
    "",
    found.candidates.map(candidateLines).join("\n\n"),
  ].join("\n")
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
      // Refused before GeoEngine or the user is asked, as the search itself would refuse it.
      if (!input.name.trim()) {
        return yield* failed(
          new GeoEngine.Failure({ code: "invalid-params", message: "name is empty: give the name to search for" }),
        )
      }
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
