export * as MachineWatcher from "./watcher"

import fs from "fs"
import { Effect } from "effect"
import { MachineLoader } from "./loader"

/* --- GeoCode: watching `machine.json` for edits (docs/GEOKERNEL.md §3.1).
 *
 * Two non-obvious requirements drive this whole file:
 *
 * 1. We watch the config DIRECTORY, not the file. Editors overwhelmingly save
 *    by writing a temp file and renaming it over the target, which detaches any
 *    watch bound to the original inode — a file-scoped watch goes permanently
 *    deaf after the user's first save.
 * 2. One save produces several filesystem events (rename, change, sometimes an
 *    attribute touch), so the callback is debounced. Without it a single save
 *    would start several overlapping environment probes. --- */

const DEBOUNCE_MS = 100

export interface Handle {
  readonly close: () => void
}

/**
 * Invoke `onChange` when either form of the config file is touched.
 *
 * Failures to establish the watch are reported to the caller rather than thrown:
 * a machine where watching is unavailable should still run, it just won't pick
 * up edits until restart.
 */
export function watch(onChange: () => void, onError: (cause: unknown) => void): Handle {
  let timer: NodeJS.Timeout | undefined
  let watcher: fs.FSWatcher | undefined

  const fire = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      onChange()
    }, DEBOUNCE_MS)
  }

  try {
    watcher = fs.watch(MachineLoader.directory(), { persistent: false }, (_event, filename) => {
      // `filename` is documented as possibly null on some platforms; treat an
      // unnamed event in the config directory as potentially ours rather than
      // dropping it, since a missed edit is worse than a redundant reload.
      if (filename === null || filename === undefined) return fire()
      if (MachineLoader.isMachineFile(filename.toString())) fire()
    })
    watcher.on("error", (cause) => onError(cause))
  } catch (cause) {
    onError(cause)
  }

  return {
    close: () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      watcher?.close()
      watcher = undefined
    },
  }
}

/** Effect-friendly wrapper that tears the watch down with the enclosing scope. */
export const watchScoped = Effect.fn("MachineConfig.watch")(function* (
  onChange: () => void,
  onError: (cause: unknown) => void,
) {
  const handle = watch(onChange, onError)
  yield* Effect.addFinalizer(() => Effect.sync(() => handle.close()))
  return handle
})
