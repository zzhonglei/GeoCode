export * as GdalCache from "./cache"

import { createHash } from "node:crypto"
import { rmSync, statSync } from "node:fs"
import path from "node:path"
import { Deferred, Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import type { GdalTypes } from "./types"

/* --- GeoCode: what a produced artifact belongs to, and how long it lives
 * (docs/GEOKERNEL.md §7.6).
 *
 * Two jobs. The KEY decides when a cached artifact still describes its source,
 * and getting it too loose serves stale data while getting it too tight throws
 * away work the user is waiting on. The LIFETIME is deliberately blunt:
 * everything goes at startup, which buys a cache that cannot grow without
 * bound and — the reason that matters more — measurements that reflect what a
 * real user's first view costs, since a warm cache makes first-view questions
 * unaskable. --- */

/** Everything lives under one root so the startup wipe is a single removal. */
export const ROOT = path.join(Global.Path.cache, "geo", "preview")

/**
 * Companions that carry part of a dataset's content.
 *
 * A shapefile is a dataset spread across files, and its geometry, attributes
 * and coordinate system each live in a different one. Keying on the `.shp`
 * alone would serve a cached preview after the user replaced the attribute
 * table — the file the key watched never changed (§7.6).
 */
const SIDECARS = [".dbf", ".shx", ".prj", ".cpg"] as const

export interface Stamp {
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
}

/** The identity of one source file: itself, plus anything that is part of it. */
export interface Source {
  readonly file: Stamp
  readonly sidecars: readonly Stamp[]
}

function stamp(file: string): Stamp {
  try {
    const info = statSync(file)
    return { path: file, size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    // A companion that is absent is a fact about the dataset, and one that
    // appears later must change the key. Zeroes say "not there" without
    // needing a second shape.
    return { path: file, size: 0, mtimeMs: 0 }
  }
}

/**
 * Describe a source file as the cache sees it.
 *
 * Reads only directory entries, never content — this runs before every request
 * that could hit the cache, so it has to cost nothing.
 */
export function describe(file: string): Source {
  const extension = path.extname(file).toLowerCase()
  const base = file.slice(0, file.length - extension.length)
  return {
    file: stamp(file),
    // Only for the formats that have them. Stat-ing four paths that will never
    // exist on every GeoTIFF request is work for nobody.
    sidecars: extension === ".shp" ? SIDECARS.map((suffix) => stamp(base + suffix)) : [],
  }
}

/**
 * The cache key for a source under a given toolchain.
 *
 * Size AND modification time, not either alone: an edit that preserves length
 * is ordinary in a shapefile's attribute table, and a restored backup can
 * carry an older timestamp at the same size. The toolchain fingerprint is in
 * there too, so changing which GDAL is configured retires the artifacts built
 * by the previous one rather than serving them from a build that is gone.
 */
export function key(source: Source, fingerprint: string): string {
  const material = JSON.stringify({
    file: source.file,
    sidecars: source.sidecars,
    fingerprint,
  })
  return createHash("sha256").update(material).digest("hex").slice(0, 16)
}

/** Where one source's artifacts live. One directory per key, per track. */
export function directory(track: GdalTypes.Track, key: string): string {
  return path.join(ROOT, track, key)
}

/**
 * Remove every artifact. Called once, when the application starts.
 *
 * Blunt on purpose (§7.6). A cache that survives restarts needs a size budget
 * and an eviction policy, and it makes the questions this module exists to
 * answer — how long does a first view take, is the intermediate state visible
 * — impossible to ask again after the first run.
 */
export const clear = Effect.sync(() => rmSync(ROOT, { recursive: true, force: true }))

/**
 * Run an effect once per key, however many callers ask at the same time.
 *
 * The interface can easily ask twice for one file — a click, a re-render, two
 * panels showing the same layer — and each production is subprocesses and
 * seconds. Latecomers join the work already running rather than starting their
 * own, and a failure is shared the same way, since a second attempt would only
 * have reproduced it.
 *
 * **The work belongs to this module, not to whoever triggered it.** Running it
 * on the first caller's fiber would mean that caller giving up — a browser tab
 * closing, a request cancelled — takes down everyone waiting on the same
 * artifact. Every caller, the first included, only ever awaits.
 *
 * The entry is dropped the moment the work settles, so this merges exactly the
 * window where callers would have duplicated each other and never becomes a
 * second result cache with no invalidation rule of its own.
 */
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
