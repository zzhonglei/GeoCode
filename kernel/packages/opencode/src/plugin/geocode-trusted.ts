/* --- GeoCode: the one file the kernel loads as a plugin, the desktop's agent tools, for the server kind only and only
 * when the env var resolves to exactly the path the shell writes it to (docs/KERNEL.md §6). --- */
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { Brand } from "@opencode-ai/core/brand" // GeoCode: own module
import type { PluginKind } from "./shared"

export const GEOCODE_BROWSER_PLUGIN_ENV = "GEOCODE_BROWSER_PLUGIN"

// Hand-copied from the shell's layout (electron/geocode/shell-data-root.mjs, electron/geocode/browser-tool.mjs).
export const GEOCODE_BROWSER_PLUGIN_SEGMENTS = ["desktop", "agent-tool", "geocode-browser-plugin.js"] as const

/** From HOME, never from this process's config root: the shell roots its data at HOME, so the two coincide only while
 *  XDG_CONFIG_HOME is unset, and after that `loadExternal` refuses the shell's file in silence (docs/PATHS.md §3.3). */
export function trustedPluginPath(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, ".config", Brand.dirName, ...GEOCODE_BROWSER_PLUGIN_SEGMENTS)
}

export function trustedPluginSpec(input: {
  kind: PluginKind
  env?: Record<string, string | undefined>
  homeDirectory?: string
}): string | undefined {
  if (input.kind !== "server") return undefined
  const raw = (input.env ?? process.env)[GEOCODE_BROWSER_PLUGIN_ENV]
  if (typeof raw !== "string" || !raw) return undefined
  let file: string
  try {
    file = raw.startsWith("file://") ? fileURLToPath(raw) : raw
  } catch {
    return undefined
  }
  const expected = trustedPluginPath(input.homeDirectory)
  if (path.resolve(file) !== expected) return undefined
  return raw
}
