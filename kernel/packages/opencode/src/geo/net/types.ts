export * as NetTypes from "./types"

/* --- GeoCode: the vocabulary of the Net module (docs/GEOKERNEL.md §3.3).
 *
 * Separate from the service so probe, discovery, resolver and monitor can share it without importing one
 * another. --- */

export interface Target {
  /** Stable: it is the registry key, and it appears in status reporting. */
  readonly id: string
  readonly host: string
  readonly port: number
}

/**
 * The proxy form keeps the URL complete, credentials included, because that is what has to be used; the redacted
 * form coexists with it rather than replacing it, and everything leaving the module goes through that one
 * (§3.3, 凭据的双份形态).
 */
export type Route = { readonly kind: "direct" } | { readonly kind: "proxy"; readonly url: string }

/** Safe to publish. Consumers compare it to tell whether a conclusion of their own still applies (§8.3). */
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
  /** Nobody is subscribed, so nothing is being probed (§3.3 按需驱动). */
  | { readonly state: "idle" }
  /** First probe since subscription, or a re-probe after the route was cleared. */
  | { readonly state: "checking" }
  | { readonly state: "reachable"; readonly route: RouteId }
  /**
   * `detail` is the underlying error and stays inside, as diagnostics; `tried` and `skipped` are safe to publish
   * by construction, and are the only two facts that turn "cannot be reached" into something a person can act on.
   */
  | {
      readonly state: "unreachable"
      readonly detail?: string
      /** Paths actually attempted this round. */
      readonly tried?: readonly RouteId[]
      /**
       * Declarations that could not be attempted at all, built from parsed fields rather than redacted from the
       * raw value, so a credential cannot be present.
       */
      readonly skipped?: readonly string[]
    }

/**
 * A binary split, and only to drive behaviour — never to produce wording: the message a user sees for a network
 * problem is one sentence either way, with the original error travelling alongside as diagnostics (§3.3).
 */
export type FailureKind =
  /** An interface-level "there is no network" signal. Unambiguous, so no debounce. */
  | "offline"
  /** Timeouts, resets, refusals — anything that a flapping link also produces. */
  | "other"
