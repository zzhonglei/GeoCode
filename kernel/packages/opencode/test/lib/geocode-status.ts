/* --- GeoCode: a geographic tool checks the environment before it prompts, so on a machine without QGIS nothing
 * past that check is reachable without fixed status answers (docs/TOOLS.md §3). --- */
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

/** Answers `undefined` for a slot it is not given, which tools read as not yet probed rather than as a refusal. */
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
