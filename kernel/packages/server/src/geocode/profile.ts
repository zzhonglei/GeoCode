export * as GeoCodeProfile from "./profile"

import path from "path"
import { Effect, Layer } from "effect"
import { Config } from "@opencode/core/config"
import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Location } from "@opencode/core/location"
import { WellKnown } from "@opencode/core/wellknown"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import type { ServerOptions } from "../options"

const managedPlugins = (file: string | undefined) => {
  // Must equal the explicit document's path, which ConfigDiscovery resolves the same way.
  const managed = file ? path.resolve(file) : undefined
  return makeLocationNode({
    service: ConfigPluginSource.Service,
    layer: ConfigPluginSource.layer.pipe(
      Layer.provide(
        Layer.effect(
          Config.Service,
          Effect.gen(function* () {
            const config = yield* Config.Service
            return Config.Service.of({
              ...config,
              entries: () =>
                config
                  .entries()
                  .pipe(
                    Effect.map((entries) =>
                      entries.filter(
                        (entry) => managed !== undefined && entry.type === "document" && entry.path === managed,
                      ),
                    ),
                  ),
            })
          }),
        ),
      ),
    ),
    deps: [Config.node, FSUtil.node, Watcher.node, Location.node],
  })
}

const noRemoteConfig = Layer.succeed(
  WellKnown.Service,
  WellKnown.Service.of({
    entries: () => Effect.succeed([]),
    snapshot: () => [],
    refresh: () => Effect.succeed(false),
    add: (origin) => Effect.fail(new Error(`Remote config is not available: ${origin}`)),
    remove: () => Effect.void,
    resolve: () => Effect.succeed([]),
    cached: () => Effect.succeed([]),
  }),
)

// routes.ts's standard Config options plus `system: false`: no machine-wide directory or MDM preferences.
const noMachineConfig = (options: ServerOptions) =>
  Config.configured({
    project: options.config?.project,
    claude: options.config?.claude,
    file: options.config?.file,
    content: options.config?.content,
    system: false,
  })

export function replacements(options: ServerOptions): LayerNode.Replacements {
  return [
    Config.node.replace(noMachineConfig(options)),
    ConfigPluginSource.node.replace(managedPlugins(options.config?.file)),
    WellKnown.node.replace(noRemoteConfig),
  ]
}
