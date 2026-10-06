export * as GeoTools from "./tools.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { FileAccess } from "../file-access.js"
import { Permission } from "../permission.js"
import { QgisDocTool } from "./qgisdoc.js"
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
    yield* ctx.tool
      .transform((editor) => {
        editor.add(QgisDocTool.make(permission))
        editor.add(ReadGeodataTool.make(access))
      })
      .pipe(Effect.orDie)
  }),
}
