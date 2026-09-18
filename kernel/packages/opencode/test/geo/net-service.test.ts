import { afterAll, describe, expect } from "bun:test"
import net from "node:net"
import { Effect, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GeoNet } from "@/geo/net"
import type { NetTypes } from "@/geo/net/types"
import { pollWithTimeout, testEffect } from "../lib/effect"

/* The Net service facade (docs/GEOKERNEL.md §3.3). */

const it = testEffect(LayerNode.compile(LayerNode.group([GeoNet.node])))

const servers: net.Server[] = []
afterAll(() => servers.forEach((server) => server.close()))

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

      yield* Effect.sleep("300 millis")
      expect((yield* network.status("unwatched")).state).toBe("idle")
      expect(yield* network.route("unwatched")).toBeUndefined()
    }),
  )

  it.live(
    "an unreachable verdict carries what was tried, and what could not be",
    () =>
      Effect.gen(function* () {
        const before = process.env.ALL_PROXY
        // `normalize` refuses SOCKS, so this can only ever reach the status as a skip, never as a route.
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
          // Membership, not equality: a real proxy on one of the known ports would be a correct extra entry.
          expect(settled.tried).toContain("direct")
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

        yield* pollWithTimeout(
          Effect.sync(() => (seen.includes("unreachable") ? true : undefined)),
          `monitor never settled; saw ${seen.join(" -> ")}`,
          "20 seconds",
        )

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
