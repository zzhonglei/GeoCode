export * as NetTypes from "./types"

/* --- GeoCode: the Net module's shared types, apart from index.ts so the submodules can import them without a cycle
 * (docs/GEOKERNEL.md §3.3). --- */

export interface Target {
  /** Stable: it is the registry key, and it appears in status reporting. */
  readonly id: string
  readonly host: string
  readonly port: number
}

/** The proxy URL keeps its credentials because it is what gets used; `NetRedact` is the form to use wherever it
 * does leave the module. */
export type Route = { readonly kind: "direct" } | { readonly kind: "proxy"; readonly url: string }

/** Safe to publish: it carries host and port, never credentials. */
export type RouteId = string

export function routeId(route: Route): RouteId {
  if (route.kind === "direct") return "direct"
  try {
    const url = new URL(route.url)
    return `proxy:${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`
  } catch {
    return "proxy:unparseable"
  }
}

export type Reachability =
  /** Nobody is subscribed, so nothing is being probed. */
  | { readonly state: "idle" }
  /** Subscribed, and the first probe has not answered yet. */
  | { readonly state: "checking" }
  | { readonly state: "reachable"; readonly route: RouteId }
  /** `detail` is the raw error, kept as diagnostics; `tried` and `skipped` are published, so neither may carry a
   * credential. */
  | {
      readonly state: "unreachable"
      readonly detail?: string
      /** Paths actually attempted this round. */
      readonly tried?: readonly RouteId[]
      /** Declarations that could not be attempted at all, named from scheme, host and port only. */
      readonly skipped?: readonly string[]
    }

/** Drives behaviour only, never wording (docs/GEOKERNEL.md §3.3). */
export type FailureKind =
  /** An interface-level "there is no network" signal. Unambiguous, so no debounce. */
  | "offline"
  /** Timeouts, resets, refusals — anything that a flapping link also produces. */
  | "other"
