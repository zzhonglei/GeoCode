export * as GeeRunBackground from "./geerun-background.js"

import type { Job } from "../job.js"

/**
 * A geerun run in the background as plugins are told of a shell: /goal waits only on a shell of the Session, and reads
 * its kind, Session and command alone. The run's notice wakes the Session when it ends, as a shell's does.
 */
export const asShell = (recovery: Extract<Job.Recovery, { kind: "geerun" }>) => ({
  kind: "shell" as const,
  sessionID: recovery.sessionID,
  shellID: recovery.callID,
  command: `geerun ${recovery.task}: ${recovery.description}`,
})
