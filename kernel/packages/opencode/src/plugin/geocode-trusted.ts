/* --- GeoCode: the one file the kernel loads as a plugin (docs/KERNEL.md §6 item 1, docs/DESKTOP.md §7.2).
 *
 * External plugins stay off: nothing a configuration declares and nothing found in a project directory is
 * loaded. The single exception is the file holding the desktop's agent tools, which its main process writes
 * into the shell data root and names in the kernel's environment when it starts the kernel. Two conditions, both
 * required: the variable is set, which only the process owner can do because the inherited environment
 * is stripped before the kernel starts, and the named file resolves to exactly this path under the
 * kernel's own config root, so a variable pointing anywhere else loads nothing. Server kind only; the
 * TUI never gets it. --- */
import path from "path"
import { fileURLToPath } from "url"
import { Global } from "@opencode-ai/core/global"
import type { PluginKind } from "./shared"

export const GEOCODE_BROWSER_PLUGIN_ENV = "GEOCODE_BROWSER_PLUGIN"

// A hand-copy of the shell's layout (electron/geocode/shell-data-root.mjs, electron/geocode/browser-tool.mjs):
// the shell data root is `<config root>/desktop`, the plugin lives in `agent-tool/` under it.
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
