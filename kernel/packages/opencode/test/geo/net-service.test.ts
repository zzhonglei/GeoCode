import { afterAll, describe, expect } from "bun:test"
import net from "node:net"
import { Effect, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GeoNet } from "@/geo/net"
import type { NetTypes } from "@/geo/net/types"
import { pollWithTimeout, testEffect } from "../lib/effect"

/* The Net service facade (docs/GEOKERNEL.md §3.3).
 *
 * These cover the parts the sub-module tests cannot: that nothing probes on
 * behalf of a target nobody asked about, and that monitoring starts and stops
 * with the watchers. */

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
    "an unreachable verdict carries what was tried, and what could not be",
    () =>
      Effect.gen(function* () {
        /* The kernel end of the wiring (§3.3).
         *
         * `resolve()` has counted the paths it attempted all along and had
         * nowhere to put them; the SOCKS declaration it refuses was known and
         * dropped. Both now travel to the published status — and both are the
         * kind of field that goes missing without anything failing, because the
         * state is still a perfectly good `unreachable` without them.
         */
        const before = process.env.ALL_PROXY
        // A declaration the resolver deliberately cannot use. It changes
        // nothing about what gets probed — `declared()` refuses it either way —
        // which is exactly why it used to leave no trace at all.
        process.env.ALL_PROXY = "socks5://alice:hunter2@127.0.0.1:1080"
        try {
          const network = yield* GeoNet.Service
          const port = yield* Effect.promise(closedPort)
          yield* network.register({ id: "explained", host: "localhost", port })

          const seen: NetTypes.Reachability[] = []
          yield* Effect.forkScoped(
            Stream.runForEach(network.watch("explained"), (state) => Effect.sync(() => void seen.push(state))),
          )
          yield* pollWithTimeout(
            Effect.sync(() => (seen.some((state) => state.state === "unreachable") ? true : undefined)),
            `monitor never settled; saw ${seen.map((state) => state.state).join(" -> ")}`,
            "20 seconds",
          )

          const settled = seen.find((state) => state.state === "unreachable")!
          if (settled.state !== "unreachable") throw new Error("unreachable")
          // Direct is always attempted first and always recorded. Asserted by
          // membership rather than equality: a developer machine may genuinely
          // have a proxy listening on one of the known ports, and that would be
          // a correct extra entry rather than a failure.
          expect(settled.tried).toContain("direct")
          // And the declaration that could not be attempted, named the way a
          // route is named. The password is not in it because it was never
          // taken: this value is assembled from parsed fields, so it is the
          // whole string that reaches the interface and there is no cleaning
          // step that could have been skipped.
          expect(settled.skipped).toEqual(["socks5:127.0.0.1:1080"])
          for (const item of settled.skipped ?? []) expect(item).not.toContain("hunter2")
        } finally {
          if (before === undefined) delete process.env.ALL_PROXY
          else process.env.ALL_PROXY = before
        }
      }),
    { timeout: 30_000 },
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
    "a machine with no network spends nothing finding that out",
    () =>
      Effect.gen(function* () {
        const network = yield* GeoNet.Service
        const port = yield* Effect.promise(closedPort)
        yield* network.register({ id: "gated", host: "localhost", port })

        // The interface check is the first thing each round asks, and it costs
        // microseconds with no traffic. On a machine that does have an
        // interface it simply passes and the real probing follows — which is
        // what this asserts, since the alternative would be a module that never
        // probes at all.
        const seen: string[] = []
        yield* Effect.forkScoped(
          Stream.runForEach(network.watch("gated"), (state) => Effect.sync(() => void seen.push(state.state))),
        )
        yield* pollWithTimeout(
          Effect.sync(() => (seen.includes("unreachable") ? true : undefined)),
          `the gate never let a round through; saw ${seen.join(" -> ")}`,
          "20 seconds",
        )
        expect(seen).toContain("checking")
      }),
    { timeout: 30000 },
  )

  it.live("an unknown target reports idle rather than inventing an answer", () =>
    Effect.gen(function* () {
      const network = yield* GeoNet.Service
      expect((yield* network.status("never-registered")).state).toBe("idle")
    }),
  )
})
