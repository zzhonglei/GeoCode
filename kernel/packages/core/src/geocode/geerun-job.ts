export * as GeeRunJob from "./geerun-job.js"

import { Context, Effect, Layer, Scope } from "effect"
import { Node } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Job } from "../job.js"
import { Session } from "../session.js"
import { GeeRunTool } from "./geerun.js"

type Recovery = Extract<Job.Recovery, { kind: "geerun" }>

export interface Interface {
  /**
   * Moves a run to the background, then tells its conversation once it ends, as the shell tool does of a background
   * command, and with it the run's tool row, which the call's answer left running.
   */
  readonly background: (
    id: string,
    recovery: Recovery,
    final: Effect.Effect<Record<string, unknown>>,
  ) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@geocode/GeeRunJob") {}

const make: Effect.Effect<Interface, never, Job.Service | Session.Service | Scope.Scope> = Effect.gen(function* () {
  const jobs = yield* Job.Service
  const sessions = yield* Session.Service
  // The app's, as the server builds this service for the app: the wait outlives the plugin that started the run.
  const scope = yield* Scope.Scope
  const context = yield* Effect.context<never>()

  return Service.of({
    background: Effect.fn("GeeRunJob.background")(function* (id, recovery, final) {
      yield* jobs.background(id)
      yield* Effect.gen(function* () {
        const info = (yield* jobs.wait({ id })).info
        // Only the app quitting cancels a run in the background: its marker stays, for the restart to tell of it.
        if (!info || info.status === "running" || info.status === "cancelled") return
        yield* sessions.synthetic({
          ...(info.notificationID ? { id: info.notificationID } : {}),
          ...GeeRunTool.notification(recovery, info.status, GeeRunTool.said({ ...info, status: info.status }), {
            ...(yield* final),
            ended: info.completed_at,
          }),
        })
        if (info.notificationID) yield* jobs.completeBackground(info.notificationID)
      }).pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.setContext(context))
    }),
  })
})

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = Node.makeGlobalNode({
  service: Service,
  layer: Layer.effect(Service, make),
  deps: [Job.node, Session.node],
})
