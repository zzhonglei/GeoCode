/* --- GeoCode: behavioural tripwires for the project-scope rename
 * (docs/PATHS.md §5). The literal scan in core/test/geocode-brand.test.ts
 * proves the patches are still in the source; these prove the live read and
 * write paths actually land on the branded names — the failure that motivated
 * them was a write path left on the old name while every reader had moved,
 * which typechecks and passes a literal scan but silently loses the file. --- */
import { describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Brand } from "@opencode-ai/core/brand"
import { Global } from "@opencode-ai/core/global"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { provideInstanceEffect, testInstanceStoreLayer, TestInstance, tmpdirScoped } from "./fixture/fixture"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))

const write = (file: string, body: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, body)
  })

const withInstance = <A, E, R>(project: string, globalDir: string, effect: Effect.Effect<A, E, R>) =>
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
        Effect.provide(LayerNode.compile(Config.node)),
      ),
    (previous) =>
      Effect.sync(() => {
        ;(Global.Path as { config: string }).config = previous
      }),
  )

describe("GeoCode project config scope", () => {
  it.live("reads the branded project directory and ignores the upstream one", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const globalDir = yield* tmpdirScoped()
      const project = path.join(root, "project")

      // Both laid down side by side. Only the branded one may take effect.
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

      // The name `mcp add --global` writes must be a name the loader reads.
      // These drifted apart once already: the writer stayed on opencode.json
      // while the loader moved to the branded names, so the server was written
      // and never seen.
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

describe("GeoCode plan file scope", () => {
  it.effect("the written plan path is one the plan agent is allowed to edit", () =>
    Effect.gen(function* () {
      const worktree = path.join(path.sep, "tmp", "worktree")
      const written = Session.plan({ slug: "abc", time: { created: 1_700_000_000_000 } }, {
        worktree,
        project: { vcs: "git" },
      } as never)

      expect(written.startsWith(path.join(worktree, Brand.projectDir, "plans") + path.sep)).toBe(true)

      // The invariant Brand.plansSegments exists to protect: the writer's path
      // and the permission glob are spread from the same array, so this holds
      // by construction — and goes red the moment either side takes a literal.
      const pattern = path.join(...Brand.plansSegments, "*.md")
      expect(Wildcard.match(path.relative(worktree, written), pattern)).toBe(true)
    }),
  )
})
