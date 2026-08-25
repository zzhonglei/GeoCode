import * as InstanceState from "@/effect/instance-state"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Effect, Layer, Option } from "effect"
import ignore from "ignore"
import fsp from "fs/promises" // GeoCode: one stat for the size gate below.
import path from "path"
import { HttpApiBuilder } from "effect/unstable/httpapi"
// GeoCode: the shared GIS taxonomy (docs/GEOKERNEL.md §10.1 #5).
import { GeoExtensions } from "@opencode-ai/core/filesystem/geo-extensions"
import { InstanceHttpApi } from "../api"

/* --- GeoCode: the two ceilings on the generic content endpoint (§10.1 #8).
 *
 * The raster threshold is where "show me the file" stops being the right answer and "draw it on the map"
 * starts, above which the interface is pointed at the preview endpoint instead. 50 MiB deliberately clears
 * legitimate session artifacts — a 12 MiB PNG map export viewed inline — while stopping the pathological
 * cases. --- */
const MAX_INLINE_IMAGE = 8 * 1024 * 1024
const MAX_INLINE_FILE = 50 * 1024 * 1024

export const fileHandlers = HttpApiBuilder.group(InstanceHttpApi, "file", (handlers) =>
  Effect.gen(function* () {
    const ripgrep = yield* Ripgrep.Service
    const locations = yield* LocationServiceMap.Service

    const filesystem = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* effect.pipe(
        Effect.provide(
          locations.get(Location.Ref.make({ directory: AbsolutePath.make((yield* InstanceState.context).directory) })),
        ),
      )
    })

    const findText = Effect.fn("FileHttpApi.findText")(function* (ctx: { query: { pattern: string } }) {
      return (yield* ripgrep
        .grep({ cwd: (yield* InstanceState.context).directory, pattern: ctx.query.pattern, limit: 10 })
        .pipe(Effect.orDie)).map((match) => ({
        path: { text: match.entry.path },
        lines: { text: match.text },
        line_number: match.line,
        absolute_offset: match.offset,
        submatches: match.submatches.map((submatch) => ({
          match: { text: submatch.text },
          start: submatch.start,
          end: submatch.end,
        })),
      }))
    })

    const findFile = Effect.fn("FileHttpApi.findFile")(function* (ctx: {
      query: { query: string; dirs?: "true" | "false"; type?: "file" | "directory"; limit?: number }
    }) {
      const directory = (yield* InstanceState.context).directory
      const limit = ctx.query.limit ?? 10
      const type = ctx.query.type ?? (ctx.query.dirs === "false" ? "file" : undefined)
      const started = performance.now()
      const found = yield* filesystem(FileSystem.Service.use((fs) => fs.find({ query: ctx.query.query, limit, type })))
      yield* Effect.logInfo("find file", {
        query: ctx.query.query,
        type,
        directory,
        limit,
        results: found.length,
        duration: Math.round(performance.now() - started),
      })
      return found.map((item) => item.path)
    })

    const findSymbol = Effect.fn("FileHttpApi.findSymbol")(function* () {
      return []
    })

    const list = Effect.fn("FileHttpApi.list")(function* (ctx: { query: { path: string } }) {
      const directory = (yield* InstanceState.context).directory
      return yield* filesystem(
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          const raw = yield* FSUtil.Service
          const location = yield* Location.Service
          const ignored = ignore()
          const gitignore = yield* raw
            .readFileString(path.join(location.project.directory, ".gitignore"))
            .pipe(Effect.catch(() => Effect.succeed("")))
          if (gitignore) ignored.add(gitignore)
          const ignorefile = yield* raw
            .readFileString(path.join(location.project.directory, ".ignore"))
            .pipe(Effect.catch(() => Effect.succeed("")))
          if (ignorefile) ignored.add(ignorefile)
          return (yield* fs.list({ path: RelativePath.make(ctx.query.path) })).map((item) => ({
            name: path.basename(item.path),
            path: item.path,
            absolute: path.resolve(location.directory, item.path),
            type: item.type,
            ignored: ignored.ignores(
              path.relative(location.project.directory, path.resolve(location.directory, item.path)) +
                (item.type === "directory" ? "/" : ""),
            ),
          }))
        }),
      )
    })

    const content = Effect.fn("FileHttpApi.content")(function* (ctx: { query: { path: string } }) {
      const directory = (yield* InstanceState.context).directory
      const file = path.resolve(directory, ctx.query.path)
      if (!FSUtil.contains(directory, file)) return yield* Effect.die(new Error("Path escapes the location"))
      if (!(yield* FSUtil.Service.use((fs) => fs.existsSafe(file)))) return { type: "text" as const, content: "" }

      /* --- GeoCode: size-gate the generic content endpoint (docs/GEOKERNEL.md §10.1 #8).
       *
       * Upstream has no limit anywhere on this path, so a restored editor tab can pull a multi-hundred-megabyte
       * file into the renderer as one string. Observed 2026-07-11: a 359 MiB CSV fetched twice ≈ 1.8 GiB of V8
       * heap (UTF-16), then a renderer OOM.
       *
       * Two tiers off a single stat. A large raster is not an error — the geo workspace draws it through
       * `/geo/raster/image` — so it is pointed there rather than refused. A stat failure falls through as size 0
       * on purpose: the read below surfaces the real error, and agents never come through here. --- */
      const size = yield* Effect.promise(() =>
        fsp
          .stat(file)
          .then((stat) => Number(stat.size))
          .catch(() => 0),
      )
      const megabytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1)
      if (GeoExtensions.RASTER_MAIN.includes(path.extname(file).toLowerCase().slice(1)) && size > MAX_INLINE_IMAGE) {
        return {
          type: "text" as const,
          content: `Raw view disabled for large raster (${megabytes(size)} MiB). Use Map mode.`,
          notice: "oversized-raster" as const,
          size,
        }
      }
      if (size > MAX_INLINE_FILE) {
        return {
          type: "text" as const,
          content: `File too large to display (${megabytes(size)} MiB). Open it with an external tool, or ask the agent to read the parts you need.`,
          notice: "oversized" as const,
          size,
        }
      }
      // --- /GeoCode ---

      return yield* filesystem(
        FileSystem.Service.use((fs) => fs.read({ path: RelativePath.make(ctx.query.path) })),
      ).pipe(
        Effect.flatMap((item) =>
          Effect.gen(function* () {
            const text = item.content.includes(0)
              ? Option.none<string>()
              : yield* Effect.sync(() => new TextDecoder("utf-8", { fatal: true }).decode(item.content)).pipe(
                  Effect.option,
                )
            return { item, text }
          }),
        ),
        Effect.map(({ item, text }) =>
          Option.isSome(text)
            ? { type: "text" as const, content: text.value.trim() }
            : {
                type: "binary" as const,
                content: Buffer.from(item.content).toString("base64"),
                encoding: "base64" as const,
                mimeType: item.mime,
              },
        ),
      )
    })

    const status = Effect.fn("FileHttpApi.status")(function* () {
      return []
    })

    return handlers
      .handle("findText", findText)
      .handle("findFile", findFile)
      .handle("findSymbol", findSymbol)
      .handle("list", list)
      .handle("content", content)
      .handle("status", status)
  }),
).pipe(Layer.provide(locationServiceMapLayer))
