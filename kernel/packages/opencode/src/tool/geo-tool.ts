import { Effect } from "effect"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import { GeoOutput } from "@/geo/runtime"
import type { GeeService, GeoQgis, GeoRuntime, GeoStatus } from "@/geo"

/* --- GeoCode: the parts the QGIS and GEE tools share (docs/TOOLS.md §6).
 *
 * Every helper takes a service interface as an argument rather than yielding it: `Tool.Def.execute` has no
 * requirement channel, so each tool captures its services once at init (docs/TOOLS.md §2 #5). --- */

/** The gate returns intermediate states rather than blocking (GEOKERNEL §8.2), so waiting them out is the tool
 * layer's job — bounded, or a cold start would hang instead of answering. */
const SETTLE_LIMIT_MS = 60_000
const SETTLE_POLL_MS = 500

// A ready environment whose catalog is still building is the third intermediate shape: the gate wants the
// catalog too (§4.9), so `status === "ready"` on its own does not mean settled.
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
 * Rendered from the status face rather than from the environment object, which never leaves the kernel
 * (GEOKERNEL §9.1). A prefix for the tool's RETURN VALUE only — `ctx.metadata()` broadcasts live
 * (docs/TOOLS.md §2 #2).
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

/* No qgisUnavailable here: the not-ready copy is authored in the kernel (GeoQgis.QgisGuidance) so the whole QGIS
 * group speaks with one voice, and this layer only renders it. */

/* Narrower than QGIS's because a remote check in flight needs no waiting: `gate` calls `validate`, which is
 * serialized, so the caller is already blocked until there is a conclusion. What is left to wait out is a setup
 * probe still running and a network verdict that has not yet come back `unreachable`. */
const settlingGee = (status: GeoEvent.GeeStatus) =>
  status.setup.status === "checking" || (status.facing === "network" && status.network.status !== "unreachable")

/**
 * Asks the layers below to look again before waiting (§5.8 自愈重探): the fixes for the self-healing setup states
 * are actions in a terminal that never touch machine.json, so the config watcher cannot notice them and a tool
 * retry is the only signal there is. `recheck` answers whether it actually started a round — it debounces, and
 * declines states a re-probe cannot fix — and that round is forked, hence one poll before reading the gate again.
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

/* An already-settled failure — probing and resolving excluded — so a tool can refuse before the permission
 * prompt (docs/TOOLS.md §3). No re-probe, unlike the GEE twin below: QGIS deliberately has none, because one
 * drags a full catalog rebuild with it and nearly every QGIS fix goes through machine.json (GEOKERNEL §4.8). */
const qgisStopped = (status: GeoEvent.QgisStatus) =>
  status.status !== "ready" && status.status !== "probing" && status.status !== "resolving"

export const qgisLocalDeadEnd = Effect.fn("GeoTool.qgisLocalDeadEnd")(function* (status: GeoStatus.Interface) {
  const current = yield* status.current("qgis")
  return current && qgisStopped(current) ? current : undefined
})

/* The GEE twin, and the re-probe is why it is a helper rather than a status read at the call site: this path
 * returns before `settledGeeGate` — the other place that re-probes — is ever reached, so without it a user who
 * has just installed the packages gets the stale verdict back forever (§5.8).
 *
 * `checking` is not a dead end: it is the state `settledGeeGate` exists to wait out. Nor is a missing status. */
const geeStopped = (status: GeoEvent.GeeStatus) => status.setup.status !== "ready" && status.setup.status !== "checking"

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

/**
 * Only for an environment that is entirely usable: on the post-setup blockers the GEE guidance already carries the
 * interpreter, project and reason itself, so a header above it would be a second copy. What is left is a run that
 * reached the interpreter and then failed on its own terms, where nothing else says which environment it was in.
 */
export const geeHeader = Effect.fn("GeoTool.geeHeader")(function* (status: GeoStatus.Interface) {
  const current = yield* status.current("gee")
  if (!current || current.setup.status !== "ready") return undefined
  if (current.facing !== "runtime" || current.runtime.status !== "valid") return undefined
  /* The route is deliberately absent. A `RouteId` holds no credential, so it was never a leak, but it would put
   * "this machine is behind a proxy, on this port" into every return — and the model must not start reasoning
   * toward the proxy when the network fails. Diagnosis keeps it: the status plane is read by the interface, not
   * by the model. */
  const parts = [
    current.setup.version ? `GEE ${current.setup.version}` : "GEE ready",
    `project ${current.setup.project}`,
    current.setup.python,
  ].filter((part): part is string => part !== undefined)
  return `<geo_env>${parts.join(" · ")}</geo_env>`
})

/**
 * Why the gate is shut, in one field. The gate wants ready AND processing AND a built catalog (§4.9), so it
 * refuses several shapes whose status name is nonetheless `ready`, and the name alone would put `error: true`
 * next to `geoStatus: "ready"` in metadata — a contradiction naming no cause.
 */
export function gateStatus(status: GeoEvent.QgisStatus): string {
  if (status.status !== "ready") return status.status
  if (!status.processing) return "ready:no-processing"
  if (status.catalog === "building") return "ready:catalog-building"
  if (status.catalog === "failed") return "ready:catalog-failed"
  if (status.catalog === "skipped") return "ready:catalog-skipped"
  return "ready"
}

/** Two parts, because `facing` alone says only which layer is in the way: `setup` covers both "no interpreter
 * configured" and "not signed in", which need different things from the user. */
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
 * The five terminations, rendered once for the whole geo group (GEOKERNEL §11 五种终止路径的横幅). `abort` needs
 * saying out loud: upstream does not interrupt a cancelled tool, it completes the call with whatever the tool
 * returned (session/tools.ts), so silence would file the user's own cancellation under "it failed" — `shell`
 * answers the same event with a plain sentence in the output.
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
        // Not "the QGIS interpreter": this renderer is shared, and GEE runs its own Python, so naming one
        // capability would have the other's crashes blaming software the user never invoked.
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

/** Only for paths that actually spawned something (§11 耗时页脚): a synthetic 0ms on a call that never got that
 * far would tell the Agent the work ran and finished instantly. */
export function elapsedFooter(milliseconds: number): string {
  return `Elapsed: ${GeoOutput.formatDuration(milliseconds)}`
}

export * as GeoTool from "./geo-tool"
