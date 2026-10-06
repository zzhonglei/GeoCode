export * as QgisDocTool from "./qgisdoc.js"

import { ToolFailure } from "@opencode/ai"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Exit, Schema } from "effect"
import type { Permission } from "../permission.js"
import { GeoEngine } from "./geoengine.js"

export const name = "qgisdoc"

export const description = `Read the documentation of QGIS Processing algorithms.

Actions:
- groups: list the algorithm groups, each with how many algorithms it holds.
- algorithms: list the algorithms in one group, each with its ID, name and a one-line summary. Requires "group".
- help: read one algorithm's documentation: every parameter with its type, default and acceptable values, and the outputs. Requires "algorithm".
- search: find algorithms by English keywords, best matches first (at most 10, with the total count). Requires "query". Use it when you do not know an algorithm's ID.

If an algorithm's documentation leaves something unclear, read the official QGIS page linked at its end with webfetch.`

export const Input = Schema.Struct({
  action: Schema.Literals(["groups", "algorithms", "help", "search"]).annotate({
    description:
      "groups: list the groups; algorithms: list the algorithms in a group; help: read an algorithm's documentation; search: find algorithms by keyword",
  }),
  group: Schema.optionalKey(Schema.String).annotate({
    description: 'A group name as action "groups" lists it, for example "Vector geometry". Required for "algorithms"',
  }),
  algorithm: Schema.optionalKey(Schema.String).annotate({
    description: 'The full algorithm ID, for example "native:buffer". Required for "help"',
  }),
  query: Schema.optionalKey(Schema.String).annotate({
    description: 'English keywords, for example "buffer" or "join location". Required for "search"',
  }),
})

const Answer = Schema.Struct({ text: Schema.String })
const decodeAnswer = Schema.decodeUnknownExit(Answer)

/** What GeoAgent reads when GeoEngine cannot answer; a QGIS that is not ready comes with what to do about it. */
const failureMessage = (failure: GeoEngine.Failure) => {
  if (failure.code === "not-ready") return failure.message
  if (failure.code === "catalog-failed") return "QGIS could not list its algorithms. Tell the user."
  return GeoEngine.UNAVAILABLE
}

const failed = (failure: GeoEngine.Failure) =>
  Effect.logWarning("qgisdoc failed", { code: failure.code, message: failure.message, details: failure.details }).pipe(
    Effect.andThen(Effect.fail(new ToolFailure({ message: failureMessage(failure) }))),
  )

export const make = (permission: Permission.Interface) => ({
  name,
  // On the provider's tool list, as the built-in tools are, rather than inside Code Mode's catalog.
  options: { codemode: false },
  description,
  input: Input,
  execute: (input: typeof Input.Type, context: Tool.Context) =>
    Effect.gen(function* () {
      const subject = { groups: undefined, algorithms: input.group, help: input.algorithm, search: input.query }[
        input.action
      ]
      // As grep and glob ask: allowed by the default rules, so a rule can still make it ask or hide it.
      yield* permission.assert({
        action: name,
        resources: [subject ?? input.action],
        save: ["*"],
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })
      const result = yield* GeoEngine.call("qgis.doc", input).pipe(Effect.catch(failed))
      const answer = decodeAnswer(result)
      if (Exit.isFailure(answer)) {
        return yield* failed(new GeoEngine.Failure({ code: "unreadable", message: String(answer.cause) }))
      }
      return { content: answer.value.text }
    }).pipe(
      // As glob does: a refused permission or a missing session still ends as this tool's failure.
      Effect.mapError((error) =>
        error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to look up QGIS algorithms", error }),
      ),
    ),
})
