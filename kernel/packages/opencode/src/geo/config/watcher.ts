export * as MachineWatcher from "./watcher"

import fs from "fs"
import { Effect } from "effect"
import { MachineLoader } from "./loader"

/* --- GeoCode: watching `machine.json` for edits (docs/GEOKERNEL.md §3.1). The config DIRECTORY, not the file:
 * editors save by renaming a temp file over the target, which detaches a watch bound to the original inode. --- */

/** One save reaches the callback more than once, and a read landing mid-write sees a file the user never saved. */
const DEBOUNCE_MS = 100

export interface Handle {
  readonly close: () => void
}

/**
 * Invoke `onChange` when either form of the config file is touched. A watch that cannot be established is reported
 * rather than thrown: the machine still runs, and `POST /geo/reload` is the pull escape hatch §3.1 requires for it.
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
      // `filename` can arrive null; an unnamed event costs a redundant reload, and a dropped one costs the edit.
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

export const watchScoped = Effect.fn("MachineConfig.watch")(function* (
  onChange: () => void,
  onError: (cause: unknown) => void,
) {
  const handle = watch(onChange, onError)
  yield* Effect.addFinalizer(() => Effect.sync(() => handle.close()))
  return handle
})
