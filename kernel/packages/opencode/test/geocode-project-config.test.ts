/* --- GeoCode: behavioural tripwires for the project-scope rename
 * (docs/PATHS.md §5). The literal scan in core/test/geocode-brand.test.ts
 * proves the patches are still in the source; these prove the live read and
 * write paths actually land on the branded names — the failure that motivated
 * them was a write path left on the old name while every reader had moved,
 * which typechecks and passes a literal scan but silently loses the file. --- */
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

/* --- GeoCode: opening a folder must not run its code. Upstream imports both
 * `{plugin,plugins}/*.ts` and `{tool,tools}/*.ts` from every config directory,
 * through two independent paths; these witness modules write a file if anything
 * imports them, so the assertions below are evidence rather than inference
 * (docs/PATHS.md §7). --- */
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

      // Nothing imported any of the three, by either path. Asserted first:
      // this is the claim, and tool registration is only one of its symptoms.
      expect(yield* Effect.promise(() => fs.readdir(evidence))).toEqual([])
      expect(ids).not.toContain("witness_marker")

      // And nothing was installed into the user's project to support them.
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

      // The assembly layer is a factory default, not a lock: the config surface
      // is the user's to set, and setting it takes effect.
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
    /* Sharing is off in two places, and only one of them reads config. This
     * pins the other.
     *
     * The config default above exists so an attempt to share reports
     * "disabled in configuration" rather than the empty record upstream hands
     * back — but a user may set `share` to anything, and doing so removes that
     * message without moving this gate. Left as upstream wrote it, that path
     * ends in `share: { url: "" }` written onto the session: shared, at
     * nothing, with no error anywhere.
     *
     * Asserted on the message too, not just the failure. This gate opens only
     * for the env var, so a refusal that does not say which one leaves the user
     * with a working config option and no working share. */
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

      // The invariant Brand.plansSegments exists to protect: the writer's path
      // and the permission glob are spread from the same array, so this holds
      // by construction — and goes red the moment either side takes a literal.
      const pattern = path.join(...Brand.plansSegments, "*.md")
      expect(Wildcard.match(path.relative(worktree, written), pattern)).toBe(true)
    }),
  )
})
