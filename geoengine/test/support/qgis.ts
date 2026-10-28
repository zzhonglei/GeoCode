import fs from "node:fs/promises"
import path from "node:path"
import { Python } from "../../src/qgis/python.ts"
import { Qgis } from "../../src/qgis/index.ts"
import { start as engineStart } from "./engine.ts"

export const darwin = process.platform === "darwin"

const plist = (identifier: string, version: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n` +
  `\t<key>CFBundleIdentifier</key>\n\t<string>${identifier}</string>\n` +
  `\t<key>CFBundleShortVersionString</key>\n\t<string>${version}</string>\n</dict>\n</plist>\n`

/** An app bundle shaped like QGIS's; `python` is the body of a shell script standing in for its interpreter. */
export const fakeApp = async (
  directory: string,
  options: { name?: string; identifier?: string; version?: string; python?: string } = {},
) => {
  const app = path.join(directory, options.name ?? "QGIS.app")
  await fs.mkdir(path.join(app, "Contents", "MacOS"), { recursive: true })
  await fs.mkdir(path.join(app, "Contents", "Resources", "qgis"), { recursive: true })
  await fs.writeFile(
    path.join(app, "Contents", "Info.plist"),
    plist(options.identifier ?? "org.qgis.qgis3", options.version ?? "3.44.15"),
  )
  if (options.python !== undefined) {
    const file = path.join(app, "Contents", "MacOS", "python")
    await fs.writeFile(file, `#!/bin/sh\n${options.python}\n`)
    await fs.chmod(file, 0o755)
  }
  return app
}

export const mark = (payload: unknown) => `echo '${Python.MARKER}${JSON.stringify(payload)}'`

export const READY = mark({ python: "3.12.11", gdal: "3.13.3", qgis: "3.44.15-Solothurn", algorithms: 440 })

const parameter = (name: string, type: string, fields: Record<string, unknown> = {}) => ({
  name,
  description: name,
  type,
  optional: false,
  advanced: false,
  destination: false,
  help: "",
  default: null,
  accepted: [],
  ...fields,
})

export const CATALOG = {
  ok: true,
  qgis: "3.44.15-Solothurn",
  algorithms: [
    {
      id: "native:buffer",
      name: "Buffer",
      group: "Vector geometry",
      description: "Computes a buffer area.",
      help: "",
      tags: [],
      notes: 0,
      parameters: [
        parameter("INPUT", "source"),
        parameter("DISTANCE", "distance", { default: 10 }),
        parameter("OUTPUT", "sink", { destination: true }),
      ],
      outputs: [],
    },
  ],
  excluded: [],
  vectorExtensions: ["gpkg", "shp", "geojson"],
}

/**
 * A fake interpreter, which reads its program from stdin: `probe` answers the probe script, `run` the run script,
 * `inspect` the survey of the data, `catalog` the listing of the algorithms.
 */
export const fake = (probe: string, run: string, catalog = mark(CATALOG), inspect = "exit 9") =>
  `program=$(cat)\n` +
  `case "$program" in *processing.run*) ${run} ;; *parameterTypes*) ${catalog} ;; ` +
  `*GT_IsSurface*) ${inspect} ;; *) ${probe} ;; esac`

/** An engine with QGIS, as machine.json says when `configured` names a path. */
export const start = async (configured: string | undefined) => {
  const engine = await engineStart(
    "qgis",
    () => [Qgis.capability],
    configured === undefined ? undefined : { qgis: { path: configured } },
  )
  const send = (params: unknown, method = "qgis.run") => engine.send(method, params)
  return {
    ...engine,
    states: () => engine.states<Qgis.State>("qgis"),
    settled: (ms = 10000) => engine.settled<Qgis.State>("qgis", ms),
    send,
    request: (params: unknown, ms = 10000, method = "qgis.run") => engine.response(send(params, method), ms),
  }
}
