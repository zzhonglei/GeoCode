import { Effect } from "effect"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import { GeoOutput } from "@/geo/runtime"
import type { GeeService, GeoQgis, GeoRuntime, GeoStatus } from "@/geo"

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

/**
 * The GEE gate's own transient shapes.
 *
 * Narrower than QGIS's, because the layers below answer differently. A remote
 * check in flight needs no waiting here: `gate` calls `validate`, which is
 * serialized, so the call already blocks until there is a conclusion. What is
 * worth waiting on is a local probe running and a route not yet decided —
 * both of which a cold start passes through, and neither of which is an answer.
 */
const settlingGee = (status: GeoEvent.GeeStatus) =>
  status.setup.status === "checking" || (status.facing === "network" && status.network.status !== "unreachable")

/**
 * The GEE gate, waited out — and asked to look again first (§5.8 自愈重探).
 *
 * The re-probe is the half that cannot be left out. Three of the states a user
 * lands in are fixed OUTSIDE the configuration file: they install a package,
 * they run the authentication command. Nothing about either touches
 * machine.json, so the watcher never fires and the conclusion on file stays
 * "missing" no matter how long anyone waits. A tool retry is the only signal
 * that the world may have changed, and this is where it is treated as one —
 * without it, someone who has just done exactly what they were told is told
 * the same thing again.
 *
 * `recheck` answers whether it actually started one (it debounces, and it
 * declines states a re-probe cannot fix), and a started probe is worth one
 * poll interval before reading: it is forked, so the status has not
 * necessarily turned over by the time the call returns.
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

/**
 * The environment header for a usable Earth Engine.
 *
 * Two tiers where the old build had three, and the missing one is deliberate.
 * Its middle tier printed the interpreter, project, reason and raw error for
 * the post-setup blockers — because there the hint text and the environment
 * block were separate pieces and only the block carried those fields. Here the
 * guidance carries them itself, on exactly those states, so a second copy above
 * it would be the duplication the old build's first tier existed to avoid.
 *
 * What remains is the tier that has no other home: a run that reached the
 * interpreter and then failed on its own terms. Idle, abort, crash and a
 * non-zero exit all keep the Agent anchored to the environment the script was
 * actually running in, which nothing in the failure text would otherwise say.
 */
export const geeHeader = Effect.fn("GeoTool.geeHeader")(function* (status: GeoStatus.Interface) {
  const current = yield* status.current("gee")
  if (!current || current.setup.status !== "ready") return undefined
  if (current.facing !== "runtime" || current.runtime.status !== "valid") return undefined
  /* --- GeoCode: the route is deliberately NOT here.
   *
   * It used to be, as `route proxy:127.0.0.1:7890`. No credential is in a
   * `RouteId` by construction, so this was never a leak — but it put "this
   * machine is behind a proxy, on this port" into every single return, and the
   * copy rule for anything the model reads is that we do not mention proxies
   * at all. The rule exists because the model must not start reasoning toward
   * the proxy when the network fails; the simplification of that whole module
   * is deliberate, and a fact repeated every turn is exactly what gets reasoned
   * from. Diagnosis keeps the route — it rides the status plane, which the
   * interface reads and the model does not. --- */
  const parts = [
    current.setup.version ? `GEE ${current.setup.version}` : "GEE ready",
    `project ${current.setup.project}`,
    current.setup.python,
  ].filter((part): part is string => part !== undefined)
  return `<geo_env>${parts.join(" · ")}</geo_env>`
})

/**
 * The one field a caller switches on to learn WHY the gate is shut.
 *
 * The raw status name is not enough on its own. The gate wants ready AND
 * processing AND a built catalog (§4.9), so it refuses three shapes whose
 * status name is nonetheless `ready` — and a caller reading metadata alone
 * would get `error: true` next to `geoStatus: "ready"`, which reads as a
 * contradiction and names no cause. The reason lives in sibling fields of the
 * status, so it is folded in here rather than left for the prose to carry.
 */
export function gateStatus(status: GeoEvent.QgisStatus): string {
  if (status.status !== "ready") return status.status
  if (!status.processing) return "ready:no-processing"
  if (status.catalog === "building") return "ready:catalog-building"
  if (status.catalog === "failed") return "ready:catalog-failed"
  if (status.catalog === "skipped") return "ready:catalog-skipped"
  return "ready"
}

/**
 * The same one field for GEE, whose answer needs two parts rather than one.
 *
 * `facing` alone is not it. It says which of the three layers is in the way,
 * which is the right thing to READ FIRST and useless to act on: "setup" covers
 * both "no interpreter configured" and "not signed in", and a surface that
 * cannot tell those apart cannot offer the user anything but the same button
 * for both. The layer's own state is the other half, so both travel.
 */
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
 * How a subprocess ended, said in one sentence the Agent and the user both
 * read (GEOKERNEL §11.2 五种终止路径的横幅).
 *
 * Every geo tool that spawns anything renders its ending through here, because
 * the endings are a property of the RUNTIME, not of the capability: a cancelled
 * QGIS algorithm and a cancelled data read are the same event and must not
 * arrive as two different stories. The reasons are Runtime's own — presentation
 * is all that lives at this layer (§4.12).
 *
 * `abort` is the one that most needs saying out loud. Upstream does not
 * interrupt a tool on cancellation; it takes whatever the tool returns and
 * completes the call with it (session/tools.ts), so silence here would file the
 * user's own cancellation under "it failed". Upstream's own convention for this
 * is a plain sentence in the output (shell.ts), and this follows it.
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
      // The macOS note is not decoration: the OS crash reporter puts a dialog
      // in front of the user seconds after the tool has already returned, and
      // without this the Agent has no way to tell them it is safe to dismiss.
      return [
        "--- crashed ---",
        body,
        // Deliberately not "the QGIS interpreter": this renderer is shared, and
        // GEE runs its own Python. Naming one capability here would have the
        // other's crashes blaming software the user never invoked.
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

/**
 * The wall-clock footer, in the kernel's one duration format.
 *
 * Only ever appended by paths that actually started a subprocess: a synthetic
 * 0ms on a call that never spawned would tell the Agent the algorithm ran and
 * finished instantly, which is worse than saying nothing (§11.2 耗时页脚).
 */
export function elapsedFooter(milliseconds: number): string {
  return `Elapsed: ${GeoOutput.formatDuration(milliseconds)}`
}

export * as GeoTool from "./geo-tool"
