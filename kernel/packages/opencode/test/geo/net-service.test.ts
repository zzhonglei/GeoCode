import { afterAll, describe, expect } from "bun:test"
import net from "node:net"
import { Effect, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GeoNet } from "@/geo/net"
import { pollWithTimeout, testEffect } from "../lib/effect"

/* The Net service facade (docs/GEOKERNEL.md §3.3).
 *
 * These cover the parts the sub-module tests cannot: that nothing probes on
 * behalf of a target nobody asked about, and that a ranking is measured once,
 * on demand. */

const it = testEffect(LayerNode.compile(LayerNode.group([GeoNet.node])))

const servers: net.Server[] = []
afterAll(() => servers.forEach((server) => server.close()))

/** A port nothing is listening on, so every probe against it fails fast. */
async function closedPort(): Promise<number> {
  const server = net.createServer()
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)),
  )
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe("net service", () => {
  it.live("a registered target nobody watches stays idle", () =>
    Effect.gen(function* () {
      const network = yield* GeoNet.Service
      yield* network.register({ id: "unwatched", host: "localhost", port: yield* Effect.promise(closedPort) })

      // Registering declares interest in a target's existence, not in its
      // connectivity. Probing on registration would spend the network budget of
      // every capability the user has configured but is not using (§3.3 按需驱动).
      yield* Effect.sleep("300 millis")
      expect((yield* network.status("unwatched")).state).toBe("idle")
      expect(yield* network.route("unwatched")).toBeUndefined()
    }),
  )

  it.live(
    "watching starts the monitor, and it settles on a verdict",
    () =>
      Effect.gen(function* () {
        const network = yield* GeoNet.Service
        const port = yield* Effect.promise(closedPort)
        yield* network.register({ id: "watched", host: "localhost", port })

        const seen: string[] = []
        yield* Effect.forkScoped(
          Stream.runForEach(network.watch("watched"), (state) => Effect.sync(() => void seen.push(state.state))),
        )

        // Nothing is listening on that port, so the whole candidate flow runs
        // and comes up empty — the honest answer for a machine that cannot get
        // there by any path we know how to build.
        yield* pollWithTimeout(
          Effect.sync(() => (seen.includes("unreachable") ? true : undefined)),
          `monitor never settled; saw ${seen.join(" -> ")}`,
          "20 seconds",
        )

        // The intermediate state is a member of the set, not an absence of one:
        // resolution takes real handshakes and users watch it happen (§2.4).
        expect(seen[0]).toBe("checking")
        expect(yield* network.route("watched")).toBeUndefined()
      }),
    { timeout: 40000 },
  )

  it.live(
    "the monitor stops when the last watcher goes away",
    () =>
      Effect.gen(function* () {
        const network = yield* GeoNet.Service
        const port = yield* Effect.promise(closedPort)
        yield* network.register({ id: "transient", host: "localhost", port })

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Stream.runHead(network.watch("transient"))
          }),
        )

        // Back to idle: no watcher, no probing, and no state left implying
        // otherwise.
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const state = yield* network.status("transient")
            return state.state === "idle" ? true : undefined
          }),
          "the monitor kept running after its last watcher left",
          "10 seconds",
        )
      }),
    { timeout: 30000 },
  )

  it.live(
    "a ranking is measured on request and then reused",
    () =>
      Effect.gen(function* () {
        const network = yield* GeoNet.Service
        const port = yield* Effect.promise(closedPort)
        yield* network.registerGroup("pool", [`https://localhost:${port}/a`, `https://localhost:${port}/b`])

        const first = yield* network.ranking("pool")
        // Nothing answers, so no pair survives measurement. Dead pairs are
        // dropped rather than parked at the back: a consumer that runs out has
        // its own failover, and carrying them would only make it pay their
        // timeouts twice (§3.3).
        expect(first).toEqual([])

        const second = yield* network.ranking("pool")
        expect(second).toBe(first)
      }),
    { timeout: 40000 },
  )

  it.live("an unknown target reports idle rather than inventing an answer", () =>
    Effect.gen(function* () {
      const network = yield* GeoNet.Service
      expect((yield* network.status("never-registered")).state).toBe("idle")
      expect(yield* network.ranking("never-registered")).toEqual([])
    }),
  )
})
