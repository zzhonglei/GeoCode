import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Context } from "effect"
import { FilePaths } from "@/server/routes/instance/httpapi/groups/file"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

/* The generic content endpoint's size gate (docs/GEOKERNEL.md §10.1 #8).
 *
 * The endpoint reads a whole file into one string and hands it to the renderer.
 * Upstream caps it nowhere, and a restored editor tab plus a review sweep can
 * each ask for the same file — observed once as 1.8 GiB of heap from a single
 * 359 MiB CSV, and a dead renderer.
 *
 * The fixtures below are sparse files: the gate reads a size, never bytes, so
 * a test for it does not need to write hundreds of megabytes. */

const context = Context.empty() as Context.Context<unknown>

function content(directory: string, file: string) {
  const url = new URL(`http://localhost${FilePaths.content}`)
  url.searchParams.set("path", file)
  return HttpApiApp.webHandler().handler(new Request(url, { headers: { "x-opencode-directory": directory } }), context)
}

/** A file that claims a size without occupying one. */
const sparse = (file: string, bytes: number) => {
  const handle = fs.openSync(file, "w")
  fs.ftruncateSync(handle, bytes)
  fs.closeSync(handle)
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("content endpoint size gate", () => {
  test("an enormous text file is refused rather than sent", async () => {
    await using tmp = await tmpdir({ git: true })
    sparse(path.join(tmp.path, "huge.csv"), 60 * 1024 * 1024)

    const response = await content(tmp.path, "huge.csv")
    const body = (await response.json()) as { notice?: string; size?: number; content: string }
    expect(body.notice).toBe("oversized")
    // The size travels too, so the interface can say how big rather than just
    // "too big".
    expect(body.size).toBe(60 * 1024 * 1024)
    // Still a readable sentence: a bare API consumer gets an explanation.
    expect(body.content).toContain("too large")
  })

  test("a large raster is pointed at the map, not refused", async () => {
    await using tmp = await tmpdir({ git: true })
    sparse(path.join(tmp.path, "scene.tif"), 12 * 1024 * 1024)

    const body = (await (await content(tmp.path, "scene.tif")).json()) as { notice?: string }
    // Different fact, different answer: the preview endpoint reprojects and
    // downscales this file perfectly well, so the interface switches view
    // instead of reporting a fault (§7.5).
    expect(body.notice).toBe("oversized-raster")
  })

  test("the raster ceiling is lower than the general one", async () => {
    await using tmp = await tmpdir({ git: true })
    // 12 MiB: over the raster threshold, well under the general one. A CSV of
    // the same size is delivered; the raster is not.
    sparse(path.join(tmp.path, "table.csv"), 12 * 1024 * 1024)

    const body = (await (await content(tmp.path, "table.csv")).json()) as { notice?: string }
    expect(body.notice).toBeUndefined()
  })

  test("ordinary files are untouched", async () => {
    await using tmp = await tmpdir({ git: true })
    fs.writeFileSync(path.join(tmp.path, "notes.md"), "hello")

    const body = (await (await content(tmp.path, "notes.md")).json()) as { notice?: string; content: string }
    expect(body.notice).toBeUndefined()
    expect(body.content).toBe("hello")
  })
})
