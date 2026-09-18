/* --- GeoCode: the one file the kernel loads as a plugin, the desktop's agent tools, for the server kind only and only
 * when the env var resolves to exactly this path under the kernel's config root (docs/KERNEL.md §6). --- */
import path from "path"
import { fileURLToPath } from "url"
import { Global } from "@opencode-ai/core/global"
import type { PluginKind } from "./shared"

export const GEOCODE_BROWSER_PLUGIN_ENV = "GEOCODE_BROWSER_PLUGIN"

// Hand-copied from the shell's layout (electron/geocode/shell-data-root.mjs, electron/geocode/browser-tool.mjs).
export const GEOCODE_BROWSER_PLUGIN_SEGMENTS = ["desktop", "agent-tool", "geocode-browser-plugin.js"] as const

export function trustedPluginSpec(input: {
  kind: PluginKind
  env?: Record<string, string | undefined>
  configDir?: string
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
  const expected = path.join(input.configDir ?? Global.Path.config, ...GEOCODE_BROWSER_PLUGIN_SEGMENTS)
  if (path.resolve(file) !== expected) return undefined
  return raw
}
