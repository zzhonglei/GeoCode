/* --- GeoCode: the source scan in core/test/geocode-brand.test.ts can pass while a read still misses the branded
 * names (docs/PATHS.md §5). --- */
import { describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Brand } from "@opencode-ai/core/brand"
import { Global } from "@opencode-ai/core/global"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { ShareNext } from "@/share/share-next"
import { SessionID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import { Session } from "@/session/session"
import { provideInstanceEffect, testInstanceStoreLayer, TestInstance, tmpdirScoped } from "./fixture/fixture"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))

const write = (file: string, body: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, body)
  })

const withInstance = <A, E, R>(
  project: string,
  globalDir: string,
  effect: Effect.Effect<A, E, R>,
  node: Parameters<typeof LayerNode.compile>[0] = Config.node,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Global.Path.config
      ;(Global.Path as { config: string }).config = globalDir
      return previous
    }),
    () =>
      effect.pipe(
        Effect.provideService(TestInstance, { directory: project }),
        provideInstanceEffect(project),
        Effect.provide(testInstanceStoreLayer),
        Effect.provide(LayerNode.compile(node)),
      ),
    (previous) =>
      Effect.sync(() => {
        ;(Global.Path as { config: string }).config = previous
      }),
  )

/** A module that leaves a file behind if anything imports it. */
const witness = (marker: string) =>
  [
    `import fs from "fs"`,
    `fs.writeFileSync(${JSON.stringify(marker)}, "imported")`,
    `export const marker = { description: "witness", args: {}, execute: async () => "x" }`,
    `export default async () => ({})`,
    "",
  ].join("\n")

describe("GeoCode project config scope", () => {
  it.live("reads the branded project directory and ignores the upstream one", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const globalDir = yield* tmpdirScoped()
      const project = path.join(root, "project")

      yield* write(
        path.join(project, Brand.projectDir, Brand.configJson),
        JSON.stringify({ username: "from-geocode-dir" }),
      )
      yield* write(path.join(project, ".opencode", "opencode.json"), JSON.stringify({ username: "from-opencode-dir" }))

      yield* withInstance(
        project,
        globalDir,
        Effect.gen(function* () {
          const cfg = yield* Config.use.get()
          expect(cfg.username).toBe("from-geocode-dir")

          const dirs = yield* Config.use.directories()
          expect(dirs.some((dir) => dir.endsWith(Brand.projectDir))).toBe(true)
          expect(dirs.some((dir) => dir.endsWith(".opencode"))).toBe(false)
        }),
      )
    }),
  )

  it.live("reads a branded config file at the project root", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const globalDir = yield* tmpdirScoped()
      const project = path.join(root, "project")

      yield* write(path.join(project, Brand.configJson), JSON.stringify({ username: "from-project-root" }))
      yield* write(path.join(project, "opencode.json"), JSON.stringify({ username: "from-upstream-root" }))

      yield* withInstance(
        project,
        globalDir,
        Effect.gen(function* () {
          expect((yield* Config.use.get()).username).toBe("from-project-root")
        }),
      )
    }),
  )

  it.live("round-trips a branded global config file", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const globalDir = yield* tmpdirScoped()
      const project = path.join(root, "project")
      yield* Effect.promise(() => fs.mkdir(project, { recursive: true }))

      // The file `mcp add --global` writes (cli/cmd/mcp.ts) has to be the file the loader reads.
      yield* write(
        path.join(globalDir, Brand.configJson),
        JSON.stringify({ mcp: { probe: { type: "local", command: ["true"] } } }),
      )

      yield* withInstance(
        project,
        globalDir,
        Effect.gen(function* () {
          expect(Object.keys((yield* Config.use.get()).mcp ?? {})).toContain("probe")
        }),
      )
    }),
  )
})

/* --- GeoCode: a merge restoring any of upstream's plugin or tool loaders runs code from a folder the user only
 * opened (docs/KERNEL.md §6 items 1-2). --- */
describe("GeoCode does not run code from a project directory", () => {
  it.live("ignores declared plugins, discovered plugins and file tools", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const globalDir = yield* tmpdirScoped()
      const evidence = yield* tmpdirScoped()
      const project = path.join(root, "project")
      const dot = path.join(project, Brand.projectDir)

      const declared = path.join(dot, "declared.ts")
      yield* write(declared, witness(path.join(evidence, "declared")))
      yield* write(path.join(dot, "plugin", "auto.ts"), witness(path.join(evidence, "discovered")))
      yield* write(path.join(dot, "tool", "witness.ts"), witness(path.join(evidence, "tool")))
      yield* write(
        path.join(dot, Brand.configJson),
        JSON.stringify({ plugin: [`file://${declared.split(path.sep).join("/")}`] }),
      )

      let ids: string[] = []
      yield* withInstance(
        project,
        globalDir,
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          yield* plugin.init()
          ids = yield* (yield* ToolRegistry.Service).ids()
        }),
        LayerNode.group([Config.node, ToolRegistry.node, Plugin.node]),
      )

      expect(yield* Effect.promise(() => fs.readdir(evidence))).toEqual([])
      expect(ids).not.toContain("witness_marker")

      const left = yield* Effect.promise(() => fs.readdir(dot))
      for (const unwanted of ["node_modules", "package.json", "package-lock.json", ".gitignore"]) {
        expect(left).not.toContain(unwanted)
      }
    }),
  )
})

describe("GeoCode session sharing", () => {
  it.live("is disabled by the assembly layer, and stays overridable", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const globalDir = yield* tmpdirScoped()
      const project = path.join(root, "project")
      yield* Effect.promise(() => fs.mkdir(project, { recursive: true }))

      yield* withInstance(
        project,
        globalDir,
        Effect.gen(function* () {
          expect((yield* Config.use.get()).share).toBe("disabled")
        }),
      )

      yield* write(path.join(globalDir, Brand.configJson), JSON.stringify({ share: "manual" }))
      yield* withInstance(
        project,
        globalDir,
        Effect.gen(function* () {
          expect((yield* Config.use.get()).share).toBe("manual")
        }),
      )
    }),
  )

  it.live("and the gate at the network boundary answers for itself", () =>
    /* Only share/session.ts reads config, so if a user sets share this gate must refuse, not return an empty share. */
    Effect.gen(function* () {
      const result = yield* Effect.exit(ShareNext.use.create(SessionID.make("ses_gate_probe")))
      expect(Exit.isFailure(result)).toBe(true)
      const message = Exit.isFailure(result) ? Cause.squash(result.cause) : undefined
      expect(String(message)).toContain("OPENCODE_DISABLE_SHARE")
    }).pipe(Effect.provide(LayerNode.compile(ShareNext.node)), Effect.provide(testInstanceStoreLayer)),
  )
})

describe("GeoCode plan file scope", () => {
  it.effect("the written plan path is one the plan agent is allowed to edit", () =>
    Effect.gen(function* () {
      const worktree = path.join(path.sep, "tmp", "worktree")
      const written = Session.plan({ slug: "abc", time: { created: 1_700_000_000_000 } }, {
        worktree,
        project: { vcs: "git" },
      } as never)

      expect(written.startsWith(path.join(worktree, Brand.projectDir, "plans") + path.sep)).toBe(true)

      // Mirrors the plan agent's edit permission in agent/agent.ts.
      const pattern = path.join(...Brand.plansSegments, "*.md")
      expect(Wildcard.match(path.relative(worktree, written), pattern)).toBe(true)
    }),
  )
})
