export * as GeoTools from "./tools.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { FileAccess } from "../file-access.js"
import { Location } from "../location.js"
import { Permission } from "../permission.js"
import { PermissionSaved } from "../permission/saved.js"
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
    yield* ctx.tool
      .transform((editor) => {
        editor.add(QgisDocTool.make(permission))
        editor.add(ReadGeodataTool.make(access))
        editor.add(QgisRunTool.make(permission, access, location))
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
