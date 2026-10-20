export * as GeoAnswer from "./answer.js"

import { ToolOutput } from "../tool-output.js"

/** Said before the end of a run's output when the rest did not fit. */
export const CUT = "(The output was too long; only its end is kept.)"

/** Room kept in the kernel's bounds on an answer for the note, the blank lines between its parts and what is not in `used`. */
const RESERVED_LINES = 10
const RESERVED_BYTES = 1024

/**
 * The end of what a run printed, within what is left of the kernel's bounds on an answer beside the lines already
 * `used`. The kernel's own cut keeps the start, which would lose a failing run's error and how the run ended.
 */
export const lastPart = (text: string, used: { readonly lines: number; readonly bytes: number }) => {
  const lines = text.split("\n")
  const kept: string[] = []
  let room = ToolOutput.MAX_BYTES - RESERVED_BYTES - used.bytes
  for (const line of lines.toReversed()) {
    if (kept.length >= ToolOutput.MAX_LINES - RESERVED_LINES - used.lines) break
    const size = Buffer.byteLength(line, "utf-8") + 1
    if (size > room) {
      // The end of a line too long to keep whole, as long as there is room: it may hold the error.
      if (room > 0) kept.push(Buffer.from(line, "utf-8").subarray(-room).toString("utf-8"))
      return { text: kept.toReversed().join("\n"), cut: true }
    }
    kept.push(line)
    room -= size
  }
  return { text: kept.toReversed().join("\n"), cut: kept.length < lines.length }
}
