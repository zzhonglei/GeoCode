import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { Credential } from "@opencode/core/credential"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { emptyCredentialNode } from "../../../core/test/fixture/config-nodes"
import { location } from "../../../core/test/fixture/location"
import { tmpdir } from "../../../core/test/fixture/tmpdir"
import { it } from "../../../core/test/lib/effect"
import { GeoCodeProfile } from "../../src/geocode/profile"

// A global directory and a project that each carry a plugin directory and a `plugins` list, plus the managed file,
// named through a symlinked directory so its lexical and real paths differ.
const seed = async (root: string) => {
  const global = path.join(root, "global")
  const project = path.join(root, "project")
  for (const directory of [global, project]) {
    await fs.mkdir(path.join(directory, "plugins"), { recursive: true })
    await fs.writeFile(path.join(directory, "plugins", "discovered.js"), "export default {}\n")
  }
  await fs.mkdir(path.join(project, ".opencode", "plugins"), { recursive: true })
  await fs.writeFile(path.join(project, ".opencode", "plugins", "discovered.js"), "export default {}\n")
  await fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ plugins: ["global-npm-plugin"] }))
  await fs.writeFile(path.join(project, "opencode.json"), JSON.stringify({ plugins: ["project-npm-plugin"] }))
  await fs.writeFile(
    path.join(root, "managed.json"),
    JSON.stringify({ plugins: [path.join(root, "shell-tool"), "-opencode.browser"] }),
  )
  await fs.symlink(root, path.join(root, "link"))
  return { root, global, project, managed: path.join(root, "link", "managed.json") }
}

const operations = (paths: { root: string; global: string; project: string }, options: Config.Options) =>
  Effect.gen(function* () {
    const source = yield* ConfigPluginSource.Service
    return (yield* Effect.scoped(source.operations())).map((operation) => `${operation.type}:${operation.target}`)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([ConfigPluginSource.node, Bus.node]), [
        ...GeoCodeProfile.replacements({ config: { file: options.file } }),
        Config.node.replace(Config.configured(options)),
        Location.node.replace(
          Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(paths.project) })),
          ),
        ),
        Global.node.replace(
          Global.layerWith({
            config: paths.global,
            home: path.join(paths.root, "home"),
            data: path.join(paths.root, "data"),
            cache: path.join(paths.root, "cache"),
            state: path.join(paths.root, "state"),
            tmp: path.join(paths.root, "tmp"),
            bin: path.join(paths.root, "cache", "bin"),
            log: path.join(paths.root, "data", "log"),
            repos: path.join(paths.root, "data", "repos"),
          }),
        ),
        Credential.node.replace(emptyCredentialNode),
        Watcher.node.replace(Watcher.testLayer),
      ]),
    ),
  )

it.live("GeoCode: takes plugin operations only from the managed config file", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir()))
    const paths = yield* Effect.promise(() => seed(tmp.path))
    expect(yield* operations(paths, { file: paths.managed })).toEqual([
      `add:${path.join(tmp.path, "shell-tool")}`,
      "remove:opencode.browser",
    ])
  }),
)

it.live("GeoCode: takes no plugin operations without a managed config file", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir()))
    const paths = yield* Effect.promise(() => seed(tmp.path))
    expect(yield* operations(paths, { content: JSON.stringify({ plugins: ["content-npm-plugin"] }) })).toEqual([])
  }),
)
