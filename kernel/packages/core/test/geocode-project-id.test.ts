import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Git } from "@opencode/core/git"
import { AbsolutePath } from "@opencode/core/schema"
import { initGit } from "./fixture/git"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Git.node))

describe("GeoCode: the project ID file", () => {
  // Guards against the repository fingerprint missing a change to .git/geocode, which Project reads for the project's ID.
  // Rewriting the file in place leaves .git's own stamp as it was, so only the file's stamp can tell.
  it.live("changes the repository fingerprint when .git/geocode is rewritten", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initGit(root.path))
      const git = yield* Git.Service
      const dotGit = AbsolutePath.make(path.join(root.path, ".git"))
      const file = path.join(dotGit, "geocode")
      yield* Effect.promise(() => fs.writeFile(file, "abc123\n"))
      const before = yield* git.repo.fingerprint(dotGit)
      expect(before).toBeDefined()
      yield* Effect.promise(() => fs.writeFile(file, "def4567890\n"))
      expect(yield* git.repo.fingerprint(dotGit)).not.toBe(before)
    }),
  )
})
