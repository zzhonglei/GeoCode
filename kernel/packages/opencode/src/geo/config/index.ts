export * as MachineConfig from "./index"

import { Context, Effect, Layer, PubSub, Semaphore, Stream } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { MachineSchema } from "./schema"
import { MachineLoader } from "./loader"
import { MachineWatcher } from "./watcher"

export { MachineSchema } from "./schema"
export type { ParseFailure } from "./loader"

/* --- GeoCode: the Config module of GeoKernel's infrastructure layer (docs/GEOKERNEL.md §3.1). Owns the single read
 * path for `machine.json`, watches it, and dispatches each change to the one capability domain it affects.
 *
 * An environment re-probe costs tens of seconds, so normalized comparison, per-block dispatch and debouncing are all
 * here to make one fire exactly when the user changed something relevant. --- */

/** The fingerprint sits outside the union so artifacts have something to bind to in the failure case too. */
export type BlockState<Name extends MachineSchema.BlockName = MachineSchema.BlockName> = {
  readonly block: Name
  readonly fingerprint: string
} & (
  | { readonly ok: true; readonly value: MachineSchema.BlockValue<Name> }
  | { readonly ok: false; readonly failure: MachineLoader.ParseFailure }
)

export interface Snapshot {
  readonly parsable: boolean
  readonly blocks: { readonly [Name in MachineSchema.BlockName]: BlockState<Name> }
}

export interface Interface {
  readonly block: <Name extends MachineSchema.BlockName>(name: Name) => Effect.Effect<BlockState<Name>>
  /**
   * Current state, then every subsequent change. Not a bare change stream: a caller that reads `block` and then
   * subscribes loses whatever lands between the two calls, so the current value is emitted from inside the
   * subscription instead. Anything that reads and then keeps watching belongs here rather than on `block` (§3.1).
   */
  readonly watch: <Name extends MachineSchema.BlockName>(name: Name) => Stream.Stream<BlockState<Name>>
  /** Every block's current state in one call — the shape §3.1 reserves for the status face. */
  readonly snapshot: () => Effect.Effect<Snapshot>
  /** `POST /geo/reload`: the escape hatch for a watch that died, and a settled moment for whoever just wrote (§3.1). */
  readonly reload: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@geocode/MachineConfig") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<BlockState>()
    yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub))

    /** Canonical form of each block at the last dispatch, for change detection. */
    const seen = new Map<MachineSchema.BlockName, string>()
    let parsable = true
    const states = new Map<MachineSchema.BlockName, BlockState>()

    for (const name of MachineSchema.BlockNames) {
      states.set(name, {
        block: name,
        ok: true,
        value: undefined,
        fingerprint: MachineLoader.fingerprint(name, undefined),
      })
      seen.set(name, MachineLoader.canonical(undefined))
    }

    const publish = (next: BlockState) =>
      Effect.gen(function* () {
        states.set(next.block, next)
        yield* PubSub.publish(pubsub, next)
      })

    const apply = Effect.fn("MachineConfig.apply")(function* (loaded: MachineLoader.Loaded) {
      if (!loaded.ok) {
        // Every block fails, because nothing here knows which one the user broke (§3.1) — but only on the way in.
        if (!parsable) return
        parsable = false
        for (const name of MachineSchema.BlockNames) {
          yield* publish({
            block: name,
            ok: false,
            failure: loaded.failure,
            fingerprint: MachineLoader.unparsableFingerprint(name),
          })
        }
        return
      }

      // Recovery re-dispatches unconditionally: the diff below would say "nothing changed" and leave every module
      // stuck in the error state it was driven into (§3.1).
      const forced = !parsable
      parsable = true

      for (const name of MachineSchema.BlockNames) {
        const value = loaded.value[name]
        const canonical = MachineLoader.canonical(value)
        if (!forced && seen.get(name) === canonical) continue
        seen.set(name, canonical)
        yield* publish({
          block: name,
          ok: true,
          value: value as MachineSchema.BlockValue<typeof name>,
          fingerprint: MachineLoader.fingerprint(name, value),
        })
      }
    })

    /**
     * Two reads can be in flight at once — the watcher fires while `POST /geo/reload` runs, or the user saves twice
     * past the debounce — and unserialized the older content can land last and be written back as `seen`, leaving
     * the file saying one thing and every capability doing another until the next edit.
     */
    const serialized = Semaphore.makeUnsafe(1)

    const reload = Effect.fn("MachineConfig.reload")(function* () {
      yield* serialized.withPermits(1)(
        Effect.gen(function* () {
          const loaded = yield* Effect.promise(() => MachineLoader.load())
          yield* apply(loaded)
        }),
      )
    })

    yield* Effect.promise(() => MachineLoader.ensureTemplate()).pipe(
      Effect.tapCause((cause) => Effect.logWarning("failed to seed machine.json", { cause })),
      Effect.ignore,
    )

    // The watcher callback arrives from outside Effect, so it hops back in with this layer's context. Failures are
    // swallowed: a bad edit must not tear down the service that is the user's way to fix it.
    const context = yield* Effect.context<never>()
    const runFork = Effect.runForkWith(context)
    yield* MachineWatcher.watchScoped(
      () => {
        runFork(
          reload().pipe(
            Effect.tapCause((cause) => Effect.logWarning("machine.json reload failed", { cause })),
            Effect.ignore,
          ),
        )
      },
      (cause) => {
        runFork(Effect.logWarning("machine.json watch failed", { cause }))
      },
    )

    // Watch first, then read: the other order leaves a window where a save is in neither, and the system sits on
    // pre-save configuration until the next edit. This order costs at most a duplicate read, which `seen` discards.
    yield* reload()

    const block = <Name extends MachineSchema.BlockName>(name: Name) =>
      Effect.sync(() => states.get(name) as BlockState<Name>)

    const watch = <Name extends MachineSchema.BlockName>(name: Name): Stream.Stream<BlockState<Name>> =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading the current value, never after.
          const subscription = yield* PubSub.subscribe(pubsub)
          const current = states.get(name) as BlockState<Name>
          // A change landing between those two lines arrives twice; drop the repeat so consumers do not re-probe.
          let last = current.fingerprint
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filter((state): state is BlockState<Name> => state.block === name),
            Stream.filter((state) => {
              if (state.fingerprint === last) return false
              last = state.fingerprint
              return true
            }),
          )
          return Stream.make(current).pipe(Stream.concat(live))
        }),
      )

    const snapshot = () =>
      Effect.sync(
        (): Snapshot => ({
          parsable,
          blocks: Object.fromEntries(
            MachineSchema.BlockNames.map((name) => [name, states.get(name)!]),
          ) as Snapshot["blocks"],
        }),
      )

    return Service.of({ block, watch, snapshot, reload })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
