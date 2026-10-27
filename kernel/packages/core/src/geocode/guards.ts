export * as GeoGuards from "./guards.js"

import type { Permission } from "../permission.js"
import { Wildcard } from "../util/wildcard.js"
import { OsmGetTools } from "./osmget.js"
import { QgisRunTool } from "./qgisrun.js"

/**
 * The geo tools that ask about some calls even where the rules allow them: qgisrun about a listed algorithm, a write
 * outside the project or into a database, and the OSM downloads about a write outside the
 * project. A call names what it asks about in its asking's metadata, as `guards`.
 */
export const TOOLS: ReadonlySet<string> = new Set([QgisRunTool.name, OsmGetTools.objectsName, OsmGetTools.featuresName])

type Verdict = typeof Permission.Effect.Type

/**
 * A guarded call asks where the rules allow its tool, unless "always allow" was given for each of its guards. A saved
 * "*" allows the tool, not these.
 */
export const evaluate = (
  event: { readonly action: string; readonly effect: Verdict; readonly metadata?: Record<string, unknown> },
  saved: ReadonlyArray<{ readonly action: string; readonly resource: string }>,
): Verdict => {
  const guards = event.metadata?.guards
  if (!TOOLS.has(event.action) || event.effect !== "allow" || !Array.isArray(guards)) return event.effect
  const kept = saved.filter((item) => item.action === event.action && item.resource !== "*")
  const allowed = guards.every(
    (guard) => typeof guard === "string" && kept.some((item) => Wildcard.match(guard, item.resource)),
  )
  return allowed ? "allow" : "ask"
}
