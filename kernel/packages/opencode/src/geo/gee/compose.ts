export * as GeeCompose from "./compose"

import type { GeoEvent } from "@opencode-ai/schema/geo-event"

/* --- GeoCode: the three-layer composition (docs/GEOKERNEL.md §5.6). Pure: three facts in, one conclusion out,
 * holding nothing of its own, so a fourth kind of fact adds a parameter here and rearranges no state set. --- */

/**
 * Which layer the user should be looking at — local before network before remote, short-circuited, so the
 * attribution cannot land on a layer whose problem is downstream of one the user has to fix first.
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
