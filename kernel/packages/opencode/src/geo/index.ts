export * as GeoKernel from "./index"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { MachineConfig } from "./config"
import { GdalService } from "./gdal"
import { GeeService } from "./gee"
import { GeoNet } from "./net"
import { GeoOsm } from "./osm"
import { GeoQgis } from "./qgis"
import { GeoRuntime } from "./runtime"
import { GeoStatus } from "./status"

export { MachineConfig } from "./config"
export { GdalService } from "./gdal"
export { GeeService } from "./gee"
export { GeoNet } from "./net"
export { GeoOsm } from "./osm"
export { GeoQgis } from "./qgis"
export { GeoRuntime } from "./runtime"
export { GeoStatus } from "./status"

/* --- GeoCode: GeoKernel, the geographic execution kernel — four infrastructure modules and the four capability
 * modules above them (docs/GEOKERNEL.md §2.2), mounted as one node so the host's service graph gains a single
 * line (§10.1 #4). --- */
export const node = LayerNode.group([
  MachineConfig.node,
  GeoRuntime.node,
  GeoNet.node,
  GeoStatus.node,
  GeoQgis.node,
  // A group member as well as GeoQgis.node's dependency, because both consumers §4.11 names sit in the tool layer:
  // compile() provides a node's deps to that node alone and merges group members outward, so as a dependency only
  // the catalog would exist with nothing outside able to ask for it. Same node object, so both routes get one of it.
  GeoQgis.QgisCatalog.node,
  GeeService.node,
  GeoOsm.node,
  GdalService.node,
])
