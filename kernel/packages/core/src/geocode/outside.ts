export * as GeoOutside from "./outside.js"

import { Effect } from "effect"

/** Calls reading a dataset outside the project for GeoAgent to see, by call id, while they ask about its directory. */
const reading = new Set<string>()

/** Whether the call asking about a directory outside the project is a geo tool's read, which GeoGuards asks about. */
export const asking = (id: string | undefined) => id !== undefined && reading.has(id)

/**
 * Asks about the directory of a dataset a geo tool reads for GeoAgent, as read asks, but where the rules allow it
 * too. The asking is read's own, through FileAccess, so it is known by the call that makes it rather than by anything
 * it carries.
 */
export const reads = <A, E, R>(context: { readonly id: string }, asked: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => reading.add(context.id)),
    () => asked,
    () => Effect.sync(() => reading.delete(context.id)),
  )
