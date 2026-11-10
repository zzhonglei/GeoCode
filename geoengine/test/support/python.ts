import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Environment } from "../../src/python/index.ts"
import { python3 } from "./common.ts"
import { start } from "./engine.ts"

/** The Python version a bundle says its environment has. */
export const VERSION = "3.13.16"

/** How many packages a bundle says it holds. */
export const PACKAGES = 4

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
 * Both first note their arguments and environment, each call in a file of its own in `calls`, as the warm-up runs
 * several at once. With `slowWarm`, the python3 waits a second before each import of the warm-up, adds to `overlap` how
 * many imports were running then, and leaves a file `warmed`; the working environment's python is the real one, so a
 * warm-up through it leaves none. With `gradual`, pixi-unpack goes through the bundle's PACKAGES slowly as the real one
 * lays them out, first unpacking each into its temporary folder's cache, then recording each in the base's conda-meta.
 * The environment holds a file named for the bundle's id, to tell which bundle the base came from, and files of the
 * kinds installing takes away.
 */
export const bundle = async (
  directory: string,
  id: string,
  options: { fails?: boolean; slowWarm?: boolean; gradual?: boolean } = {},
) => {
  const folder = path.join(directory, `bundle-${id}`)
  const tree = path.join(folder, "tree", "python")
  const notes = path.join(directory, "calls")
  await fs.mkdir(notes, { recursive: true })
  for (const sub of ["bin", "include", path.join("lib", "python3.13", "site-packages")]) {
    await fs.mkdir(path.join(tree, sub), { recursive: true })
  }
  await executable(
    path.join(tree, "bin", "python3"),
    [
      "#!/bin/sh",
      `{ echo "PYTHON $*"; env; echo END; } > "$(mktemp '${notes}/call.XXXXXX')"`,
      ...(options.slowWarm
        ? [
            `case "$*" in *"-c import "*)`,
            `  mkdir '${path.join(directory, "running")}'.$$; sleep 1`,
            `  ls -d '${path.join(directory, "running")}'.* | wc -l >> '${path.join(directory, "overlap")}'`,
            `  '${python3}' "$@"; code=$?; rmdir '${path.join(directory, "running")}'.$$`,
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
      `{ echo "UNPACK $*"; env; echo END; } > "$(mktemp '${notes}/call.XXXXXX')"`,
      options.fails ? `echo "the packages could not be installed" >&2; exit 3` : "",
      "pack=$1; shift",
      "while [ $# -gt 0 ]; do case $1 in --output-directory) out=$2 ;; --env-name) name=$2 ;; esac; shift; done",
      ...(options.gradual
        ? [
            'cache="$TMPDIR/.tmpfake/cache"; mkdir -p "$cache"',
            `for n in $(seq ${PACKAGES}); do mkdir "$cache/p$n"; touch "$cache/p$n.lock"; sleep 0.4; done`,
          ]
        : []),
      'tar -xf "$pack" -C "$TMPDIR" && mv "$TMPDIR/python" "$out/$name" && echo "# activate" > "$out/activate.sh"',
      ...(options.gradual
        ? [
            'rm -rf "$TMPDIR/.tmpfake"; mkdir -p "$out/$name/conda-meta"',
            `for n in $(seq ${PACKAGES}); do touch "$out/$name/conda-meta/p$n.json"; sleep 0.4; done`,
          ]
        : []),
    ].join("\n") + "\n",
  )
  await fs.writeFile(path.join(folder, "python.json"), JSON.stringify({ id, python: VERSION, packages: PACKAGES }))
  return folder
}

/** What the bundle's programs noted, each with what ran it ("PYTHON" or "UNPACK"), its arguments and environment. */
export const calls = async (directory: string) => {
  const folder = path.join(directory, "calls")
  const files = await fs.readdir(folder)
  return (await Promise.all(files.map((file) => fs.readFile(path.join(folder, file), "utf-8"))))
    .map((call) => call.replace(/END\n$/, ""))
    .map((call) => {
      const [first = "", ...lines] = call.split("\n").filter(Boolean)
      const [program = "", ...args] = first.split(" ")
      const env = new Map(lines.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]))
      return { program, args, env }
    })
}

/** Starts the engine, waits for the environment to settle, and stops the engine. */
export const settle = async (directory: string, bundled: string) => {
  const capability = Environment.capability({ bundle: bundled, data: path.join(directory, "data") })
  const engine = await start("python", () => [capability])
  try {
    const last = await engine.settled<Environment.State>("python", 30000, ["checking", "preparing"])
    return { last, states: engine.states<Environment.State>("python") }
  } finally {
    await engine.stop()
  }
}

export const temporary = () => fs.mkdtemp(path.join(os.tmpdir(), "geoengine-python-"))
