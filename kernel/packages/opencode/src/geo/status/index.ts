export * as GeoStatus from "./index"

import { isDeepStrictEqual } from "node:util"
import { Context, Effect, Layer, PubSub, Stream } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { EventV2 } from "@opencode-ai/core/event"
import { GeoEvent } from "@opencode-ai/schema/geo-event"

/* --- GeoCode: the Status module of GeoKernel's infrastructure layer
 * (docs/GEOKERNEL.md §3.4). Storage, concurrency-safe commit, publication and
 * snapshot aggregation for the capability modules' environment status.
 *
 * It deliberately understands nothing about geography. It does not know what
 * "ready" means, when to re-probe, or how a state should be rendered — those
 * are the capability modules' judgments (§2.4 principle 2). What it owns is the
 * one mechanism all three of them would otherwise each re-implement: a stale
 * result must never overwrite a fresh one. --- */

export type SlotName = "qgis" | "gee" | "gdal"

export interface SlotValues {
  readonly qgis: GeoEvent.QgisStatus
  readonly gee: GeoEvent.GeeStatus
  readonly gdal: GeoEvent.GdalStatus
}

export const SLOTS = ["qgis", "gee", "gdal"] as const satisfies readonly SlotName[]

/** The event each slot publishes on. Payload is the whole state object. */
const DEFINITIONS = {
  qgis: GeoEvent.QgisChanged,
  gee: GeoEvent.GeeChanged,
  gdal: GeoEvent.GdalChanged,
} as const

/**
 * Identifies one round of resolution. Opaque to callers: they take one when a
 * round begins and hand it back when the round produces something.
 */
export interface Token {
  readonly slot: SlotName
  readonly generation: number
}

/**
 * A slot's sole writer. Handed out once per slot at registration, which makes
 * the single-writer rule structural rather than a check that can be forgotten
 * (§3.4).
 */
export interface Writer<Name extends SlotName> {
  /**
   * Begin a round and take its token.
   *
   * The token covers the ENTIRE round, not one phase: a resolution made of
   * environment validation followed by catalog construction uses one token
   * throughout, so when a new round starts the previous round's later phases
   * are invalidated without each module having to reason about it (§3.4, §4.8).
   */
  readonly claim: () => Effect.Effect<Token>
  /**
   * Publish a value for this round. Returns false when the token is stale — the
   * value is discarded, including intermediate states, so a superseded round
   * cannot even flash its progress onto the user's screen.
   */
  readonly commit: (token: Token, value: SlotValues[Name]) => Effect.Effect<boolean>
}

export type Snapshot = { readonly [Name in SlotName]: SlotValues[Name] }

export interface Interface {
  /** Claim a slot and seed its initial value. Registering twice is a defect and dies. */
  readonly register: <Name extends SlotName>(slot: Name, initial: SlotValues[Name]) => Effect.Effect<Writer<Name>>
  readonly current: <Name extends SlotName>(slot: Name) => Effect.Effect<SlotValues[Name] | undefined>
  /** Every slot's current value, for a client that has just connected (§9.2). */
  readonly snapshot: () => Effect.Effect<Snapshot>
  /** Current value followed by every subsequent change, subscribed before read. */
  readonly watch: <Name extends SlotName>(slot: Name) => Stream.Stream<SlotValues[Name]>
}

export class Service extends Context.Service<Service, Interface>()("@geocode/GeoStatus") {}

export const use = serviceUse(Service)

type Change = { readonly slot: SlotName; readonly value: SlotValues[SlotName] }

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const pubsub = yield* PubSub.unbounded<Change>()
    yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub))

    const values = new Map<SlotName, SlotValues[SlotName]>()
    const generations = new Map<SlotName, number>()
    const registered = new Set<SlotName>()

    const publish = (slot: SlotName, value: SlotValues[SlotName]) =>
      Effect.gen(function* () {
        values.set(slot, value)
        yield* PubSub.publish(pubsub, { slot, value })
        // The wire payload is the whole state object: consumers replace the
        // slot rather than merging into it (§3.4).
        yield* events.publish(DEFINITIONS[slot], { status: value } as never)
      })

    const register = <Name extends SlotName>(slot: Name, initial: SlotValues[Name]) =>
      Effect.gen(function* () {
        if (registered.has(slot)) {
          return yield* Effect.die(new Error(`geo status slot already registered: ${slot}`))
        }
        registered.add(slot)
        values.set(slot, initial)
        generations.set(slot, 0)

        const claim = () =>
          Effect.sync((): Token => {
            const generation = (generations.get(slot) ?? 0) + 1
            generations.set(slot, generation)
            return { slot, generation }
          })

        const commit = (token: Token, value: SlotValues[Name]) =>
          Effect.gen(function* () {
            if (token.slot !== slot) return false
            if (token.generation !== generations.get(slot)) return false
            // Compared against the current value so a periodic probe that keeps
            // reaching the same conclusion produces no event noise (§3.4).
            if (isDeepStrictEqual(values.get(slot), value)) return true
            yield* publish(slot, value)
            return true
          })

        return { claim, commit } satisfies Writer<Name>
      })

    const current = <Name extends SlotName>(slot: Name) =>
      Effect.sync(() => values.get(slot) as SlotValues[Name] | undefined)

    const snapshot = () => Effect.sync(() => Object.fromEntries(values) as unknown as Snapshot)

    const watch = <Name extends SlotName>(slot: Name): Stream.Stream<SlotValues[Name]> =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe first, read second — the ordering contract of §9.2. The
          // reverse leaves a window in which a change is lost by both paths and
          // the consumer sits on a stale value with no way to notice.
          const subscription = yield* PubSub.subscribe(pubsub)
          const seed = values.get(slot) as SlotValues[Name] | undefined
          let last = seed
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filter((change) => change.slot === slot),
            Stream.map((change) => change.value as SlotValues[Name]),
            Stream.filter((value) => {
              // A change landing inside the subscribe/read window would arrive
              // twice; drop the repeat.
              if (last !== undefined && isDeepStrictEqual(last, value)) return false
              last = value
              return true
            }),
          )
          return seed === undefined ? live : Stream.make(seed).pipe(Stream.concat(live))
        }),
      )

    return Service.of({ register, current, snapshot, watch })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [EventV2.node] })
