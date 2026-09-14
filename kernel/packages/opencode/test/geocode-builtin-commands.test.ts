/* --- GeoCode: the kernel registers neither built-in init nor review but does register the set command GeoCode
 * ships, and a command the user configures under any of these names still registers (docs/KERNEL.md §5.5, §6). --- */
import { describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Brand } from "@opencode-ai/core/brand"
import { Global } from "@opencode-ai/core/global"
import { Command } from "@/command"
import { provideInstanceEffect, testInstanceStoreLayer, TestInstance, tmpdirScoped } from "./fixture/fixture"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))

const listCommands = (project: string, globalDir: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Global.Path.config
      ;(Global.Path as { config: string }).config = globalDir
      return previous
    }),
    () =>
      Effect.gen(function* () {
        const commands = yield* Command.Service
        return yield* commands.list()
      }).pipe(
        Effect.provideService(TestInstance, { directory: project }),
        provideInstanceEffect(project),
        Effect.provide(testInstanceStoreLayer),
        Effect.provide(LayerNode.compile(Command.node)),
      ),
    (previous) =>
      Effect.sync(() => {
        ;(Global.Path as { config: string }).config = previous
      }),
  )

const emptyProject = Effect.gen(function* () {
  const root = yield* tmpdirScoped({ git: true })
  const project = path.join(root, "project")
  yield* Effect.promise(() => fs.mkdir(project, { recursive: true }))
  return project
})

const writeProjectCommand = (project: string, name: string, description: string) =>
  Effect.promise(async () => {
    const file = path.join(project, Brand.projectDir, "command", `${name}.md`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, `---\ndescription: ${description}\n---\nCheck the projection of every layer.\n`)
  })

describe("GeoCode built-in commands", () => {
  it.live("lists neither the built-in init nor the built-in review", () =>
    Effect.gen(function* () {
      const project = yield* emptyProject
      const names = (yield* listCommands(project, yield* tmpdirScoped())).map((command) => command.name)
      expect(names).not.toContain("init")
      expect(names).not.toContain("review")
    }),
  )

  it.live("still registers a review command the user configures", () =>
    Effect.gen(function* () {
      const project = yield* emptyProject
      yield* writeProjectCommand(project, "review", "check every layer")
      const review = (yield* listCommands(project, yield* tmpdirScoped())).find((command) => command.name === "review")
      expect(review?.description).toBe("check every layer")
    }),
  )

  it.live("registers the set command GeoCode ships, with a prompt to send", () =>
    Effect.gen(function* () {
      const project = yield* emptyProject
      const set = (yield* listCommands(project, yield* tmpdirScoped())).find((command) => command.name === "set")
      expect(set?.source).toBe("command")
      // An empty template would send an empty message, which providers refuse.
      const template = yield* Effect.promise(async () => set?.template)
      expect(String(template ?? "").trim()).not.toBe("")
    }),
  )

  it.live("lets a set command the user configures override the shipped one", () =>
    Effect.gen(function* () {
      const project = yield* emptyProject
      yield* writeProjectCommand(project, "set", "the user's own set")
      const set = (yield* listCommands(project, yield* tmpdirScoped())).find((command) => command.name === "set")
      expect(set?.description).toBe("the user's own set")
    }),
  )
})
