import { expect, describe } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Fiber, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { MachineConfig } from "@/geo/config"
import { pollWithTimeout, testEffect } from "../lib/effect"

/* The Config module of GeoKernel (docs/GEOKERNEL.md §3.1): a re-probe fires when a value changed, and never merely
 * because the file was saved. */

const it = testEffect(LayerNode.compile(LayerNode.group([MachineConfig.node])))

const FILE = path.join(Global.Path.config, "machine.json")
const JSONC = path.join(Global.Path.config, "machine.jsonc")

const write = (text: string) => Effect.promise(() => fs.writeFile(FILE, text, "utf-8"))
const clear = Effect.promise(async () => {
  await fs.rm(FILE, { force: true })
  await fs.rm(JSONC, { force: true })
})

const renameReplace = (text: string) =>
  Effect.promise(async () => {
    const temp = `${FILE}.tmp`
    await fs.writeFile(temp, text, "utf-8")
    await fs.rename(temp, FILE)
  })

describe("machine.json config", () => {
  it.effect("a block change reaches only its own domain", () =>
    Effect.gen(function* () {
      const config = yield* MachineConfig.Service
      yield* clear
      yield* config.reload()
      const before = yield* config.snapshot()

      yield* write(JSON.stringify({ qgis: "/Applications/QGIS-LTR.app" }))
      yield* config.reload()
      const after = yield* config.snapshot()

      expect(after.blocks.qgis.fingerprint).not.toBe(before.blocks.qgis.fingerprint)
      // Per-block dispatch: otherwise one edit restarts every environment probe on the machine.
      expect(after.blocks.gee.fingerprint).toBe(before.blocks.gee.fingerprint)
      expect(after.blocks.gdal.fingerprint).toBe(before.blocks.gdal.fingerprint)
    }),
  )

  it.effect("reformatting is not a change", () =>
    Effect.gen(function* () {
      const config = yield* MachineConfig.Service
      yield* clear
      yield* write(`{"gee":{"python":"/usr/bin/python3","project":"demo"},"qgis":"/Applications/QGIS-LTR.app"}`)
      yield* config.reload()
      const before = yield* config.snapshot()

      yield* write(`{
  // reordered and commented by the editor
  "qgis": "/Applications/QGIS-LTR.app",
  "gee": {
    "project": "demo",
    "python": "/usr/bin/python3"
  }
}
`)
      yield* config.reload()
      const after = yield* config.snapshot()

      expect(after.blocks.qgis.fingerprint).toBe(before.blocks.qgis.fingerprint)
      expect(after.blocks.gee.fingerprint).toBe(before.blocks.gee.fingerprint)
    }),
  )

  it.effect("a syntax error fails every block and carries its location", () =>
    Effect.gen(function* () {
      const config = yield* MachineConfig.Service
      yield* clear
      yield* write(JSON.stringify({ qgis: "/Applications/QGIS-LTR.app" }))
      yield* config.reload()

      yield* write(`{ "qgis": "/Applications/QGIS-LTR.app",, }`)
      yield* config.reload()
      const broken = yield* config.snapshot()

      expect(broken.parsable).toBe(false)
      for (const block of ["qgis", "gee", "gdal"] as const) {
        const state = broken.blocks[block]
        expect(state.ok).toBe(false)
        if (state.ok) continue
        expect(state.failure.file).toBe(FILE)
        // Not merely non-empty: the thrown error's own `message` is the bare class name `ConfigJsonError`.
        expect(state.failure.message).toMatch(/line \d+, column \d+/)
        // And no more than that: the parser's full report dumps the whole file, and this message is quoted
        // back in tool output by the `config-error` guidance.
        expect(state.failure.message).not.toContain("/Applications/QGIS-LTR.app")
        expect(state.failure.message).not.toContain("JSONC Input")
        expect(state.fingerprint).toBe(`${block}:unparsable`)
      }
    }),
  )

  it.effect("recovering from a syntax error re-dispatches every block", () =>
    Effect.gen(function* () {
      const config = yield* MachineConfig.Service
      yield* clear
      const good = JSON.stringify({ qgis: "/Applications/QGIS-LTR.app" })
      yield* write(good)
      yield* config.reload()
      const healthy = yield* config.snapshot()

      yield* write(`{ "qgis": ,, }`)
      yield* config.reload()

      // The same bytes as before the break: a diff would say "nothing changed" and leave every block stuck in
      // the error state it was driven into.
      yield* write(good)
      yield* config.reload()
      const recovered = yield* config.snapshot()

      expect(recovered.parsable).toBe(true)
      expect(recovered.blocks.qgis.fingerprint).toBe(healthy.blocks.qgis.fingerprint)
      expect(recovered.blocks.gee.ok).toBe(true)
      expect(recovered.blocks.gdal.ok).toBe(true)
    }),
  )

  it.effect("an unknown key disables only itself", () =>
    Effect.gen(function* () {
      const config = yield* MachineConfig.Service
      yield* clear
      yield* write(JSON.stringify({ gdal1: "/typo/here", gdal: "/opt/homebrew/bin", qgis: "/Applications/QGIS.app" }))
      yield* config.reload()
      const state = yield* config.snapshot()

      expect(state.parsable).toBe(true)
      const gdal = state.blocks.gdal
      expect(gdal.ok).toBe(true)
      if (gdal.ok) expect(gdal.value).toBe("/opt/homebrew/bin")
      const qgis = state.blocks.qgis
      if (qgis.ok) expect(qgis.value).toBe("/Applications/QGIS.app")
    }),
  )

  it.effect("watch emits the current value before any change", () =>
    Effect.gen(function* () {
      const config = yield* MachineConfig.Service
      yield* clear
      yield* write(JSON.stringify({ qgis: "/Applications/QGIS-LTR.app" }))
      yield* config.reload()

      const first = yield* Stream.runHead(config.watch("qgis"))
      expect(first._tag).toBe("Some")
      if (first._tag === "Some") {
        expect(first.value.block).toBe("qgis")
        expect(first.value.ok).toBe(true)
        if (first.value.ok) expect(first.value.value).toBe("/Applications/QGIS-LTR.app")
      }
    }),
  )

  // `live` rather than `effect`: the watcher's debounce and the filesystem notification are both wall-clock.
  it.live(
    "a rename-replace save is picked up by the directory watch",
    () =>
      Effect.gen(function* () {
        const config = yield* MachineConfig.Service
        yield* clear
        yield* write(JSON.stringify({ qgis: "/Applications/QGIS-LTR.app" }))
        yield* config.reload()
        const before = yield* config.snapshot()

        // The case a file-scoped watch misses forever: the inode is replaced rather than modified, which is how
        // editors save.
        yield* renameReplace(JSON.stringify({ qgis: "/Applications/QGIS.app" }))

        const seen = yield* pollWithTimeout(
          Effect.gen(function* () {
            const now = yield* config.snapshot()
            const qgis = now.blocks.qgis
            if (qgis.fingerprint === before.blocks.qgis.fingerprint) return undefined
            return qgis
          }),
          "rename-replace save was never observed",
          "10 seconds",
        )
        expect(seen.ok).toBe(true)
        if (seen.ok) expect(seen.value).toBe("/Applications/QGIS.app")
      }),
    { timeout: 20000 },
  )

  it.live("concurrent reloads settle on the file, not on who finished last", () =>
    Effect.gen(function* () {
      const config = yield* MachineConfig.Service
      yield* clear
      yield* write(JSON.stringify({ qgis: "/old.app" }))
      yield* config.reload()

      // Nothing here can force the interleaving, so this pins only that the record ends up agreeing with the file.
      const first = yield* Effect.forkScoped(config.reload())
      yield* write(JSON.stringify({ qgis: "/new.app" }))
      const second = yield* Effect.forkScoped(config.reload())
      yield* Fiber.join(first)
      yield* Fiber.join(second)

      const settled = yield* config.snapshot()
      expect(settled.blocks.qgis.ok).toBe(true)
      if (settled.blocks.qgis.ok) expect(settled.blocks.qgis.value).toBe("/new.app")

      yield* config.reload()
      const again = yield* config.snapshot()
      expect(again.blocks.qgis.fingerprint).toBe(settled.blocks.qgis.fingerprint)
    }),
  )
})
