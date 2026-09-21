import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"
import { InstanceState } from "@/effect/instance-state"
import { Effect, Layer } from "effect"
import { GeoCodeRefresh } from "@/config/geocode-refresh" // GeoCode: queued tasks outlive their parent runner

export {
  Service,
  type ExtendInput,
  type Info,
  type Interface,
  type StartInput,
  type Status,
  type WaitInput,
  type WaitResult,
} from "@opencode-ai/core/background-job"

/** Keeps the legacy service instance-scoped while sharing the core registry engine. */
const layer = Layer.effect(
  CoreBackgroundJob.Service,
  Effect.gen(function* () {
    // --- GeoCode: config disposal must also see jobs before their child runner starts; HTTP/SSE cannot prove this.
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        let jobs: CoreBackgroundJob.Interface | undefined
        const refresh = yield* GeoCodeRefresh.coordinator.observe(
          Effect.suspend(() =>
            jobs
              ? jobs.list().pipe(Effect.map((items) => items.some((job) => job.status === "running")))
              : Effect.succeed(true),
          ),
        )
        const registry = yield* CoreBackgroundJob.make
        jobs = registry
        yield* Effect.addFinalizer(() => refresh.close)
        return {
          ...registry,
          start: (input: CoreBackgroundJob.StartInput) => refresh.admit(registry.start(input)),
          extend: (input: CoreBackgroundJob.ExtendInput) => refresh.admit(registry.extend(input)),
        }
      }),
    )
    // --- /GeoCode ---
    return CoreBackgroundJob.Service.of({
      list: () => InstanceState.useEffect(state, (jobs) => jobs.list()),
      get: (id) => InstanceState.useEffect(state, (jobs) => jobs.get(id)),
      start: (input) => InstanceState.useEffect(state, (jobs) => jobs.start(input)),
      extend: (input) => InstanceState.useEffect(state, (jobs) => jobs.extend(input)),
      wait: (input) => InstanceState.useEffect(state, (jobs) => jobs.wait(input)),
      waitForPromotion: (id) => InstanceState.useEffect(state, (jobs) => jobs.waitForPromotion(id)),
      promote: (id) => InstanceState.useEffect(state, (jobs) => jobs.promote(id)),
      cancel: (id) => InstanceState.useEffect(state, (jobs) => jobs.cancel(id)),
    })
  }),
)

export const node = LayerNode.make({ service: CoreBackgroundJob.Service, layer, deps: [] })

export * as BackgroundJob from "./job"
