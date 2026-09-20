/* --- GeoCode: the browser tool's exception to the plugin shield must not widen past one named file loaded by the
 * server (docs/KERNEL.md §6 item 1). --- */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { PluginLoader } from "../src/plugin/loader"
import {
  GEOCODE_BROWSER_PLUGIN_ENV,
  GEOCODE_BROWSER_PLUGIN_SEGMENTS,
  trustedPluginPath,
  trustedPluginSpec,
} from "../src/plugin/geocode-trusted"

const PLUGIN = `export const GeoCodeBrowserPlugin = async () => ({ tool: { browser: { description: "d", args: {}, async execute() { return "ok" } } } })\n`

let home: string
let realHomedir: typeof os.homedir
let previousEnv: string | undefined

// `loadExternal` asks for the path with no argument, so the seam is `os.homedir` itself. It cannot be `HOME`:
// bun resolves the home directory once at startup and ignores later changes to the variable.
const setHomedir = (value: string) => {
  ;(os as { homedir: () => string }).homedir = () => value
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "geocode-trusted-plugin-"))
  realHomedir = os.homedir
  setHomedir(home)
  previousEnv = process.env[GEOCODE_BROWSER_PLUGIN_ENV]
  delete process.env[GEOCODE_BROWSER_PLUGIN_ENV]
})

afterEach(() => {
  ;(os as { homedir: typeof os.homedir }).homedir = realHomedir
  if (previousEnv === undefined) delete process.env[GEOCODE_BROWSER_PLUGIN_ENV]
  else process.env[GEOCODE_BROWSER_PLUGIN_ENV] = previousEnv
  fs.rmSync(home, { recursive: true, force: true })
})

// Spelled out rather than taken from `trustedPluginPath`, the function under test: an expectation built by calling it
// moves with it, and every assertion here would then hold for any rule at all.
const trustedPath = () => path.join(home, ".config", "GeoCode", "desktop", "agent-tool", "geocode-browser-plugin.js")
const besideTrusted = (name: string) => path.join(path.dirname(trustedPath()), name)

const writePlugin = (file: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, PLUGIN)
  return pathToFileURL(file).href
}

describe("the trusted plugin predicate", () => {
  test("accepts only the named file under the shell data root, and only for the server", () => {
    const spec = pathToFileURL(trustedPath()).href
    expect(trustedPluginSpec({ kind: "server", env: { [GEOCODE_BROWSER_PLUGIN_ENV]: spec }, homeDirectory: home })).toBe(spec)
    expect(trustedPluginSpec({ kind: "tui", env: { [GEOCODE_BROWSER_PLUGIN_ENV]: spec }, homeDirectory: home })).toBeUndefined()
    expect(trustedPluginSpec({ kind: "server", env: {}, homeDirectory: home })).toBeUndefined()
    const neighbour = pathToFileURL(besideTrusted("other.js")).href
    expect(trustedPluginSpec({ kind: "server", env: { [GEOCODE_BROWSER_PLUGIN_ENV]: neighbour }, homeDirectory: home })).toBeUndefined()
    const elsewhere = pathToFileURL(path.join(os.tmpdir(), ...GEOCODE_BROWSER_PLUGIN_SEGMENTS)).href
    expect(trustedPluginSpec({ kind: "server", env: { [GEOCODE_BROWSER_PLUGIN_ENV]: elsewhere }, homeDirectory: home })).toBeUndefined()
    // A file URL fileURLToPath rejects, so only the catch branch refuses it.
    expect(trustedPluginSpec({ kind: "server", env: { [GEOCODE_BROWSER_PLUGIN_ENV]: "file://example.com/x" }, homeDirectory: home })).toBeUndefined()
  })

  test("reads HOME and nothing else, so a moved XDG config root cannot refuse the shell's file", () => {
    const previous = process.env.XDG_CONFIG_HOME
    delete process.env.XDG_CONFIG_HOME
    try {
      expect(trustedPluginPath(home)).toBe(trustedPath())
      process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), "somewhere-else")
      expect(trustedPluginPath(home)).toBe(trustedPath())
      const spec = pathToFileURL(trustedPath()).href
      expect(trustedPluginSpec({ kind: "server", env: { [GEOCODE_BROWSER_PLUGIN_ENV]: spec } })).toBe(spec)
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
    }
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
    process.env[GEOCODE_BROWSER_PLUGIN_ENV] = writePlugin(besideTrusted("other.js"))
    expect(await PluginLoader.loadExternal({ items: [], kind: "server" })).toEqual([])

    process.env[GEOCODE_BROWSER_PLUGIN_ENV] = writePlugin(trustedPath())
    expect(await PluginLoader.loadExternal({ items: [], kind: "tui" })).toEqual([])

    // Only the named browser tool loads, never the configuration-declared plugin beside it.
    const declared = writePlugin(path.join(home, "plugin", "declared.js"))
    const loaded = await PluginLoader.loadExternal({
      items: [{ spec: declared, source: "test", scope: "global" }],
      kind: "server",
    })
    expect(loaded).toHaveLength(1)
    expect((loaded[0] as { spec: string }).spec).toBe(process.env[GEOCODE_BROWSER_PLUGIN_ENV])
  })

  test("control: with nothing named, the configuration path yields nothing at all", async () => {
    const declared = writePlugin(path.join(home, "plugin", "declared.js"))
    expect(await PluginLoader.loadExternal({ items: [{ spec: declared, source: "test", scope: "global" }], kind: "server" })).toEqual([])
  })
})
