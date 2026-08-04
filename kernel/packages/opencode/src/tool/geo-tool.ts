import { Effect } from "effect"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import type { GeoQgis, GeoStatus } from "@/geo"

/* --- GeoCode: shared scaffolding for the geographic tools (docs/TOOLS.md §6).
 *
 * The responsibilities every geo tool carries — waiting out the gate's
 * intermediate states, rendering the environment header, turning a not-ready
 * status into guidance — live here once, next to tool.ts the way the geo tools
 * sit next to the native ones. Helpers take the service interfaces as
 * arguments: tools capture services at init, and their execute effects stay
 * requirement-free like every upstream tool. Carried only as far as the tools
 * that exist need it: this file grows with them, it does not anticipate
 * them. --- */

/**
 * The gate reports probing/resolving immediately instead of blocking
 * (GEOKERNEL §8.2); a tool that does not wait turns every cold start into a
 * "QGIS is not ready" answer, so the wait lives here, bounded.
 */
const SETTLE_LIMIT_MS = 60_000
const SETTLE_POLL_MS = 500

// Three intermediate shapes, not two: the unified gate also holds while a
// READY environment is still building its algorithm catalog (§4.9 — data
// reading waits for the catalog too). Missing that third shape turns every
// cold start into "not ready: ready".
const settling = (status: GeoEvent.QgisStatus) =>
  status.status === "probing" ||
  status.status === "resolving" ||
  (status.status === "ready" && status.catalog === "building")

export const settledQgisGate = Effect.fn("GeoTool.settledQgisGate")(function* (
  qgis: GeoQgis.Interface,
  abort?: AbortSignal,
) {
  const deadline = Date.now() + SETTLE_LIMIT_MS
  let gate = yield* qgis.gate()
  while (!gate.ok && settling(gate.status) && Date.now() < deadline && !abort?.aborted) {
    yield* Effect.sleep(SETTLE_POLL_MS)
    gate = yield* qgis.gate()
  }
  return gate
})

/**
 * The environment header for a ready QGIS, rendered from the status face's
 * facts — the verified environment object itself never leaves the kernel
 * (GEOKERNEL §9.1), and display must not reuse the complete subprocess env
 * anyway (§4.3 principle 8: execution needs completeness, display needs
 * safety). This renderer is the single exit for environment text in tool
 * output; anything redactable must pass GeoNet.NetRedact HERE (§11.2 — today
 * that is nothing: interpreter paths and version numbers only).
 *
 * The header is a prefix for the tool's RETURN VALUE only. Never send it
 * through ctx.metadata(): that path broadcasts live (§9.1 second hard rule).
 */
export const qgisHeader = Effect.fn("GeoTool.qgisHeader")(function* (status: GeoStatus.Interface) {
  const current = yield* status.current("qgis")
  if (!current || current.status !== "ready") return undefined
  const parts = [
    current.versions
      ? `QGIS ${current.versions.qgis} · GDAL ${current.versions.gdal} · Python ${current.versions.python}`
      : "QGIS ready",
    current.track ? `track ${current.track}` : undefined,
    current.interpreter,
  ].filter((part): part is string => part !== undefined)
  return `<geo_env>${parts.join(" · ")}</geo_env>`
})

/* No qgisUnavailable here on purpose: the not-ready guidance is authored by
 * the kernel (GeoQgis.QgisGuidance) so the whole QGIS group speaks with one
 * voice — the tool layer renders it, it never writes environment copy. */

export * as GeoTool from "./geo-tool"
