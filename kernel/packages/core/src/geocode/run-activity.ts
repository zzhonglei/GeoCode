export * as GeoRunActivity from "./run-activity.js"

import { Effect } from "effect"
import { LocationServiceMap } from "../location-service-map.js"
import type { Location } from "../location.js"

/**
 * How many geographic runs each location has under way in the foreground, keyed as the idle sweep keys locations. The
 * module's own state rather than a service, so the sweep reads it without a dependency of its own.
 */
const running = new Map<string, number>()
const key = (ref: Location.Ref) => `${LocationServiceMap.canonical(ref).directory}\0${ref.workspaceID ?? ""}`

/** Whether a run is under way at the location, which the idle sweep then leaves alone. */
export const isActive = (ref: Location.Ref) => running.has(key(ref))

/** Counts a run at the location for as long as the scope is open. */
export const hold = (ref: Location.Ref) => {
  const id = key(ref)
  return Effect.acquireRelease(
    Effect.sync(() => void running.set(id, (running.get(id) ?? 0) + 1)),
    () =>
      Effect.sync(() => {
        const left = (running.get(id) ?? 0) - 1
        if (left > 0) running.set(id, left)
        else running.delete(id)
      }),
  )
}
