export * as GeoKernel from "./index"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { MachineConfig } from "./config"
import { GeoNet } from "./net"
import { GeoQgis } from "./qgis"
import { GeoRuntime } from "./runtime"
import { GeoStatus } from "./status"

export { MachineConfig } from "./config"
export { GeoNet } from "./net"
export { GeoQgis } from "./qgis"
export { GeoRuntime } from "./runtime"
export { GeoStatus } from "./status"

/* --- GeoCode: GeoKernel, the geographic execution kernel (docs/GEOKERNEL.md).
 *
 * A pure service layer carrying the product's geographic execution capability,
 * exposed through three faces: tools, status and data. Everything under this
 * directory is new code — the kernel above it is modified only at the injection
 * points listed in §10.1, each with a tripwire test.
 *
 * Mounted as ONE node so the service-graph injection stays a single line, which
 * is what keeps it cheap to carry across upstream merges (§2.4 principle 6).
 *
 * Infrastructure layer. The four are mutually independent — each depends only
 * on the host kernel — which is what lets them be built in any order:
 *   config   `machine.json`: load, watch, dispatch per block            §3.1
 *   runtime  subprocess execution: spawn, deliver, clock, terminate     §3.2
 *   status   slot storage, generation-guarded commit, publication       §3.4
 *   net      network reachability: resolve, probe, rank, monitor  §3.3
 *
 * Capability layer, on top of those:
 *   qgis     lifecycle, resolution, catalog, unified gate          §4
 *            (executor and scripts still to come — 2d)
 *   gee, osm, dataplane — not yet built. --- */
export const node = LayerNode.group([MachineConfig.node, GeoRuntime.node, GeoNet.node, GeoStatus.node, GeoQgis.node])
