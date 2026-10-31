export * as GeoGuards from "./guards.js"

import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import type { Permission } from "../permission.js"
import { Wildcard } from "../util/wildcard.js"
import { GeoOutside } from "./outside.js"
import { OsmGetTools } from "./osmget.js"
import { QgisRunTool } from "./qgisrun.js"

/**
 * The geo tools that ask about some calls even where the rules allow them: qgisrun about a listed algorithm, a write
 * outside the project or into a database, and the OSM downloads about a write outside the
 * project. A call names what it asks about in its asking's metadata, as `guards`.
 */
export const TOOLS: ReadonlySet<string> = new Set([QgisRunTool.name, OsmGetTools.objectsName, OsmGetTools.featuresName])

type Verdict = typeof Permission.Effect.Type

// Picked from upstream's own, so a field it drops fails here rather than leaving a read outside unasked.
type Evaluation = Pick<PermissionEvaluation, "action" | "effect" | "resources" | "metadata" | "source">

/** Whether the rules' verdict on this asking is one evaluate may change. */
export const applies = (event: Evaluation) =>
  event.effect === "allow" &&
  (TOOLS.has(event.action) || (event.action === "external_directory" && GeoOutside.asking(event.source?.id)))

/**
 * A guarded call asks where the rules allow its tool, unless "always allow" was given for each of its guards; so does
 * a geo tool's read outside the project, unless its directory was. A saved "*" allows the tool, not these.
 */
export const evaluate = (
  event: Evaluation,
  saved: ReadonlyArray<{ readonly action: string; readonly resource: string }>,
): Verdict => {
  if (!applies(event)) return event.effect
  const guards = event.action === "external_directory" ? event.resources : event.metadata?.guards
  if (!Array.isArray(guards)) return event.effect
  const kept = saved.filter((item) => item.action === event.action && item.resource !== "*")
  const allowed = guards.every(
    (guard) => typeof guard === "string" && kept.some((item) => Wildcard.match(guard, item.resource)),
  )
  return allowed ? "allow" : "ask"
}
