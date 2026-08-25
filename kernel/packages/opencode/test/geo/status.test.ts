import { expect, describe } from "bun:test"
import { Effect, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { GeoEvent } from "@opencode-ai/schema/geo-event"
import { GeoStatus } from "@/geo/status"
import { testEffect } from "../lib/effect"

/* The Status module of GeoKernel (docs/GEOKERNEL.md §3.4): the one guarantee no capability module implements
 * for itself — a stale result must not overwrite a fresh one. */

// EventV2 is a dependency of GeoStatus; naming it here too is what puts the service within reach of the tests.
const it = testEffect(LayerNode.compile(LayerNode.group([GeoStatus.node, EventV2.node])))

const UNCONFIGURED: GeoEvent.GdalStatus = { status: "unconfigured" }
const READY: GeoEvent.GdalStatus = { status: "ready" }

describe("geo status slots", () => {
  it.effect("a stale token is refused", () =>
    Effect.gen(function* () {
      const status = yield* GeoStatus.Service
      const writer = yield* status.register("gdal", UNCONFIGURED)

      const first = yield* writer.claim()
      const second = yield* writer.claim()

      expect(yield* writer.commit(first, READY)).toBe(false)
      expect(yield* status.current("gdal")).toEqual(UNCONFIGURED)

      expect(yield* writer.commit(second, READY)).toBe(true)
      expect(yield* status.current("gdal")).toEqual(READY)
    }),
  )

  it.effect("one token covers a whole multi-phase round", () =>
    Effect.gen(function* () {
      const status = yield* GeoStatus.Service
      const writer = yield* status.register("qgis", { status: "unconfigured" })

      const round = yield* writer.claim()
      expect(yield* writer.commit(round, { status: "resolving" })).toBe(true)
      expect(yield* writer.commit(round, { status: "probing" })).toBe(true)
      expect(yield* writer.commit(round, { status: "ready", processing: true, catalog: "building" })).toBe(true)
      expect(yield* status.current("qgis")).toEqual({ status: "ready", processing: true, catalog: "building" })
    }),
  )

  it.effect("a superseded round cannot publish even an intermediate state", () =>
    Effect.gen(function* () {
      const status = yield* GeoStatus.Service
      const writer = yield* status.register("qgis", { status: "unconfigured" })

      const stale = yield* writer.claim()
      const fresh = yield* writer.claim()
      yield* writer.commit(fresh, { status: "probing" })

      expect(yield* writer.commit(stale, { status: "resolving" })).toBe(false)
      expect(yield* status.current("qgis")).toEqual({ status: "probing" })
    }),
  )

  it.effect("committing the same value publishes nothing", () =>
    Effect.gen(function* () {
      const status = yield* GeoStatus.Service
      const events = yield* EventV2.Service
      const writer = yield* status.register("gdal", UNCONFIGURED)

      const seen: GeoEvent.GdalStatus[] = []
      yield* Effect.forkScoped(
        Stream.runForEach(events.subscribe(GeoEvent.GdalChanged), (event) =>
          Effect.sync(() => seen.push(event.data.status)),
        ),
      )
      yield* Effect.yieldNow

      yield* writer.commit(yield* writer.claim(), READY)
      yield* writer.commit(yield* writer.claim(), READY)
      yield* writer.commit(yield* writer.claim(), READY)
      yield* Effect.yieldNow

      expect(seen).toEqual([READY])
    }),
  )

  it.effect("the event payload is the whole state object", () =>
    Effect.gen(function* () {
      const status = yield* GeoStatus.Service
      const events = yield* EventV2.Service
      const writer = yield* status.register("gee", {
        facing: "setup",
        setup: { status: "unconfigured" },
        network: { status: "idle" },
        runtime: { status: "unknown" },
      })

      const seen: GeoEvent.GeeStatus[] = []
      yield* Effect.forkScoped(
        Stream.runForEach(events.subscribe(GeoEvent.GeeChanged), (event) =>
          Effect.sync(() => seen.push(event.data.status)),
        ),
      )
      yield* Effect.yieldNow

      const next: GeoEvent.GeeStatus = {
        facing: "network",
        setup: { status: "ready", python: "/p", project: "demo" },
        network: { status: "unreachable" },
        runtime: { status: "unknown" },
      }
      yield* writer.commit(yield* writer.claim(), next)
      yield* Effect.yieldNow

      expect(seen).toEqual([next])
    }),
  )

  it.effect("watch emits the current value before any change", () =>
    Effect.gen(function* () {
      const status = yield* GeoStatus.Service
      const writer = yield* status.register("gdal", UNCONFIGURED)
      yield* writer.commit(yield* writer.claim(), READY)

      const first = yield* Stream.runHead(status.watch("gdal"))
      expect(first._tag).toBe("Some")
      if (first._tag === "Some") expect(first.value).toEqual(READY)
    }),
  )

  it.effect("a slot has exactly one writer", () =>
    Effect.gen(function* () {
      const status = yield* GeoStatus.Service
      yield* status.register("gdal", UNCONFIGURED)
      const second = yield* Effect.exit(status.register("gdal", READY))
      expect(second._tag).toBe("Failure")
    }),
  )
})
