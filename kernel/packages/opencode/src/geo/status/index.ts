export * as GeoStatus from "./index"

import { isDeepStrictEqual } from "node:util"
import { Context, Effect, Layer, PubSub, Stream } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { EventV2 } from "@opencode-ai/core/event"
import { GeoEvent } from "@opencode-ai/schema/geo-event"

/* --- GeoCode: the Status module of GeoKernel's infrastructure layer (docs/GEOKERNEL.md §3.4) — slot storage,
 * generation-guarded commit, publication and snapshot, so that no capability module implements "a stale result must
 * never overwrite a fresh one" itself. --- */

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

/** Identifies one round of resolution; callers take one and hand it back, never reading it. */
export interface Token {
  readonly slot: SlotName
  readonly generation: number
}

/** A slot's sole writer, handed out once per slot at registration, which makes the single-writer rule structural. */
export interface Writer<Name extends SlotName> {
  /**
   * One token for the whole round rather than one per phase, so that a new round invalidates the phases the previous
   * one has still to finish without any module tracking that itself (§4.8).
   */
  readonly claim: () => Effect.Effect<Token>
  /**
   * False when the token is not this slot's current round, and the value is then dropped — intermediate states too,
   * so a superseded round cannot flash its progress onto the screen. A value equal to the current one returns true
   * and publishes nothing.
   */
  readonly commit: (token: Token, value: SlotValues[Name]) => Effect.Effect<boolean>
}

/**
 * Optional per slot because a slot exists only from its module's registration, so a snapshot taken while the process
 * is still coming up is genuinely missing entries — the data face declares the same (httpapi/groups/geo.ts).
 */
export type Snapshot = { readonly [Name in SlotName]?: SlotValues[Name] }

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

    // Uninterruptible as a unit — a new configuration interrupts a round mid-flight, and stopping after the store
    // strands subscribers on a stale frame, the next round's identical value being discarded as a duplicate.
    const publish = (slot: SlotName, value: SlotValues[SlotName]) =>
      Effect.gen(function* () {
        values.set(slot, value)
        yield* PubSub.publish(pubsub, { slot, value })
        yield* events.publish(DEFINITIONS[slot], { status: value } as never)
      }).pipe(Effect.uninterruptible)

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
            // A periodic probe reaching the same conclusion again is a success with nothing to publish (§3.4).
            if (isDeepStrictEqual(values.get(slot), value)) return true
            yield* publish(slot, value)
            return true
          })

        return { claim, commit } satisfies Writer<Name>
      })

    const current = <Name extends SlotName>(slot: Name) =>
      Effect.sync(() => values.get(slot) as SlotValues[Name] | undefined)

    // The cast recovers the key-to-value correlation `Object.fromEntries` drops; it asserts nothing about presence.
    const snapshot = () => Effect.sync(() => Object.fromEntries(values) as Snapshot)

    const watch = <Name extends SlotName>(slot: Name): Stream.Stream<SlotValues[Name]> =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe first, read second (§9.2): the reverse loses a change landing between the two to both paths.
          const subscription = yield* PubSub.subscribe(pubsub)
          const seed = values.get(slot) as SlotValues[Name] | undefined
          let last = seed
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filter((change) => change.slot === slot),
            Stream.map((change) => change.value as SlotValues[Name]),
            Stream.filter((value) => {
              // A change landing inside the subscribe/read window arrives twice; drop the repeat.
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
