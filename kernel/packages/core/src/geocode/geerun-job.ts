export * as GeeRunJob from "./geerun-job.js"

import { Clock, Context, Effect, Layer, Scope } from "effect"
import { Node } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "../bus.js"
import { Job } from "../job.js"
import type { Location } from "../location.js"
import { Session } from "../session.js"
import { GeeRunTool } from "./geerun.js"
import { GeeRunRpc } from "./geerun-rpc.js"

type Recovery = Extract<Job.Recovery, { kind: "geerun" }>

export interface Interface {
  /**
   * Moves a run to the background and lists it there, then tells its conversation once it ends, as the shell tool does
   * of a background command, and with it the run's tool row, which the call's answer left running.
   */
  readonly background: (
    id: string,
    recovery: Recovery,
    final: Effect.Effect<Record<string, unknown>>,
    /** Where the run's call was made. */
    call: Location.Ref,
  ) => Effect.Effect<void>
  /** The runs under way in the background, for the interface to show beside its background commands. */
  readonly list: Effect.Effect<typeof GeeRunRpc.Snapshot.Type>
}

export class Service extends Context.Service<Service, Interface>()("@geocode/GeeRunJob") {}

const make = Effect.gen(function* () {
  const jobs = yield* Job.Service
  const sessions = yield* Session.Service
  const bus = yield* Bus.Service
  // The app's, as the server builds this service for the app: the wait outlives the plugin that started the run.
  const scope = yield* Scope.Scope
  const context = yield* Effect.context<never>()
  const running = new Map<string, typeof GeeRunRpc.Run.Type>()
  let revision = yield* Clock.currentTimeMillis
  const snapshot = () => ({ revision, runs: [...running.values()] })
  // In the location of the run that changed, as the protocol has every `rpc.` event in one; the interface reads the
  // list whatever the location, as the strip and the session list show runs of other places too.
  const changed = (location: Location.Ref) =>
    Effect.gen(function* () {
      revision = Math.max(revision + 1, yield* Clock.currentTimeMillis)
      return yield* bus.publish(GeeRunRpc.Changed, snapshot(), { location })
    })

  return Service.of({
    list: Effect.sync(snapshot),
    background: Effect.fn("GeeRunJob.background")(function* (id, recovery, final, call) {
      const moved = yield* jobs.background(id)
      // The place alone, as an event carries it, without the rest of what the location knows.
      const location = { directory: call.directory, workspaceID: call.workspaceID }
      if (moved?.status === "running") {
        running.set(id, {
          id,
          sessionID: recovery.sessionID,
          description: recovery.description,
          startedAt: moved.started_at,
        })
        yield* changed(location)
      }
      yield* Effect.gen(function* () {
        // Off the list once it ends, while its notification still makes its way into the conversation.
        const ended = Effect.suspend(() => (running.delete(id) ? changed(location) : Effect.void))
        const info = (yield* jobs.wait({ id }).pipe(Effect.ensuring(ended))).info
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
  deps: [Job.node, Session.node, Bus.node],
})
