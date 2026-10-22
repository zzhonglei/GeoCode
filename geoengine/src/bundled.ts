export * as Bundled from "./bundled.ts"

import path from "node:path"

const WINDOWS = process.platform === "win32"

const SYSTEM_ROOT = process.env.SystemRoot ?? "C:\\Windows"

/** Given to a Python of GeoCode's whatever the case of their names, with HOME (docs/PYTHON.md, section 6.1). */
const NETWORK = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
])

/** Without it a program finds the account's home from the system, past a sandbox that moved it. */
export const home = (): Record<string, string> => (process.env.HOME === undefined ? {} : { HOME: process.env.HOME })

/**
 * How an interpreter of GeoCode's Python environment is run, as options for `Runtime.run` (docs/PYTHON.md, section
 * 6.1): isolated, since the environment sets its own variables as it starts.
 */
export const python = (command: string, args: readonly string[]) => {
  const env = home()
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && NETWORK.has(name.toUpperCase())) env[name] = value
  }
  // Node fills in a missing PATH from the engine's, so the system's own takes the place of the user's.
  if (WINDOWS) env.PATH = [path.join(SYSTEM_ROOT, "System32"), SYSTEM_ROOT].join(";")
  // As flags: isolated, Python ignores PYTHONUTF8 and PYTHONUNBUFFERED.
  return { command, args: ["-I", "-X", "utf8", "-u", ...args], env, inherit: false }
}
