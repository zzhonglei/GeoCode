import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Fiber, Layer } from "effect"
import { Config } from "../../src/config.ts"
import { Engine } from "../../src/engine.ts"
import type { Protocol } from "../../src/protocol.ts"
import { Environment } from "../../src/python/index.ts"
import { Runtime } from "../../src/runtime.ts"
import { Status } from "../../src/status.ts"
import type { Transport } from "../../src/transport.ts"
import { until } from "./common.ts"

const posix = process.platform !== "win32"

/** The real interpreter behind `python3`, to stand in for the bundled one; none skips these tests. */
export const python3 = (() => {
  if (!posix) return
  try {
    return (
      execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf-8" }).trim() || undefined
    )
  } catch {
    return
  }
})()

/** The Python version a bundle says its environment has. */
export const VERSION = "3.13.16"

/** The base environment's site-packages, as a bundle stages it. */
export const sitePackages = (where: ReturnType<typeof Environment.layout>) =>
  path.join(where.stdlib(VERSION), "site-packages")

export const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  )

/** The steps of preparing the environment, in the order the states went through them. */
export const steps = (states: readonly Environment.State[]) =>
  states.flatMap((state) => (state.status === "preparing" ? [state.step] : []))

const executable = async (file: string, text: string) => {
  await fs.writeFile(file, text)
  await fs.chmod(file, 0o755)
}

/**
 * A bundle as scripts/stage-python.sh stages one. Its pixi-unpack unpacks the packed environment through its temporary
 * folder and leaves an activation script beside it, as the real one does; the environment's python3 runs the real one.
 * Both first note their arguments and environment in `calls.log`. With `slowWarm`, the python3 waits a second before
 * running the warm-up and then leaves a file `warmed` beside the log; the working environment's python is the real one,
 * so a warm-up through it leaves none. The environment holds a file named for the bundle's id, to tell which bundle the
 * base came from, and files of the kinds installing takes away.
 */
export const bundle = async (directory: string, id: string, options: { fails?: boolean; slowWarm?: boolean } = {}) => {
  const folder = path.join(directory, `bundle-${id}`)
  const tree = path.join(folder, "tree", "python")
  const log = path.join(directory, "calls.log")
  for (const sub of ["bin", "include", path.join("lib", "python3.13", "site-packages")]) {
    await fs.mkdir(path.join(tree, sub), { recursive: true })
  }
  await executable(
    path.join(tree, "bin", "python3"),
    [
      "#!/bin/sh",
      `{ echo "PYTHON $*"; env; echo END; } >> '${log}'`,
      ...(options.slowWarm
        ? [
            `case "$*" in *importlib*)`,
            `  sleep 1; '${python3}' "$@"; code=$?`,
            `  touch '${path.join(directory, "warmed")}'; exit $code ;;`,
            "esac",
          ]
        : []),
      `exec '${python3}' "$@"`,
    ].join("\n") + "\n",
  )
  await fs.writeFile(path.join(tree, `from-${id}`), id)
  for (const file of [path.join("include", "Python.h"), path.join("lib", "libz.a"), path.join("lib", "libz.dylib")]) {
    await fs.writeFile(path.join(tree, file), "")
  }
  execFileSync("tar", ["-cf", path.join(folder, "python.tar"), "-C", path.dirname(tree), "python"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  })
  await executable(
    path.join(folder, "pixi-unpack"),
    [
      "#!/bin/sh",
      `{ echo "UNPACK $*"; env; echo END; } >> '${log}'`,
      options.fails ? `echo "the packages could not be installed" >&2; exit 3` : "",
      "pack=$1; shift",
      "while [ $# -gt 0 ]; do case $1 in --output-directory) out=$2 ;; --env-name) name=$2 ;; esac; shift; done",
      'tar -xf "$pack" -C "$TMPDIR" && mv "$TMPDIR/python" "$out/$name" && echo "# activate" > "$out/activate.sh"',
    ].join("\n") + "\n",
  )
  await fs.writeFile(path.join(folder, "python.json"), JSON.stringify({ id, python: VERSION }))
  return folder
}

/** What the bundle's programs noted, each with what ran it ("PYTHON" or "UNPACK"), its arguments and environment. */
export const calls = async (directory: string) =>
  (await fs.readFile(path.join(directory, "calls.log"), "utf-8"))
    .split("END\n")
    .filter(Boolean)
    .map((call) => {
      const [first = "", ...lines] = call.split("\n").filter(Boolean)
      const [program = "", ...args] = first.split(" ")
      const env = new Map(lines.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]))
      return { program, args, env }
    })

const start = async (directory: string, bundled: string) => {
  const sent: Protocol.Outbound[] = []
  const transport: Transport = { send: (message) => void sent.push(structuredClone(message)), listen: () => () => {} }
  const layer = Layer.mergeAll(
    Runtime.layer(Engine.ledger(transport)),
    Status.layer,
    Config.layer(path.join(directory, "machine.json")),
  )
  const capability = Environment.capability({ bundle: bundled, data: path.join(directory, "data") })
  const fiber = Effect.runFork(Effect.scoped(Engine.run(transport, [capability])).pipe(Effect.provide(layer)))
  const states = () =>
    sent.flatMap((message) =>
      message.type === "status" && message.domain === "python" ? [message.value as Environment.State] : [],
    )
  const settled = async () => {
    const pending = new Set(["checking", "preparing"])
    await until(() => !pending.has(states().at(-1)?.status ?? "checking"), 30000, "the environment to settle")
    return states().at(-1)!
  }
  return { states, settled, stop: () => Effect.runPromise(Fiber.interrupt(fiber)) }
}

/** Starts the engine, waits for the environment to settle, and stops the engine. */
export const settle = async (directory: string, bundled: string) => {
  const engine = await start(directory, bundled)
  try {
    return { last: await engine.settled(), states: engine.states() }
  } finally {
    await engine.stop()
  }
}

export const temporary = () => fs.mkdtemp(path.join(os.tmpdir(), "geoengine-python-"))
