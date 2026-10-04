export * as Transport from "./transport.ts"

import type { Protocol } from "./protocol.ts"

export interface Transport {
  readonly send: (message: Protocol.Outbound) => void
  /** Returns the function that stops listening. */
  readonly listen: (handler: (message: unknown) => void) => () => void
}

/** The part of Electron's `process.parentPort` the engine uses; Node's own types do not declare it. */
interface ParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void
  off(event: "message", listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

export function parentPort(): Transport {
  const port = (process as unknown as { parentPort?: ParentPort }).parentPort
  if (!port) throw new Error("GeoEngine must run as an Electron utility process")
  return {
    send: (message) => port.postMessage(message),
    listen: (handler) => {
      const listener = (event: { data: unknown }) => handler(event.data)
      port.on("message", listener)
      return () => port.off("message", listener)
    },
  }
}
