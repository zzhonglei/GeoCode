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

/* --- GeoCode: GeoKernel as one node, so the host's service graph gains a single line
 * (docs/GEOKERNEL.md §10.1 #4). --- */
export const node = LayerNode.group([
  MachineConfig.node,
  GeoRuntime.node,
  GeoNet.node,
  GeoStatus.node,
  GeoQgis.node,
  // Listed here as well as under GeoQgis.node: compile() provides a node's deps to that node alone, and the tools
  // need the catalog too. The same node object compiles once.
  GeoQgis.QgisCatalog.node,
  GeeService.node,
  GeoOsm.node,
  GdalService.node,
])
