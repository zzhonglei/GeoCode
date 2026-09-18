import { Effect } from "effect"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import { GeoOutput } from "@/geo/runtime"
import type { GeeService, GeoQgis, GeoRuntime, GeoStatus } from "@/geo"

/* --- GeoCode: the parts the QGIS and GEE tools share (docs/TOOLS.md §6). Helpers take service interfaces as
 * arguments, since `Tool.Def.execute` has no requirement channel to yield them from. --- */

/** The gates answer with intermediate states rather than blocking, so the tools wait them out, bounded. */
const SETTLE_LIMIT_MS = 60_000
const SETTLE_POLL_MS = 500

// `ready` with the catalog still building is not settled either: the gate also wants the catalog.
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

/** A prefix for the tool's RETURN VALUE only, never `ctx.metadata()`, which broadcasts live (docs/TOOLS.md §2 #2). */
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

// A remote check in flight needs no waiting here: `gate` runs the serialized `validate` and returns with its answer.
const settlingGee = (status: GeoEvent.GeeStatus) =>
  status.setup.status === "checking" || (status.facing === "network" && status.network.status !== "unreachable")

/**
 * Rechecks before waiting: fixes such as installing packages never touch machine.json, so a tool retry is the only
 * signal a re-probe is due (GEOKERNEL §5.8). The round `recheck` starts is forked, hence one poll before the gate.
 */
export const settledGeeGate = Effect.fn("GeoTool.settledGeeGate")(function* (
  gee: GeeService.Interface,
  abort?: AbortSignal,
) {
  let gate = yield* gee.gate()
  if (gate.ok) return gate

  const deadline = Date.now() + SETTLE_LIMIT_MS
  if (yield* gee.recheck()) {
    yield* Effect.sleep(SETTLE_POLL_MS)
    gate = yield* gee.gate()
  }
  while (!gate.ok && settlingGee(gate.status) && Date.now() < deadline && !abort?.aborted) {
    yield* Effect.sleep(SETTLE_POLL_MS)
    gate = yield* gee.gate()
  }
  return gate
})

// A settled failure, so tools can refuse before the permission prompt (docs/TOOLS.md §3). No re-probe, unlike GEE:
// one would void and rebuild the catalog (GEOKERNEL §4.8).
const qgisStopped = (status: GeoEvent.QgisStatus) =>
  status.status !== "ready" && status.status !== "probing" && status.status !== "resolving"

export const qgisLocalDeadEnd = Effect.fn("GeoTool.qgisLocalDeadEnd")(function* (status: GeoStatus.Interface) {
  const current = yield* status.current("qgis")
  return current && qgisStopped(current) ? current : undefined
})

// `checking` is not a dead end: `settledGeeGate` waits it out.
const geeStopped = (status: GeoEvent.GeeStatus) => status.setup.status !== "ready" && status.setup.status !== "checking"

// Rechecks too: a refusal here returns before `settledGeeGate` is reached, so a just-fixed setup would stay refused.
export const geeLocalDeadEnd = Effect.fn("GeoTool.geeLocalDeadEnd")(function* (
  gee: GeeService.Interface,
  status: GeoStatus.Interface,
) {
  let current = yield* status.current("gee")
  if (!current || !geeStopped(current)) return undefined
  if (yield* gee.recheck()) {
    yield* Effect.sleep(SETTLE_POLL_MS)
    current = yield* status.current("gee")
  }
  return current && geeStopped(current) ? current : undefined
})

/** Only when fully usable: guidance for a network or authorization failure already names interpreter and project. */
export const geeHeader = Effect.fn("GeoTool.geeHeader")(function* (status: GeoStatus.Interface) {
  const current = yield* status.current("gee")
  if (!current || current.setup.status !== "ready") return undefined
  if (current.facing !== "runtime" || current.runtime.status !== "valid") return undefined
  // No route: it would tell the model about a proxy, which it must not reason toward when the network fails.
  const parts = [
    current.setup.version ? `GEE ${current.setup.version}` : "GEE ready",
    `project ${current.setup.project}`,
    current.setup.python,
  ].filter((part): part is string => part !== undefined)
  return `<geo_env>${parts.join(" · ")}</geo_env>`
})

/** The gate also refuses `ready` statuses, so those get a suffix rather than `error: true` beside a bare "ready". */
export function gateStatus(status: GeoEvent.QgisStatus): string {
  if (status.status !== "ready") return status.status
  if (!status.processing) return "ready:no-processing"
  if (status.catalog === "building") return "ready:catalog-building"
  if (status.catalog === "failed") return "ready:catalog-failed"
  if (status.catalog === "skipped") return "ready:catalog-skipped"
  return "ready"
}

/** Two parts, because one `facing` covers states that need different things from the user. */
export function geeGateStatus(status: GeoEvent.GeeStatus): string {
  switch (status.facing) {
    case "setup":
      return `setup:${status.setup.status}`
    case "network":
      return `network:${status.network.status}`
    case "runtime":
      return `runtime:${status.runtime.status}`
  }
}

/**
 * `abort` is said out loud: upstream completes a cancelled call with whatever the tool returned (session/tools.ts),
 * so silence would read as a failure.
 */
export function terminationBanner(reason: GeoRuntime.Reason, detail?: string): string {
  const body = detail?.trim()
  switch (reason) {
    case "abort":
      return "--- aborted ---\nUser cancelled execution."
    case "idle":
      return `--- timeout ---\nNo output for longer than the allowed idle time${body ? `\n${body}` : ""}`
    case "timeout":
      return `--- timeout ---\nThe total time limit elapsed${body ? `\n${body}` : ""}`
    case "output-limit":
      return `--- output limit ---\nThe process produced more output than the cap allows${body ? `\n${body}` : ""}`
    case "crash":
      return [
        "--- crashed ---",
        body,
        // Names no capability: QGIS and GEE crashes share this text.
        "The Python interpreter exited unexpectedly — typically a segfault inside a native library, which is",
        "below the Python level and cannot be caught by try/except in a script. On macOS the system may show",
        'a "python3 unexpectedly quit" dialog; that is the OS crash reporter and is safe to dismiss. This tool',
        "has already returned.",
      ]
        .filter(Boolean)
        .join("\n")
    case "exit":
      return body ? `--- stderr ---\n${body}` : ""
  }
}

/** Only for paths that spawned something: on a refusal it would tell the Agent the work ran. */
export function elapsedFooter(milliseconds: number): string {
  return `Elapsed: ${GeoOutput.formatDuration(milliseconds)}`
}

export * as GeoTool from "./geo-tool"
