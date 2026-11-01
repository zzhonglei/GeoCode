import type { FileSystem } from "@opencode/core/filesystem"
import { describe, expect } from "bun:test"
import { Duration, Effect, Layer, LayerMap, RcMap } from "effect"
import { TestClock } from "effect/testing"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { Location } from "@opencode/core/location"
import { LocationActivity } from "@opencode/core/location-activity"
import { GeoRunActivity } from "@opencode/core/geocode/run-activity"
import { LocationServiceMap, type LocationServices } from "@opencode/core/location-services"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { testEffect } from "./lib/effect"

const stopped = { current: false }

// The runner stands in for a foreground geerun that sends no session event: it holds its location as the tool does and
// never finishes on its own.
const locations = Layer.effect(
  LocationServiceMap.Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const map = yield* LayerMap.make(
      (ref: Location.Ref) =>
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        Layer.mergeAll(
          // The sweep reads each location's config for its idle time.
          Config.testLayer(),
          Layer.succeed(
            Location.Service,
            Location.Service.of({
              directory: ref.directory,
              workspaceID: ref.workspaceID,
              project: { id: Project.ID.global, directory: ref.directory, canonical: ref.directory },
            }),
          ),
          Layer.succeed(
            SessionRunner.Service,
            SessionRunner.Service.of({
              drain: () =>
                GeoRunActivity.hold(ref).pipe(
                  Effect.andThen(Effect.never),
                  Effect.scoped,
                  Effect.onInterrupt(() => Effect.sync(() => (stopped.current = true))),
                  Effect.as(SessionRunner.DrainResult.Complete()),
                ),
            }),
          ),
        ).pipe(Layer.provide(Layer.succeed(Bus.Service, bus)), Layer.fresh) as unknown as Layer.Layer<
          LocationServices,
          FileSystem.DirectoryNotFoundError
        >,
      { idleTimeToLive: Duration.infinity },
    )
    return {
      ...map,
      get: (ref: Location.Ref) => map.get(LocationServiceMap.canonical(ref)),
      contextEffect: (ref: Location.Ref) => map.contextEffect(LocationServiceMap.canonical(ref)),
      contextEffectOption: (ref: Location.Ref) => map.contextEffectOption(LocationServiceMap.canonical(ref)),
      invalidate: (ref: Location.Ref) => map.invalidate(LocationServiceMap.canonical(ref)),
    }
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionStore.node,
      LocationServiceMap.node,
      SessionExecution.node,
      LocationActivity.node,
    ]),
    [
      LocationServiceMap.node.replace(
        makeGlobalNode({ service: LocationServiceMap.Service, layer: locations, deps: [Bus.node] }),
      ),
    ],
  ),
)

describe("GeoCode: a geographic run and idle eviction", () => {
  // Guards against the kernel evicting the location of a run that sends no session event for long, and stopping it.
  it.effect("keeps the location of a run in the foreground for as long as it runs, and evicts it as usual after", () =>
    Effect.gen(function* () {
      stopped.current = false
      const db = (yield* Database.Service).db
      const execution = yield* SessionExecution.Service
      const locations = yield* LocationServiceMap.Service
      const sessionID = Session.ID.make("ses_probe")
      const ref = LocationServiceMap.canonical({ directory: AbsolutePath.make("/project") })
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: ref.directory, sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "probe",
          directory: ref.directory,
          title: "Probe",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* execution.resume(sessionID).pipe(Effect.exit, Effect.forkScoped)
      yield* Effect.addFinalizer(() =>
        execution.interrupt(sessionID).pipe(Effect.andThen(TestClock.adjust("5 minutes"))),
      )

      // 70 minutes a minute at a time, so each sweep runs.
      for (let step = 0; step < 70; step++) yield* TestClock.adjust("1 minute")
      expect(stopped.current).toBe(false)
      expect(Array.from(yield* execution.active)).toEqual([sessionID])
      expect(yield* RcMap.has(locations.rcMap, ref)).toBe(true)

      yield* execution.interrupt(sessionID).pipe(Effect.andThen(execution.awaitIdle(sessionID)))
      for (let step = 0; step < 65; step++) yield* TestClock.adjust("1 minute")
      expect(yield* RcMap.has(locations.rcMap, ref)).toBe(false)
    }),
  )
})
