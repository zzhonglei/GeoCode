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
import { QgisDocTool } from "./qgisdoc.js"
import { QgisRunTool } from "./qgisrun.js"
import { ReadGeodataTool } from "./readgeodata.js"

/**
 * GeoCode's geo tools, built in as OpenCode's own tools are: each asks the kernel's permission rules itself and then
 * has GeoEngine do the work. One plugin holds them all, so the upstream list registers it once.
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
      })
      .pipe(Effect.orDie)
    // Where the rules allow qgisrun, a run of a listed algorithm, outside the project or into a database still asks.
    yield* ctx.permission.hook("evaluate", (event) =>
      event.action !== QgisRunTool.name || event.effect !== "allow"
        ? Effect.void
        : saved.list({ projectID: location.project.id }).pipe(
            Effect.map((rows) => {
              event.effect = QgisRunTool.evaluate(event, rows)
            }),
          ),
    )
  }),
}
