export * as ConfigPaths from "./paths"

import path from "path"
import { Brand } from "@opencode-ai/core/brand"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@opencode-ai/core/fs-util"

/** True when `dir` is a project config directory (docs/PATHS.md §5). */
export function isProjectDir(dir: string) {
  return path.basename(dir) === Brand.projectDir
}

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  return unique([
    Global.Path.config,
    ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [Brand.projectDir],
          start: directory,
          stop: worktree,
        })
      : []),
    /* --- GeoCode: upstream also scans `~/.opencode`, a second global root it
     * kept from before the XDG move. GeoCode has exactly one global root and
     * it is `Global.Path.config` above (docs/PATHS.md §3.1), so this scan is
     * removed rather than renamed — there is no `~/.geocode` to find. --- */
    ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
  ])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
