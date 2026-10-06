export * as ReadGeodataTool from "./readgeodata.js"

import { ToolFailure } from "@opencode/ai"
import type { Tool } from "@opencode/schema/tool"
import { Deferred, Effect, Exit, Schema } from "effect"
import type { FileAccess } from "../file-access.js"
import { GeoEngine } from "./geoengine.js"

export const name = "readgeodata"

export const description = `Read geographic data: its layers, coordinate reference system, extent, fields and their values, sample features, and the exact statistics of raster bands. It reads anything GDAL can open, such as Shapefile, GeoPackage, GeoJSON, KML, GML, a File Geodatabase folder (.gdb), GeoTIFF, NetCDF and HDF.

- A file with several layers is answered with a list of them; read one with "layer".
- Features come a few at a time; read on with "offset" and "limit".
- A Shapefile that does not declare its text encoding is read in the encoding detected; if its text looks garbled, set "encoding".
- With "preview", a raster is answered with a picture of it instead of its description. Read the description first, and preview only when seeing the data helps.`

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description: "The file to read, or a folder GDAL reads as one dataset, such as a .gdb",
  }),
  layer: Schema.optionalKey(Schema.String).annotate({
    description: "The layer to read, by a name listed for a file with several layers",
  }),
  offset: Schema.optionalKey(Count).annotate({ description: "The first feature to show, counting from 1 (default 1)" }),
  limit: Schema.optionalKey(Count.check(Schema.isLessThanOrEqualTo(50))).annotate({
    description: "How many features to show (default 3, at most 50)",
  }),
  encoding: Schema.optionalKey(Schema.String).annotate({
    description: 'The text encoding of a Shapefile, such as "GBK", "Big5" or "CP1252", when the one detected is wrong',
  }),
  preview: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Answer with a picture of a raster instead of its description",
  }),
  bands: Schema.optionalKey(Schema.Array(Count)).annotate({
    description: "For a preview: one band number to show in grey, or three to show as red, green and blue",
  }),
})

const Answer = Schema.Struct({ text: Schema.String, image: Schema.optionalKey(Schema.String) })
const decodeAnswer = Schema.decodeUnknownExit(Answer)

/** What GeoAgent reads when GeoEngine cannot answer; a QGIS that is not ready comes with what to do about it. */
const failureMessage = (failure: GeoEngine.Failure, path: string) => {
  if (failure.code === "not-ready") return failure.message
  if (failure.code === "read-failed") return `GDAL failed while reading ${path}: ${failure.message}`
  if (failure.code === "timeout" || failure.code === "crashed") return `Reading ${path} stopped without an answer.`
  return GeoEngine.UNAVAILABLE
}

type Authorization = Effect.Success<ReturnType<FileAccess.Interface["authorizeRead"]>>
type Refusal = Effect.Error<ReturnType<FileAccess.Interface["authorizeRead"]>>

export const make = (access: FileAccess.Interface) => {
  /**
   * Each session's datasets, by absolute path, with the asking that allowed them or is still waiting on the user.
   * GeoAgent looks at one dataset in several calls (its layers, its pages, a preview), often side by side, so a dataset
   * is asked about once a session, and calls made while that asking waits share its answer. A refusal is not kept, and
   * nothing is kept past the kernel's run.
   */
  const allowed = new Map<string, Map<string, Deferred.Deferred<Authorization, Refusal>>>()

  const authorize = (input: typeof Input.Type, context: Tool.Context) =>
    Effect.gen(function* () {
      const absolute = (yield* access.resolve({ path: input.path })).absolute
      // Found or kept with nothing in between, so a call alongside cannot ask too, and an interrupted asking is done.
      return yield* Effect.uninterruptibleMask((restore) => {
        const session = allowed.get(context.sessionID) ?? new Map<string, Deferred.Deferred<Authorization, Refusal>>()
        allowed.set(context.sessionID, session)
        const known = session.get(absolute)
        if (known) return restore(Deferred.await(known))
        const asking = Deferred.makeUnsafe<Authorization, Refusal>()
        session.set(absolute, asking)
        // Otherwise as read asks: outside the project, for the directory first, then by the read rules.
        return restore(access.authorizeRead(input.path, context)).pipe(
          Effect.onExit((exit) => {
            if (!Exit.isSuccess(exit)) session.delete(absolute)
            return Deferred.done(asking, exit)
          }),
        )
      })
    })

  return {
    name,
    // On the provider's tool list, as the built-in tools are, rather than inside Code Mode's catalog.
    options: { codemode: false },
    description,
    input: Input,
    execute: (input: typeof Input.Type, context: Tool.Context) =>
      Effect.gen(function* () {
        const target = yield* authorize(input, context)
        const failed = (failure: GeoEngine.Failure) =>
          Effect.logWarning("readgeodata failed", {
            code: failure.code,
            message: failure.message,
            details: failure.details,
          }).pipe(Effect.andThen(Effect.fail(new ToolFailure({ message: failureMessage(failure, input.path) }))))
        const result = yield* GeoEngine.call("qgis.read", { ...input, path: target.absolute }).pipe(
          Effect.catch(failed),
        )
        const answer = decodeAnswer(result)
        if (Exit.isFailure(answer)) {
          return yield* failed(new GeoEngine.Failure({ code: "unreadable", message: String(answer.cause) }))
        }
        if (answer.value.image === undefined) return { content: answer.value.text }
        return {
          content: [
            { type: "text" as const, text: answer.value.text },
            {
              type: "file" as const,
              uri: `data:image/png;base64,${answer.value.image}`,
              mime: "image/png",
              name: input.path,
            },
          ],
        }
      }).pipe(
        // As read does: a refused permission or a missing session still ends as this tool's failure.
        Effect.mapError((error) =>
          error instanceof ToolFailure ? error : new ToolFailure({ message: `Unable to read ${input.path}`, error }),
        ),
      ),
  }
}
