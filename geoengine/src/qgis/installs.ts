export * as Installs from "./installs.ts"

/** A QGIS that can be started. */
export interface Install {
  /** Where QGIS is: its app bundle on macOS, `<root>\apps\<name>` on Windows. */
  readonly app: string
  /** QGIS's own launcher for its Python, which sets up what the interpreter needs. */
  readonly interpreter: string
  readonly version: string | undefined
}

/** Every QGIS found can be chosen: whether it runs is for the check to find out, not for its version to decide. */
export interface Found {
  readonly app: string
  readonly version: string | undefined
}

/** Newest first; an unknown version last, and the same version by where it is. */
export function newestFirst(found: readonly Found[]): Found[] {
  return [...found].sort((a, b) => newer(a.version, b.version) || a.app.localeCompare(b.app))
}

/** Negative when a is the newer version. */
function newer(a: string | undefined, b: string | undefined) {
  const parts = (version: string | undefined) =>
    (version ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0)
  const left = parts(a)
  const right = parts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
