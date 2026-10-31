import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Gee } from "../../src/gee/index.ts"
import { Environment } from "../../src/python/index.ts"
import { until } from "../support/common.ts"
import { start, result } from "../support/gee.ts"

/**
 * The real Earth Engine, with the user's credentials and quota: only with GEOENGINE_GEE_PROJECT naming their project,
 * through the base environment GeoCode installed in the data directory GEOENGINE_DATA names. scripts/test.mjs hands
 * both over, with a copy of the credentials in the home it gives the tests.
 */
const PROJECT = process.env.GEOENGINE_GEE_PROJECT ?? ""
const DATA = process.env.GEOENGINE_DATA
const where = DATA ? Environment.layout(DATA) : undefined

const LIVE = !PROJECT
  ? "set GEOENGINE_GEE_PROJECT to run on the real Earth Engine"
  : !where
    ? "run through scripts/test.mjs, which hands over GeoCode's data directory"
    : await fs.access(where.basePython).then(
        () => false,
        () => `start GeoCode once, to install its base environment in ${DATA}`,
      )

/** Long enough for Earth Engine to answer a check, or to compose and download a small image. */
const CHECKED = 120000
const COMPOSED = 600000

/** The base environment, once found to be one this GeoCode installed. */
const realBase = async () => {
  const where = Environment.layout(DATA!)
  const started = `start this GeoCode once, to install its base environment in ${DATA}`
  // Imported once first, as the warm-up does: a check, timed, of a base never warmed up would run out of time.
  // -B: the environment is the user's, and its folders not the tests' to write bytecode in.
  const asked = ["-I", "-B", "-c", "import platform, ee, geedim, geopandas, rasterio; print(platform.python_version())"]
  const version = execFileSync(where.basePython, asked, { encoding: "utf-8" }).trim()
  // Guards against running another GeoCode's startup file or geocodekit than this one's.
  const { write, remove } = await Environment.compare(where, version)
  assert.deepEqual([...write, ...remove], [], started)
  return { python: where.basePython, version, prefix: where.base }
}

/** Sets the variables for what `run` does, and puts them back as they were. */
const withVariables = async <A>(variables: Record<string, string | undefined>, run: () => Promise<A>) => {
  const inherited = Object.fromEntries(Object.keys(variables).map((name) => [name, process.env[name]]))
  const assign = (values: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  assign(variables)
  try {
    return await run()
  } finally {
    assign(inherited)
  }
}

/** The project a state was found for. */
const projectOf = (state: Gee.State | undefined) =>
  state === undefined ? undefined : "diagnostics" in state ? state.diagnostics.project : state.project

test(
  "without Earth Engine's own credentials, the real earthengine-api finds no one signed in",
  { skip: LIVE },
  async () => {
    const base = await realBase()
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-home-"))
    // Guards against the user's own credentials being found: kept until the check is over, as its Python takes the
    // engine's home when it starts, USERPROFILE on Windows.
    await withVariables({ HOME: home, USERPROFILE: home }, async () => {
      const engine = await start(PROJECT, [], undefined, base)
      try {
        const state = await engine.settled(CHECKED)
        assert.equal(state.status, "signed-out", JSON.stringify(state))
      } finally {
        await engine.stop()
      }
    }).finally(() => fs.rm(home, { recursive: true, force: true }))
  },
)

test(
  "signed in, the real check asks for the project, and finds Earth Engine ready once it is written",
  { skip: LIVE },
  async () => {
    const engine = await start(undefined, [], undefined, await realBase())
    try {
      assert.equal((await engine.settled(CHECKED)).status, "project-missing")
      await fs.writeFile(engine.machine, JSON.stringify({ gee: PROJECT }))
      await until(
        () => !["project-missing", "checking"].includes(engine.states().at(-1)!.status),
        CHECKED,
        "the check of the project written",
      )
      assert.deepEqual(engine.states().at(-1), { status: "ready", project: PROJECT })
    } finally {
      await engine.stop()
    }
  },
)

// Guards against an earthengine-api of another version, as relocking the environment brings, no longer answering the
// sign-in through the parts of its flow GeoCode takes over: the requests themselves stay on this computer.
test(
  "the real earthengine-api's sign-in passes over another request and ends when access is denied",
  { skip: LIVE },
  async () => {
    const base = await realBase()
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-home-"))
    await withVariables({ HOME: home, USERPROFILE: home }, async () => {
      const engine = await start(PROJECT, [], undefined, base)
      try {
        await engine.settled(CHECKED)
        const id = engine.send({}, "gee.signIn")
        await until(() => engine.progress(id).length > 0, CHECKED, "the address to open")
        const { url } = engine.progress(id)[0] as { url: string }
        const back = new URL(url).searchParams.get("redirect_uri")
        assert.match(back ?? "", /^http:\/\/localhost:\d+$/)
        assert.equal((await fetch(`${back}/favicon.ico`)).status, 404)
        await fetch(`${back}/?error=access_denied`).then((answer) => answer.text())
        const response = await engine.response(id, CHECKED)
        assert.equal(!response.ok && response.error.code, "denied", JSON.stringify(response))
      } finally {
        await engine.stop()
      }
    }).finally(() => fs.rm(home, { recursive: true, force: true }))
  },
)

test("Earth Engine refuses a project ID no project can have as one that does not exist", { skip: LIVE }, async () => {
  // Neither can be anyone's: one ends in a hyphen, the other is of a domain no one may own.
  const ids = ["geocode-test-", "example.com:geocode-test"]
  const engine = await start(ids[0], [], undefined, await realBase())
  try {
    for (const [index, id] of ids.entries()) {
      if (index > 0) await fs.writeFile(engine.machine, JSON.stringify({ gee: id }))
      const last = () => engine.states().at(-1)
      await until(() => last()?.status !== "checking" && projectOf(last()) === id, CHECKED, `the check of ${id}`)
      const state = last()!
      assert.equal(state.status, "rejected", JSON.stringify(state))
      assert.equal("diagnostics" in state && state.diagnostics.refusal, "project-not-found", JSON.stringify(state))
    }
  } finally {
    await engine.stop()
  }
})

test(
  "a run takes place in the real base environment, prints as is, and ends with Earth Engine's traceback",
  { skip: LIVE },
  async () => {
    const base = await realBase()
    const engine = await start(PROJECT, [], undefined, base)
    const run = async (script: string) =>
      result(await engine.response(engine.send({ script, cwd: engine.directory }), CHECKED))
    try {
      assert.equal((await engine.settled(CHECKED)).status, "ready")
      const done = await run(
        "import os, sys\nprint(ee.Number(1).add(1).getInfo())\nprint('台北')\nprint(os.path.realpath(sys.prefix))\n",
      )
      assert.equal(done.outcome, "finished", done.output)
      // Guards against a run in another Python than the base environment.
      assert.ok(done.output.endsWith(`2\n台北\n${await fs.realpath(base.prefix)}\n`), done.output)

      const missing = await run('ee.Image("GEOCODE/NO_SUCH_IMAGE").getInfo()\n')
      assert.equal(missing.outcome, "failed", missing.output)
      // Guards against Earth Engine's refusal, raised deep within earthengine-api, losing the script's line.
      assert.match(missing.output, /File "<script>", line 1, in <module>/)
      assert.match(missing.output, /ee\.ee_exception\.EEException: /)
    } finally {
      await engine.stop()
    }
  },
)

// Guards against a composite with holes passing for a whole one: the two acquisitions of this week over Taipei leave
// about half of it under cloud in both.
test("a composite that leaves part of the region uncovered stops the run", { skip: LIVE }, async () => {
  const engine = await start(PROJECT, [], undefined, await realBase())
  try {
    assert.equal((await engine.settled(CHECKED)).status, "ready")
    const script = [
      "import geocodekit.gee as gee",
      "region = ee.Geometry.Rectangle([121.555, 25.025, 121.575, 25.043])",
      'images = gee.images("COPERNICUS/S2_SR_HARMONIZED", region, "2024-10-01", "2024-10-08")',
      "gee.composite(images, region)",
      'print("composited")',
    ].join("\n")
    const done = result(await engine.response(engine.send({ script, cwd: engine.directory }), COMPOSED))
    assert.equal(done.outcome, "failed", done.output)
    // The refusal, not some other failure on the way, such as Earth Engine turning away too many requests at once.
    assert.match(done.output, /ValueError: /)
    assert.ok(!done.output.includes("composited"), done.output)
  } finally {
    await engine.stop()
  }
})

// Guards against measuring a large region's acquisitions past what Earth Engine allows one request, in memory or in
// concurrent aggregations: a month of Sentinel-2 over Taiwan has up to 25 images an acquisition.
test("the acquisitions over a region the size of Taiwan are measured", { skip: LIVE }, async () => {
  const engine = await start(PROJECT, [], undefined, await realBase())
  try {
    assert.equal((await engine.settled(CHECKED)).status, "ready")
    const script = [
      "import geocodekit.gee as gee",
      "region = ee.Geometry.Rectangle([119.9, 21.85, 122.05, 25.35])",
      'gee.images("COPERNICUS/S2_SR_HARMONIZED", region, "2024-10-01", "2024-11-01")',
    ].join("\n")
    const done = result(await engine.response(engine.send({ script, cwd: engine.directory }), COMPOSED))
    assert.equal(done.outcome, "finished", done.output)
  } finally {
    await engine.stop()
  }
})

/**
 * A proxy on this computer that passes every tunnel on, noting who asked for it: aiohttp, as geedim uses it, names
 * itself, and requests does not.
 */
const tunnelling = async () => {
  const agents: string[] = []
  const sockets = new Set<net.Socket>()
  const proxy = http.createServer()
  proxy.on("connect", (request: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    agents.push(request.headers["user-agent"] ?? "")
    const [host = "", port = "443"] = (request.url ?? "").split(":")
    const server = net.connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      server.write(head)
      server.pipe(client)
      client.pipe(server)
    })
    for (const socket of [client, server]) {
      sockets.add(socket)
      socket.on("error", () => {
        client.destroy()
        server.destroy()
      })
    }
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  return {
    address: `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`,
    agents,
    close: () => {
      for (const socket of sockets) socket.destroy()
      proxy.close()
    },
  }
}

/** Two kilometres across Taipei, in WGS 84. */
const TAIPEI = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { 名称: "台北" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [121.555, 25.025],
            [121.575, 25.025],
            [121.575, 25.043],
            [121.555, 25.043],
            [121.555, 25.025],
          ],
        ],
      },
    },
  ],
}

/** What a GeoTIFF holds, as the base environment's rasterio reads it: its bands, grid, and the share of it unmasked. */
const READ_GRID = [
  "import json, sys, rasterio",
  "with rasterio.open(sys.argv[1]) as data:",
  "    masks = data.read_masks()",
  "    covered = float((masks > 0).sum()) / masks.size",
  '    grid = {"count": data.count, "crs": data.crs.to_string(), "resolution": list(data.res)}',
  '    print(json.dumps({**grid, "covered": covered}))',
].join("\n")

test(
  "the core chain runs on the real Earth Engine through the proxy GeoCode is given, geedim's requests too",
  { skip: LIVE },
  async () => {
    const base = await realBase()
    const proxy = await tunnelling()
    // Guards against a proxy or bypass list of the user's own taking the requests past this one; the lowercase wins.
    const variables = { HTTPS_PROXY: proxy.address, https_proxy: undefined, NO_PROXY: undefined, no_proxy: undefined }
    try {
      await withVariables(variables, async () => {
        const engine = await start(PROJECT, [], undefined, base)
        try {
          assert.equal((await engine.settled(CHECKED)).status, "ready")
          // Guards against the check leaving another way than through the proxy given, and against what the check
          // tunnelled counting for the run.
          assert.ok(proxy.agents.length > 0)
          proxy.agents.length = 0
          await fs.mkdir(path.join(engine.directory, "数据"))
          await fs.writeFile(path.join(engine.directory, "数据", "台北.geojson"), JSON.stringify(TAIPEI))
          const script = [
            "import geocodekit.gee as gee",
            'region = gee.region("数据/台北.geojson")',
            'images = gee.images("COPERNICUS/S2_SR_HARMONIZED", region, "2024-10-01", "2025-01-01")',
            "composite = gee.composite(images, region).clip(region)",
            'print(gee.download(composite.select(["B4", "B3", "B2"]), "台北_rgb.tif", scale=100))',
          ].join("\n")
          const done = result(await engine.response(engine.send({ script, cwd: engine.directory }), COMPOSED))
          assert.equal(done.outcome, "finished", done.output)
          // Guards against taking the script's word for it: the file is read anew.
          const file = path.join(engine.directory, "台北_rgb.tif")
          const grid = JSON.parse(execFileSync(base.python, ["-I", "-B", "-c", READ_GRID, file], { encoding: "utf-8" }))
          const expected = { count: 3, crs: "EPSG:32651", resolution: [100, 100], covered: true }
          assert.deepEqual({ ...grid, covered: grid.covered > 0.9 }, expected)
        } finally {
          await engine.stop()
        }
      })
      // Guards against the run's requests, to Earth Engine or geedim's, leaving another way than through the proxy.
      const asked = proxy.agents.join("; ")
      assert.ok(
        proxy.agents.some((agent) => !agent.includes("aiohttp")),
        asked,
      )
      assert.ok(
        proxy.agents.some((agent) => agent.includes("aiohttp")),
        asked,
      )
    } finally {
      proxy.close()
    }
  },
)
