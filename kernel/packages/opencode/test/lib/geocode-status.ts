/* --- GeoCode: a status plane holding fixed answers, for tests about tools.
 *
 * New file rather than an addition to test/lib/effect.ts, which is upstream's —
 * the patch surface only counts files we modify (docs/KERNEL.md §4.1).
 *
 * A geographic tool checks the environment before it raises a prompt
 * (docs/TOOLS.md §3), so on a machine with no QGIS nothing downstream of that
 * check is reachable without a status plane like this one.
 *
 * A stub, not a fake kernel: `current` is the only method with behaviour, and
 * `register` merely has to work, because the kernel claims its slots while the
 * layer is coming up. --- */
import { Effect, Layer, Stream } from "effect"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import { GeoStatus } from "../../src/geo"

export const QGIS_READY: GeoEvent.QgisStatus = {
  status: "ready",
  processing: true,
  catalog: "ready",
  interpreter: "/fake/qgis/bin/python3",
  versions: { python: "3.12.11", gdal: "3.12.0", qgis: "3.44.9" },
}

export const GEE_READY: GeoEvent.GeeStatus = {
  facing: "runtime",
  setup: { status: "ready", python: "/fake/python3", project: "ee-demo", version: "1.7.24" },
  network: { status: "reachable", route: "direct" },
  runtime: { status: "valid", route: "direct" },
}

/**
 * A status plane answering exactly what it is given, and `undefined` elsewhere — which reads as "nothing has
 * probed yet" and no tool treats as a failure, so a slot left out here cannot turn into a refusal.
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
