export * as NetTypes from "./types"

/* --- GeoCode: the vocabulary of the Net module (docs/GEOKERNEL.md §3.3).
 *
 * Net owns every decision about network reachability: how a path is resolved,
 * when and how to probe, how long a verdict survives, and how to recover. The
 * capability modules read its conclusions and never compute their own (§8.3).
 *
 * These types are separate from the service so the sub-modules — probe,
 * discovery, resolver, monitor — can share them without importing one
 * another. --- */

/** A remote endpoint Net can be asked to reach. */
export interface Target {
  /** Stable name, used as the registry key and in status reporting. */
  readonly id: string
  readonly host: string
  readonly port: number
}

/**
 * A resolved way to reach a target.
 *
 * The proxy form keeps the URL COMPLETE, credentials included, because that is
 * what actually has to be used. Everything that leaves the module goes through
 * redaction instead — the two forms coexist rather than replacing each other
 * (§3.3, 凭据的双份形态).
 */
export type Route = { readonly kind: "direct" } | { readonly kind: "proxy"; readonly url: string }

/**
 * Stable identifier for a route, safe to publish.
 *
 * Consumers compare it to decide whether a conclusion of their own — a remote
 * authorization check, say — was reached over a path that still applies (§8.3).
 * Carries host and port so a failure stays diagnosable, and never any
 * credentials.
 */
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

/** Connectivity of one target. */
export type Reachability =
  /** Nobody is subscribed, so nothing is being probed (§3.3 按需驱动). */
  | { readonly state: "idle" }
  /** First probe since subscription, or a re-probe after the route was cleared. */
  | { readonly state: "checking" }
  | { readonly state: "reachable"; readonly route: RouteId }
  /**
   * `detail` is the underlying error and stays INSIDE — it is diagnostics, and
   * the wording a user reads is one sentence either way (see `FailureKind`).
   *
   * `tried` and `skipped` are the opposite: RouteIds and redacted addresses,
   * safe to publish by construction, and the only two facts that turn "cannot
   * be reached" into something a person can act on. A user who declared a SOCKS
   * proxy and a user with no network at all currently see the same three words.
   */
  | {
      readonly state: "unreachable"
      readonly detail?: string
      /** Paths actually attempted this round. */
      readonly tried?: readonly RouteId[]
      /**
       * Declarations that could not be attempted at all, named the same way
       * `routeId` names a route: `socks5:127.0.0.1:1080`. Built from parsed
       * fields rather than redacted, so a credential cannot be present.
       */
      readonly skipped?: readonly string[]
    }

/**
 * How a failure should be acted on.
 *
 * A binary split, and only to drive behaviour — never to produce wording. The
 * message a user sees for a network problem is one sentence either way; the
 * original error travels alongside as diagnostics (§3.3).
 */
export type FailureKind =
  /** An interface-level "there is no network" signal. Unambiguous, so no debounce. */
  | "offline"
  /** Timeouts, resets, refusals — anything that a flapping link also produces. */
  | "other"
