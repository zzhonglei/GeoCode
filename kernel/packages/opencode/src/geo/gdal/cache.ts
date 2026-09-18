export * as GdalCache from "./cache"

import { createHash } from "node:crypto"
import { rmSync, statSync } from "node:fs"
import path from "node:path"
import { Deferred, Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import type { GdalTypes } from "./types"

/* --- GeoCode: what a produced artifact belongs to, and how long it lives (docs/GEOKERNEL.md §7.6). --- */

export const ROOT = path.join(Global.Path.cache, "geo", "preview")

/** A shapefile's attributes and coordinate system live in these, so the `.shp` alone is not its identity. */
const SIDECARS = [".dbf", ".shx", ".prj", ".cpg"] as const

export interface Stamp {
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
}

export interface Source {
  readonly file: Stamp
  readonly sidecars: readonly Stamp[]
}

function stamp(file: string): Stamp {
  try {
    const info = statSync(file)
    return { path: file, size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    // Zeroes, not a throw: an absent companion is part of the identity, and one appearing later must move the key.
    return { path: file, size: 0, mtimeMs: 0 }
  }
}

/** Stats only, never content: this runs on every request that could hit the cache. */
export function describe(file: string): Source {
  const extension = path.extname(file).toLowerCase()
  const base = file.slice(0, file.length - extension.length)
  return {
    file: stamp(file),
    sidecars: extension === ".shp" ? SIDECARS.map((suffix) => stamp(base + suffix)) : [],
  }
}

export function key(source: Source, fingerprint: string): string {
  const material = JSON.stringify({
    file: source.file,
    sidecars: source.sidecars,
    fingerprint,
  })
  return createHash("sha256").update(material).digest("hex").slice(0, 16)
}

export function directory(track: GdalTypes.Track, key: string): string {
  return path.join(ROOT, track, key)
}

export const clear = Effect.sync(() => rmSync(ROOT, { recursive: true, force: true }))

/** `produce` runs in the merger's scope and callers only await it, so one interrupted caller cannot stop the rest. */
export const merger = <A, E>() =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const inflight = new Map<string, Deferred.Deferred<A, E>>()

    return (key: string, produce: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.suspend(() => {
        const existing = inflight.get(key)
        if (existing) return Deferred.await(existing)

        const deferred = Deferred.makeUnsafe<A, E>()
        inflight.set(key, deferred)
        const owned = produce.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              inflight.delete(key)
              Deferred.doneUnsafe(deferred, exit)
            }),
          ),
        )
        return Effect.forkIn(owned, scope).pipe(Effect.andThen(Deferred.await(deferred)))
      })
  })
