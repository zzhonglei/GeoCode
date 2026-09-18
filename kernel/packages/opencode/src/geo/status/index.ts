export * as GeoStatus from "./index"

import { isDeepStrictEqual } from "node:util"
import { Context, Effect, Layer, PubSub, Stream } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { EventV2 } from "@opencode-ai/core/event"
import { GeoEvent } from "@opencode-ai/schema/geo-event"

/* --- GeoCode: status slots with generation-guarded commits, so a stale result never overwrites a fresh one
 * (docs/GEOKERNEL.md §3.4). --- */

export type SlotName = "qgis" | "gee" | "gdal"

export interface SlotValues {
  readonly qgis: GeoEvent.QgisStatus
  readonly gee: GeoEvent.GeeStatus
  readonly gdal: GeoEvent.GdalStatus
}

export const SLOTS = ["qgis", "gee", "gdal"] as const satisfies readonly SlotName[]

const DEFINITIONS = {
  qgis: GeoEvent.QgisChanged,
  gee: GeoEvent.GeeChanged,
  gdal: GeoEvent.GdalChanged,
} as const

export interface Token {
  readonly slot: SlotName
  readonly generation: number
}

export interface Writer<Name extends SlotName> {
  /** Once per round, not per phase: a new claim invalidates every phase the previous round has yet to commit. */
  readonly claim: () => Effect.Effect<Token>
  /** False, dropping the value, for a token from an earlier round; an unchanged value returns true unpublished. */
  readonly commit: (token: Token, value: SlotValues[Name]) => Effect.Effect<boolean>
}

/** Optional per slot: a slot exists only once its module registers, as the HTTP schema also declares. */
export type Snapshot = { readonly [Name in SlotName]?: SlotValues[Name] }

export interface Interface {
  /** Registering the same slot twice is a defect and dies. */
  readonly register: <Name extends SlotName>(slot: Name, initial: SlotValues[Name]) => Effect.Effect<Writer<Name>>
  readonly current: <Name extends SlotName>(slot: Name) => Effect.Effect<SlotValues[Name] | undefined>
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

    // Uninterruptible: a stop after the store strands subscribers, as committing the same value publishes nothing.
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
            if (isDeepStrictEqual(values.get(slot), value)) return true
            yield* publish(slot, value)
            return true
          })

        return { claim, commit } satisfies Writer<Name>
      })

    const current = <Name extends SlotName>(slot: Name) =>
      Effect.sync(() => values.get(slot) as SlotValues[Name] | undefined)

    const snapshot = () => Effect.sync(() => Object.fromEntries(values) as Snapshot)

    const watch = <Name extends SlotName>(slot: Name): Stream.Stream<SlotValues[Name]> =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading, or a change landing between the two is lost to both.
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
