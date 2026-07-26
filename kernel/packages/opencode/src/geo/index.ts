export * as GeoKernel from "./index"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { MachineConfig } from "./config"
import { GeoStatus } from "./status"

export { MachineConfig } from "./config"
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
 * Infrastructure layer, in dependency order:
 *   config   `machine.json`: load, watch, dispatch per block            §3.1
 *   status   slot storage, generation-guarded commit, publication       §3.4
 *   runtime  subprocess primitives                          (not yet built)
 *   net      network reachability                           (not yet built)
 *
 * Capability layer — QGIS, GEE, OSM, GDAL — arrives on top of these. --- */
export const node = LayerNode.group([MachineConfig.node, GeoStatus.node])
