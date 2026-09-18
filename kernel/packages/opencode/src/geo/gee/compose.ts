export * as GeeCompose from "./compose"

import type { GeoEvent } from "@opencode-ai/schema/geo-event"

/* --- GeoCode: the three-layer composition, kept pure (docs/GEOKERNEL.md §5.6). --- */

/** Short-circuited in this order so attribution never lands on a layer downstream of one the user must fix first. */
export function facing(setup: GeoEvent.GeeSetup, network: GeoEvent.GeeNetwork): GeoEvent.GeeStatus["facing"] {
  if (setup.status !== "ready") return "setup"
  if (network.status !== "reachable") return "network"
  return "runtime"
}

export function compose(
  setup: GeoEvent.GeeSetup,
  network: GeoEvent.GeeNetwork,
  runtime: GeoEvent.GeeRuntime,
): GeoEvent.GeeStatus {
  return { facing: facing(setup, network), setup, network, runtime }
}
