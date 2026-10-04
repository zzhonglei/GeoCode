export * as Status from "./status.ts"

import { isDeepStrictEqual } from "node:util"
import { Context, Effect, Layer, PubSub, type Scope, Stream } from "effect"

/** One capability domain's whole environment state; its shape belongs to the domain. */
export interface Change {
  readonly domain: string
  readonly value: unknown
}

export interface Token {
  readonly domain: string
  readonly generation: number
}

export interface Writer<Value> {
  /** Once per round, not per phase: a new claim voids every phase the previous round has yet to commit. */
  readonly claim: () => Effect.Effect<Token>
  /** False, dropping the value, for a token from an earlier round; an unchanged value returns true unpublished. */
  readonly commit: (token: Token, value: Value) => Effect.Effect<boolean>
}

export interface Interface {
  /** Publishes the initial value, so a listener from the engine's start holds every domain. Twice is a defect. */
  readonly register: <Value>(domain: string, initial: Value) => Effect.Effect<Writer<Value>>
  readonly current: (domain: string) => Effect.Effect<unknown>
  /** Subscribes on the spot, so a value registered right after this returns is not lost before the stream runs. */
  readonly changes: Effect.Effect<Stream.Stream<Change>, never, Scope.Scope>
  /** The domain's current value, then each change. */
  readonly watch: (domain: string) => Stream.Stream<unknown>
}

export class Service extends Context.Service<Service, Interface>()("@geocode/GeoEngine/Status") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<Change>()
    const values = new Map<string, unknown>()
    const generations = new Map<string, number>()

    // Uninterruptible: a stop between storing and publishing would leave listeners behind for good, since committing
    // the same value again publishes nothing.
    const publish = (domain: string, value: unknown) =>
      Effect.gen(function* () {
        values.set(domain, value)
        yield* PubSub.publish(pubsub, { domain, value })
      }).pipe(Effect.uninterruptible)

    const register = <Value>(domain: string, initial: Value) =>
      Effect.gen(function* () {
        if (generations.has(domain)) return yield* Effect.die(new Error(`status domain registered twice: ${domain}`))
        generations.set(domain, 0)
        yield* publish(domain, initial)

        const claim = () =>
          Effect.sync(() => {
            const generation = generations.get(domain)! + 1
            generations.set(domain, generation)
            return { domain, generation }
          })

        const commit = (token: Token, value: Value) =>
          Effect.gen(function* () {
            if (token.domain !== domain || token.generation !== generations.get(domain)) return false
            if (isDeepStrictEqual(values.get(domain), value)) return true
            yield* publish(domain, value)
            return true
          })

        return { claim, commit } satisfies Writer<Value>
      })

    const watch = (domain: string) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribed before reading, or a change landing between the two is lost to both.
          const subscription = yield* PubSub.subscribe(pubsub)
          let last = values.get(domain)
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filter((change) => change.domain === domain),
            Stream.map((change) => change.value),
            // A publish that stored its value before this read but reached the subscribers after it arrives twice.
            Stream.filter((value) => {
              if (isDeepStrictEqual(last, value)) return false
              last = value
              return true
            }),
          )
          return values.has(domain) ? Stream.make(last).pipe(Stream.concat(live)) : live
        }),
      )

    return Service.of({
      register,
      current: (domain) => Effect.sync(() => values.get(domain)),
      changes: PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription)),
      watch,
    })
  }),
)
