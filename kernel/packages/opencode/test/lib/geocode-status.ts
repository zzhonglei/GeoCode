/* --- GeoCode: a status plane holding fixed answers, for tests about tools.
 *
 * New file rather than an addition to test/lib/effect.ts, which is upstream's —
 * the patch surface only counts files we modify (docs/KERNEL.md §4.1).
 *
 * **Why tools about permission now need one.** Every geographic tool checks the
 * environment BEFORE it raises a prompt (docs/TOOLS.md §4.3): a user must never
 * be asked to decide about an operation that cannot run either way. That makes
 * the environment a precondition for observing anything downstream of it —
 * which key a tool asks under, what its patterns look like, how far a call
 * gets. A test machine with no QGIS installed reaches none of it.
 *
 * Several tests used to rely on the opposite: they forced an UNCONFIGURED
 * environment on purpose, because it was the cheapest way to reach the ask and
 * stop. That shortcut is gone, and this is what replaces it.
 *
 * ⚠️ This is a stub, not a fake kernel. `current` is the only method with
 * behaviour; `register` merely has to work, because the kernel claims its slots
 * while the layer is coming up, long before any tool runs. --- */
import { Effect, Layer, Stream } from "effect"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import { GeoStatus } from "../../src/geo"

/** A QGIS install that resolved, with its algorithm catalog already built. */
export const QGIS_READY: GeoEvent.QgisStatus = {
  status: "ready",
  processing: true,
  catalog: "ready",
  interpreter: "/fake/qgis/bin/python3",
  versions: { python: "3.12.11", gdal: "3.12.0", qgis: "3.44.9" },
}

/** Earth Engine with all four setup steps done and a verified remote. */
export const GEE_READY: GeoEvent.GeeStatus = {
  facing: "runtime",
  setup: { status: "ready", python: "/fake/python3", project: "ee-demo", version: "1.7.24" },
  network: { status: "reachable", route: "direct" },
  runtime: { status: "valid", route: "direct" },
}

/**
 * A status plane answering exactly what it is given, and `undefined` elsewhere.
 *
 * `undefined` is deliberately the default: it means "nothing has probed yet",
 * which no tool treats as a failure — so a slot left out here cannot silently
 * turn into a refusal.
 */
export function statusHolding(values: { qgis?: GeoEvent.QgisStatus; gee?: GeoEvent.GeeStatus }) {
  return Layer.succeed(
    GeoStatus.Service,
    GeoStatus.Service.of({
      current: (slot: string) => Effect.succeed((values as Record<string, unknown>)[slot] as never),
      register: () =>
        Effect.succeed({ claim: () => Effect.succeed({} as never), publish: () => Effect.succeed(true) } as never),
      snapshot: () => Effect.succeed(values as never),
      watch: () => Stream.empty,
    } as never),
  )
}
