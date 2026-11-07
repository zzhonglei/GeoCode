export * as GeoTools from "./tools.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Bus } from "../bus.js"
import { FileAccess } from "../file-access.js"
import { Job } from "../job.js"
import { Location } from "../location.js"
import { Permission } from "../permission.js"
import { PermissionSaved } from "../permission/saved.js"
import { GeeRunTool } from "./geerun.js"
import { GeeRunJob } from "./geerun-job.js"
import { GeeRunRpc } from "./geerun-rpc.js"
import { GeoGuards } from "./guards.js"
import { OsmGetTools } from "./osmget.js"
import { OsmProbeTool } from "./osmprobe.js"
import { OsmSearchTool } from "./osmsearch.js"
import { QgisDocTool } from "./qgisdoc.js"
import { QgisRunTool } from "./qgisrun.js"
import { ReadGeodataTool } from "./readgeodata.js"

/** The namespace OpenCode gives the tools that manage the app itself, such as `session_rename`. */
const upstream = "opencode"
/** Their namespace in GeoCode: the model calls them as `tools.geocode.session_rename` in Code Mode. */
const namespace = "geocode"

/**
 * Moves OpenCode's tools that manage the app itself into the `geocode` namespace, so the model and the user see them
 * under GeoCode's name. Runs after every plugin that adds them (OpenCodeTools, McpResourceTools, ArtifactTools,
 * ScheduleTools). The tool editor cannot change a namespace in place, so each is removed and added again as it was;
 * OpenCodeTools registers its description under `geocode` (patched), since an `opencode` namespace without tools would
 * still be in Code Mode's `tools`. An MCP server named `opencode` would have its tools moved too, as a server named
 * `geocode` shares the namespace.
 */
export const Namespace = {
  id: "geocode.tools.namespace",
  effect: Effect.fn("GeoTools.Namespace")(function* (ctx: Context) {
    yield* ctx.tool
      .transform((editor) => {
        const tools = editor.list().filter((tool) => tool.options?.namespace === upstream)
        if (tools.length === 0) return
        for (const { id, ...tool } of tools) {
          editor.remove(id)
          editor.add({ ...tool, options: { ...tool.options, namespace } })
        }
        editor.namespace({
          name: namespace,
          description:
            "Tools for managing GeoCode itself, such as working with sessions and worktrees, searching the available models, and reading MCP resources.",
        })
      })
      .pipe(Effect.orDie)
  }),
}

/**
 * GeoCode's geo tools, built in as OpenCode's own tools are: each asks the kernel's permission rules itself and then
 * has GeoEngine do the work. One plugin holds them all, so the upstream list registers it once. The interface knows
 * them by name, in desktop/packages/ui/src/geocode/geoTools.ts.
 */
export const Plugin = {
  id: "geocode.tools",
  effect: Effect.fn("GeoTools.Plugin")(function* (ctx: Context) {
    const permission = yield* Permission.Service
    const access = yield* FileAccess.Service
    const location = yield* Location.Service
    const saved = yield* PermissionSaved.Service
    const jobs = yield* Job.Service
    const runs = yield* GeeRunJob.Service
    const bus = yield* Bus.Service
    yield* ctx.rpc
      .register(GeeRunRpc.Definition, { list: () => runs.list, stop: ({ id }) => runs.stop(id) })
      .pipe(Effect.orDie)
    yield* ctx.tool
      .transform((editor) => {
        editor.add(QgisDocTool.make(permission))
        editor.add(ReadGeodataTool.make(access))
        editor.add(QgisRunTool.make(permission, access, location))
        editor.add(GeeRunTool.make(permission, access, location, ctx.storage, jobs, bus, runs))
        editor.add(OsmSearchTool.make(permission))
        editor.add(OsmProbeTool.make(permission, access))
        editor.add(OsmGetTools.makeObjects(permission, access, location))
        editor.add(OsmGetTools.makeFeatures(permission, access, location))
      })
      .pipe(Effect.orDie)
    // Where the rules allow qgisrun, an OSM download or a geo tool's read, a call outside the project, among others,
    // still asks.
    yield* ctx.permission.hook("evaluate", (event) =>
      !GeoGuards.applies(event)
        ? Effect.void
        : saved.list({ projectID: location.project.id }).pipe(
            Effect.map((rows) => {
              event.effect = GeoGuards.evaluate(event, rows)
            }),
          ),
    )
  }),
}
