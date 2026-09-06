/* --- GeoCode: external plugins stay off; the browser tool file is the one exception
 * (docs/KERNEL.md §6 item 1, src/plugin/geocode-trusted.ts).
 *
 * The predicate is pinned directly, then `loadExternal` is driven for real with the config root
 * pointed at a scratch directory: the named file under `desktop/agent-tool/` loads, a neighbour
 * does not, a configuration-declared plugin still yields nothing, and the TUI gets nothing. --- */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { Global } from "@opencode-ai/core/global"
import { PluginLoader } from "../src/plugin/loader"
import { GEOCODE_BROWSER_PLUGIN_ENV, GEOCODE_BROWSER_PLUGIN_SEGMENTS, trustedPluginSpec } from "../src/plugin/geocode-trusted"

const PLUGIN = `export const GeoCodeBrowserPlugin = async () => ({ tool: { browser: { description: "d", args: {}, async execute() { return "ok" } } } })\n`

let configDir: string
let previousConfig: string
let previousEnv: string | undefined

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "geocode-trusted-plugin-"))
  previousConfig = Global.Path.config
  ;(Global.Path as { config: string }).config = configDir
  previousEnv = process.env[GEOCODE_BROWSER_PLUGIN_ENV]
  delete process.env[GEOCODE_BROWSER_PLUGIN_ENV]
})

afterEach(() => {
  ;(Global.Path as { config: string }).config = previousConfig
  if (previousEnv === undefined) delete process.env[GEOCODE_BROWSER_PLUGIN_ENV]
  else process.env[GEOCODE_BROWSER_PLUGIN_ENV] = previousEnv
  fs.rmSync(configDir, { recursive: true, force: true })
})

const trustedPath = () => path.join(configDir, ...GEOCODE_BROWSER_PLUGIN_SEGMENTS)

const writePlugin = (file: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, PLUGIN)
  return pathToFileURL(file).href
}

describe("the trusted plugin predicate", () => {
  test("accepts only the named file under the config root, and only for the server", () => {
    const spec = pathToFileURL(trustedPath()).href
    expect(trustedPluginSpec({ kind: "server", env: { [GEOCODE_BROWSER_PLUGIN_ENV]: spec }, configDir })).toBe(spec)
    expect(trustedPluginSpec({ kind: "tui", env: { [GEOCODE_BROWSER_PLUGIN_ENV]: spec }, configDir })).toBeUndefined()
    expect(trustedPluginSpec({ kind: "server", env: {}, configDir })).toBeUndefined()
    const neighbour = pathToFileURL(path.join(configDir, "desktop", "agent-tool", "other.js")).href
    expect(trustedPluginSpec({ kind: "server", env: { [GEOCODE_BROWSER_PLUGIN_ENV]: neighbour }, configDir })).toBeUndefined()
    const elsewhere = pathToFileURL(path.join(os.tmpdir(), ...GEOCODE_BROWSER_PLUGIN_SEGMENTS)).href
    expect(trustedPluginSpec({ kind: "server", env: { [GEOCODE_BROWSER_PLUGIN_ENV]: elsewhere }, configDir })).toBeUndefined()
    // A file URL the conversion itself rejects, so the catch is the branch under test; a plain
    // string that is not a URL never reaches it and is covered by the path comparison above.
    expect(trustedPluginSpec({ kind: "server", env: { [GEOCODE_BROWSER_PLUGIN_ENV]: "file://example.com/x" }, configDir })).toBeUndefined()
  })
})

describe("loadExternal", () => {
  test("loads the named file when the process owner names it", async () => {
    process.env[GEOCODE_BROWSER_PLUGIN_ENV] = writePlugin(trustedPath())
    const loaded = await PluginLoader.loadExternal({ items: [], kind: "server" })
    expect(loaded).toHaveLength(1)
    const mod = loaded[0]!.mod as Record<string, unknown>
    expect(typeof mod.GeoCodeBrowserPlugin).toBe("function")
  })

  test("loads nothing for a neighbour, for the TUI, or from configuration", async () => {
    // Same directory, different name: the exception is one file, not one folder.
    process.env[GEOCODE_BROWSER_PLUGIN_ENV] = writePlugin(path.join(configDir, "desktop", "agent-tool", "other.js"))
    expect(await PluginLoader.loadExternal({ items: [], kind: "server" })).toEqual([])

    process.env[GEOCODE_BROWSER_PLUGIN_ENV] = writePlugin(trustedPath())
    expect(await PluginLoader.loadExternal({ items: [], kind: "tui" })).toEqual([])

    // A configuration-declared plugin, the path this shield was built for, still yields nothing
    // even while the browser tool is named.
    const declared = writePlugin(path.join(configDir, "plugin", "declared.js"))
    const loaded = await PluginLoader.loadExternal({
      items: [{ spec: declared, source: "test", scope: "global" }],
      kind: "server",
    })
    expect(loaded).toHaveLength(1)
    expect((loaded[0] as { spec: string }).spec).toBe(process.env[GEOCODE_BROWSER_PLUGIN_ENV])
  })

  test("control: with nothing named, the configuration path yields nothing at all", async () => {
    const declared = writePlugin(path.join(configDir, "plugin", "declared.js"))
    expect(await PluginLoader.loadExternal({ items: [{ spec: declared, source: "test", scope: "global" }], kind: "server" })).toEqual([])
  })
})
