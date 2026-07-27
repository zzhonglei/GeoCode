export * as GeeCompose from "./compose"

import type { GeoEvent } from "@opencode-ai/schema/geo-event"

/* --- GeoCode: the three-layer composition (docs/GEOKERNEL.md §5.6).
 *
 * Pure by design, and the design says so: three facts in, one conclusion out,
 * holding nothing of its own. A fourth kind of fact would add a parameter here
 * and leave every existing state set untouched. --- */

/**
 * Which layer the user should be looking at.
 *
 * Local before network before remote, short-circuited — so the user faces
 * exactly one problem at a time, and the attribution cannot land on the wrong
 * layer. Reporting "credentials rejected" while the network is down would send
 * someone to re-authenticate over a connection that cannot carry the request.
 */
export function facing(setup: GeoEvent.GeeSetup, network: GeoEvent.GeeNetwork): GeoEvent.GeeStatus["facing"] {
  if (setup.status !== "ready") return "setup"
  if (network.status !== "reachable") return "network"
  return "runtime"
}

/** The three facts and the one to act on, as published. */
export function compose(
  setup: GeoEvent.GeeSetup,
  network: GeoEvent.GeeNetwork,
  runtime: GeoEvent.GeeRuntime,
): GeoEvent.GeeStatus {
  return { facing: facing(setup, network), setup, network, runtime }
}
