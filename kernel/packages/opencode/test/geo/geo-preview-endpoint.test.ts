import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Context } from "effect"
import { GeoPaths } from "@/server/routes/instance/httpapi/groups/geo"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

/* The preview endpoints, through the real route tree (docs/GEOKERNEL.md §7.7, §7.8).
 *
 * The toolchain is deliberately absent — the test data directory is isolated,
 * so no `machine.json` names a GDAL — which is what makes the ordering visible:
 * a request that never should have been allowed must be refused BEFORE the
 * environment gets a say. */

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, query: Record<string, string>) {
  const url = new URL(`http://localhost${route}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return HttpApiApp.webHandler().handler(new Request(url, { headers: { "x-opencode-directory": directory } }), context)
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("geo preview endpoints", () => {
  test("a path that leaves the project is refused, before the toolchain is consulted", async () => {
    await using tmp = await tmpdir({ git: true })
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "geo-outside-"))
    fs.writeFileSync(path.join(outside, "secrets.tif"), "pixels")
    // A name that stays inside the project the whole way, and bytes that do not.
    fs.symlinkSync(path.join(outside, "secrets.tif"), path.join(tmp.path, "linked.tif"))

    const response = await request(GeoPaths.rasterMeta, tmp.path, { path: "linked.tif" })
    // Not 503: with no GDAL configured, that is what a gate running first would answer.
    expect(response.status).toBe(403)
    expect((await response.json()) as { _tag: string }).toMatchObject({ _tag: "GeoAccessError" })

    fs.rmSync(outside, { recursive: true, force: true })
  })

  test("a file that is not there says so, and says it differently", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await request(GeoPaths.vectorMeta, tmp.path, { path: "absent.geojson" })
    expect(response.status).toBe(404)
    expect((await response.json()) as { _tag: string }).toMatchObject({ _tag: "GeoNotFoundError" })
  })

  test("an unconfigured toolchain refuses with the whole status, not a sentence", async () => {
    await using tmp = await tmpdir({ git: true })
    fs.writeFileSync(path.join(tmp.path, "layer.geojson"), "{}")

    const response = await request(GeoPaths.vectorMeta, tmp.path, { path: "layer.geojson" })
    expect(response.status).toBe(503)
    expect((await response.json()) as object).toMatchObject({
      _tag: "GeoEnvironmentError",
      status: { status: "unconfigured" },
    })
  })

  test("all five resources are mounted where the contract says", async () => {
    await using tmp = await tmpdir({ git: true })
    const paths = [GeoPaths.vectorMeta, GeoPaths.vector, GeoPaths.vectorPage, GeoPaths.rasterMeta, GeoPaths.rasterImage]

    const answers = await Promise.all(paths.map((route) => request(route, tmp.path, { path: "absent.tif" })))
    for (const answer of answers) {
      // A route that was never mounted answers 404 too; only the body tells the two apart.
      expect((await answer.json()) as { _tag: string }).toMatchObject({ _tag: "GeoNotFoundError" })
    }
  })

  test("the page window is validated at the edge", async () => {
    await using tmp = await tmpdir({ git: true })
    // 9999 is past the ceiling the query schema allows.
    const response = await request(GeoPaths.vectorPage, tmp.path, { path: "a.geojson", limit: "9999" })
    expect(response.status).toBe(400)
  })
})
