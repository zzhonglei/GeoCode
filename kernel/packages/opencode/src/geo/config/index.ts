export * as MachineConfig from "./index"

import { Context, Effect, Layer, PubSub, Stream } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { MachineSchema } from "./schema"
import { MachineLoader } from "./loader"
import { MachineWatcher } from "./watcher"

export { MachineSchema } from "./schema"
export type { ParseFailure } from "./loader"

/* --- GeoCode: the Config module of GeoKernel's infrastructure layer
 * (docs/GEOKERNEL.md §3.1). Owns the single read path for `machine.json`,
 * watches it, and dispatches changes to the capability domain each one affects.
 *
 * The module's whole reason to exist is that an environment re-probe is
 * expensive (tens of seconds for QGIS). Everything here — normalized
 * comparison, per-block dispatch, debouncing — exists to make sure a re-probe
 * happens exactly when the user actually changed something relevant. --- */

/**
 * A block's current state, as seen by the capability module that owns it.
 *
 * The fingerprint is present in both cases so downstream artifacts always have
 * something to bind to (see MachineLoader.unparsableFingerprint for why the
 * failure case gets a distinguished value rather than the last good one).
 */
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
  /** Current state of one block. */
  readonly block: <Name extends MachineSchema.BlockName>(name: Name) => Effect.Effect<BlockState<Name>>
  /**
   * Current state of one block, followed by every subsequent change to it.
   *
   * Deliberately not a bare change stream: a caller that reads the value and
   * then subscribes would lose any change landing between the two calls, which
   * is the same ordering trap §9.2 documents for the status face. Emitting the
   * current value from inside an already-established subscription removes the
   * window instead of asking every caller to remember the order.
   */
  readonly watch: <Name extends MachineSchema.BlockName>(name: Name) => Stream.Stream<BlockState<Name>>
  /** Every block's current state. */
  readonly snapshot: () => Effect.Effect<Snapshot>
  /** Re-read the file now. Exposed for tests and for the startup trigger. */
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
      states.set(name, { block: name, ok: true, value: undefined, fingerprint: MachineLoader.fingerprint(name, undefined) })
      seen.set(name, MachineLoader.canonical(undefined))
    }

    const publish = (next: BlockState) =>
      Effect.gen(function* () {
        states.set(next.block, next)
        yield* PubSub.publish(pubsub, next)
      })

    const apply = Effect.fn("MachineConfig.apply")(function* (loaded: MachineLoader.Loaded) {
      if (!loaded.ok) {
        // A syntax error fails every block at once: we cannot know which block
        // the user broke, and continuing to serve the last good values would put
        // the file's contents and the system's behaviour in disagreement (§3.1).
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

      // Recovering from unparsable re-dispatches everything unconditionally:
      // every module was driven into an error state, so what they need is a
      // full fresh round, not an incremental diff against values they are no
      // longer holding (§3.1).
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

    const reload = Effect.fn("MachineConfig.reload")(function* () {
      const loaded = yield* Effect.promise(() => MachineLoader.load())
      yield* apply(loaded)
    })

    yield* Effect.promise(() => MachineLoader.ensureTemplate()).pipe(
      Effect.tapCause((cause) => Effect.logWarning("failed to seed machine.json", { cause })),
      Effect.ignore,
    )
    yield* reload()

    // The watcher callback arrives from outside Effect, so it hops back in with
    // this layer's context. Failures are logged and swallowed: a bad edit must
    // not tear down the config service that is the user's way to fix it.
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

    const block = <Name extends MachineSchema.BlockName>(name: Name) =>
      Effect.sync(() => states.get(name) as BlockState<Name>)

    const watch = <Name extends MachineSchema.BlockName>(name: Name): Stream.Stream<BlockState<Name>> =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading the current value, never after.
          const subscription = yield* PubSub.subscribe(pubsub)
          const current = states.get(name) as BlockState<Name>
          // A change landing inside that window arrives twice; drop the repeat
          // by fingerprint so consumers do not re-probe for nothing.
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
