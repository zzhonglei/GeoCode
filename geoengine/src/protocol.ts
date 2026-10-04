export * as Protocol from "./protocol.ts"

import { Schema } from "effect"

export const Request = Schema.Struct({
  type: Schema.Literal("request"),
  id: Schema.Int,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
})

export const Cancel = Schema.Struct({
  type: Schema.Literal("cancel"),
  id: Schema.Int,
})

/** Asks the engine to end every task before the app quits. */
export const Shutdown = Schema.Struct({
  type: Schema.Literal("shutdown"),
})

export const Inbound = Schema.Union([Request, Cancel, Shutdown])
export type Inbound = typeof Inbound.Type

export interface Failure {
  readonly code: string
  readonly message: string
  readonly details?: unknown
}

export type Response = { readonly type: "response"; readonly id: number; readonly cancelled: boolean } & (
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: Failure }
)

export type Outbound =
  | { readonly type: "ready" }
  | { readonly type: "progress"; readonly id: number; readonly data: unknown }
  | Response
  /** A domain's whole state, sent on registration and on every change. */
  | { readonly type: "status"; readonly domain: string; readonly value: unknown }
  /** A task's process (its group on POSIX), so the main process can end it if the engine dies first. */
  | { readonly type: "task"; readonly event: "start" | "end"; readonly pid: number }
  | { readonly type: "shutdown-complete" }
