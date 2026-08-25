import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, PubSub, Ref, Schema, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { GeoEvent } from "@opencode-ai/schema/geo-event"
import { MachineConfig } from "@/geo/config"
import { GeeService } from "@/geo/gee"
import { GeeCompose } from "@/geo/gee/compose"
import { GeeSetup } from "@/geo/gee/setup"
import { GeoNet } from "@/geo/net"
import type { NetTypes } from "@/geo/net/types"
import { GeoRuntime } from "@/geo/runtime"
import { GeoStatus } from "@/geo/status"
import { pollWithTimeout, testEffect } from "../lib/effect"

/* The wiring between the three GEE facts (docs/GEOKERNEL.md §5.4, §5.6–§5.8): when the network subscription opens
 * and closes, what a retry is allowed to re-probe, and that the composition stays a pure function of the three. */

const FILE = path.join(Global.Path.config, "machine.json")
const write = (value: object) => Effect.promise(() => fs.promises.writeFile(FILE, JSON.stringify(value), "utf-8"))
const clear = Effect.promise(() => fs.promises.rm(FILE, { force: true }))
// The config directory is process-global, so a configuration left behind decides another test file's start.
afterAll(() => fs.rmSync(FILE, { force: true }))

const home = fs.mkdtempSync(path.join(os.tmpdir(), "geo-gee-lc-"))
const python = path.join(home, "python3")
fs.writeFileSync(python, "")

const report = (payload: object) => `${GeeSetup.MARKER}${JSON.stringify(payload)}`
const COMPLETE = report({ missing: [], credentials: true, version: "1.7.24" })
const NO_CREDENTIALS = report({ missing: [], credentials: false })

/** A runtime whose probe output is scripted, and which counts spawns. */
function scriptedRuntime(outputs: string[]) {
  const calls = Ref.makeUnsafe(0)
  const layer = Layer.mock(GeoRuntime.Service)({
    run: () =>
      Effect.gen(function* () {
        const call = yield* Ref.updateAndGet(calls, (n) => n + 1)
        return {
          code: 0,
          reason: "exit",
          stdout: outputs[Math.min(call - 1, outputs.length - 1)]!,
          stderr: "",
          durationMs: 1,
          truncated: false,
          drainIncomplete: false,
        } satisfies GeoRuntime.Result
      }),
    killAllSync: () => {},
  })
  return { layer, calls }
}

/**
 * A Net whose verdicts are pushed by the test, counting subscribes and releases: §5.4 defines `idle` as nobody
 * watching, so the count is the only thing that can tell it from a state anyone remembered to set.
 */
function scriptedNet() {
  const hub = PubSub.unbounded<NetTypes.Reachability>().pipe(Effect.runSync)
  const subscribes = Ref.makeUnsafe(0)
  const releases = Ref.makeUnsafe(0)
  const registered = Ref.makeUnsafe<string[]>([])
  const layer = Layer.succeed(
    GeoNet.Service,
    GeoNet.Service.of({
      register: (target) => Ref.update(registered, (all) => [...all, target.id]),
      status: () => Effect.succeed({ state: "idle" } as NetTypes.Reachability),
      watch: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* Ref.update(subscribes, (n) => n + 1)
            yield* Effect.addFinalizer(() => Ref.update(releases, (n) => n + 1))
            const subscription = yield* PubSub.subscribe(hub)
            return Stream.fromSubscription(subscription)
          }),
        ),
      route: () => Effect.succeed(undefined),
      proxy: () => Effect.succeed(undefined),
    }),
  )
  return { layer, hub, subscribes, releases, registered }
}

const currentStatus = Effect.gen(function* () {
  const status = yield* GeoStatus.Service
  return yield* status.current("gee")
})

const waitFor = (predicate: (status: GeoEvent.GeeStatus) => boolean, message: string) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const current = yield* currentStatus
      return current && predicate(current) ? current : undefined
    }),
    message,
    "15 seconds",
  )

describe("gee composition", () => {
  const ready: GeoEvent.GeeSetup = { status: "ready", python: "/p", project: "demo" }
  const reachable: GeoEvent.GeeNetwork = { status: "reachable", route: "direct" }

  test("the last hop to the interface forwards what it was given, and keeps the raw error back", () => {
    // `tried` and `skipped` are what separate a user whose network works only through a refused SOCKS declaration
    // from one with no network at all, and dropping them here is invisible from both ends: Net still records them.
    expect(
      GeeService.toNetwork({
        state: "unreachable",
        detail: "connect ETIMEDOUT",
        tried: ["direct", "proxy:127.0.0.1:7890"],
        skipped: ["socks5://127.0.0.1:1080"],
      }),
    ).toEqual({
      status: "unreachable",
      tried: ["direct", "proxy:127.0.0.1:7890"],
      skipped: ["socks5://127.0.0.1:1080"],
    })

    // `detail` is the one that stays behind: the raw error, and the only one of the three that could be carrying
    // a credential (§3.3).
    expect(GeeService.toNetwork({ state: "unreachable", detail: "connect ETIMEDOUT" })).toEqual({
      status: "unreachable",
    })

    expect(GeeService.toNetwork({ state: "reachable", route: "direct" })).toEqual({
      status: "reachable",
      route: "direct",
    })
    expect(GeeService.toNetwork({ state: "idle" })).toEqual({ status: "idle" })
    expect(GeeService.toNetwork({ state: "checking" })).toEqual({ status: "checking" })
  })

  test("and the wire keeps them, which is a separate question from whether the code does", () => {
    /* The encoding decides which keys survive, and `GeeNetwork` is a union whose member is chosen by matching: a
     * second `unreachable` member without these two fields, anywhere ahead of the real one, wins and strips them.
     * It type-checks, and nothing above encodes anything, so every assertion there still passes. */
    const encoded = Schema.encodeUnknownSync(GeoEvent.GeeNetwork)({
      status: "unreachable",
      tried: ["direct", "proxy:127.0.0.1:7890"],
      skipped: ["socks5:127.0.0.1:1080"],
    }) as Record<string, unknown>

    expect(encoded.tried).toEqual(["direct", "proxy:127.0.0.1:7890"])
    expect(encoded.skipped).toEqual(["socks5:127.0.0.1:1080"])
    // Both optional, because `toNetwork` publishes exactly this when Net recorded neither.
    expect(Schema.encodeUnknownSync(GeoEvent.GeeNetwork)({ status: "unreachable" })).toEqual({
      status: "unreachable",
    })
  })

  test("local comes before network comes before remote", () => {
    // The short-circuit is what keeps the attribution off a layer downstream of the one the user has to fix:
    // "credentials rejected" while the link is down sends them to re-authenticate over it (§5.6).
    expect(GeeCompose.facing({ status: "packages-missing", python: "/p", missing: ["geemap"] }, reachable)).toBe(
      "setup",
    )
    expect(GeeCompose.facing({ status: "checking" }, reachable)).toBe("setup")
    expect(GeeCompose.facing(ready, { status: "unreachable" })).toBe("network")
    expect(GeeCompose.facing(ready, { status: "checking" })).toBe("network")
    expect(GeeCompose.facing(ready, { status: "idle" })).toBe("network")
    expect(GeeCompose.facing(ready, reachable)).toBe("runtime")
  })

  test("all three facts travel with the verdict", () => {
    // The layers the short-circuit hid travel with it: `settlingGee` in tool/geo-tool.ts reads `setup` and
    // `network` beside `facing` to tell an environment still settling from one that is broken.
    const composed = GeeCompose.compose(ready, reachable, { status: "unknown" })
    expect(composed).toEqual({
      facing: "runtime",
      setup: ready,
      network: reachable,
      runtime: { status: "unknown" },
    })
  })
})

describe("gee lifecycle", () => {
  {
    const { layer: runtimeLayer } = scriptedRuntime([COMPLETE])
    const net = scriptedNet()
    const it = testEffect(
      LayerNode.compile(LayerNode.group([GeeService.node, EventV2.node, MachineConfig.node, GeoStatus.node]), [
        [GeoRuntime.node, runtimeLayer],
        [GeoNet.node, net.layer],
      ]),
    )

    it.live(
      "a config edit drives the chain, and readiness is what opens the network watch",
      () =>
        Effect.gen(function* () {
          const config = yield* MachineConfig.Service
          yield* clear
          yield* config.reload()

          // Wait for the round rather than read straight after the reload: the round runs on its own fiber, so an
          // immediate read answers with the previous state — another test file's configuration, at worst.
          const initial = yield* waitFor((s) => s.setup.status === "unconfigured", "never reached unconfigured")
          // Nothing configured, so there is nothing worth spending probes on.
          expect(initial.network.status).toBe("idle")
          expect(initial.facing).toBe("setup")
          expect(yield* Ref.get(net.subscribes)).toBe(0)

          yield* write({ gee: { python, project: "demo-project" } })
          yield* config.reload()

          const ready = yield* waitFor((s) => s.setup.status === "ready", "setup never reached ready")
          // Ready and only ready opens the watch (§5.4), and it opens once.
          expect(yield* Ref.get(net.registered)).toEqual([GeeService.TARGET.id])
          expect(yield* Ref.get(net.subscribes)).toBe(1)
          // Subscribed and no verdict yet, so the composed answer still faces the network.
          expect(ready.facing).toBe("network")

          // Net speaks; the fact is read, never recomputed here (§8.3).
          yield* PubSub.publish(net.hub, { state: "checking" })
          yield* waitFor((s) => s.network.status === "checking", "checking never arrived")

          yield* PubSub.publish(net.hub, { state: "reachable", route: "proxy:127.0.0.1:7890" })
          const reachable = yield* waitFor((s) => s.network.status === "reachable", "reachable never arrived")
          expect(reachable.network).toEqual({ status: "reachable", route: "proxy:127.0.0.1:7890" })
          // "unknown" and not "checking": a credentialed call costs seconds, so nothing asks until an answer is
          // needed (§5.5).
          expect(reachable.facing).toBe("runtime")
          expect(reachable.runtime).toEqual({ status: "unknown" })

          yield* PubSub.publish(net.hub, { state: "unreachable" })
          const down = yield* waitFor((s) => s.network.status === "unreachable", "unreachable never arrived")
          expect(down.facing).toBe("network")
          // The local chain did not become wrong because the link did.
          expect(down.setup.status).toBe("ready")
        }),
      { timeout: 30000 },
    )
  }

  {
    const { layer: runtimeLayer } = scriptedRuntime([COMPLETE, NO_CREDENTIALS])
    const net = scriptedNet()
    const it = testEffect(
      LayerNode.compile(LayerNode.group([GeeService.node, EventV2.node, MachineConfig.node, GeoStatus.node]), [
        [GeoRuntime.node, runtimeLayer],
        [GeoNet.node, net.layer],
      ]),
    )

    it.live(
      "leaving ready releases the network watch",
      () =>
        Effect.gen(function* () {
          const config = yield* MachineConfig.Service
          yield* clear
          yield* write({ gee: { python, project: "demo-project" } })
          yield* config.reload()
          yield* waitFor((s) => s.setup.status === "ready", "setup never reached ready")
          expect(yield* Ref.get(net.subscribes)).toBe(1)

          // Same file, different value, and the scripted probe answers `NO_CREDENTIALS` this time round.
          yield* write({ gee: { python, project: "another-project" } })
          yield* config.reload()
          yield* waitFor((s) => s.setup.status === "credentials-missing", "never left ready")

          // `idle` is not a flag but monitoring that stopped, and the last unsubscribe is what stops it (§5.4,
          // §3.3 按需驱动) — probing on would cost a fact the user cannot act on until setup is fixed.
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const released = yield* Ref.get(net.releases)
              return released >= 1 ? released : undefined
            }),
            "the network watch was never released",
            "10 seconds",
          )
          const after = yield* currentStatus
          expect(after?.network.status).toBe("idle")
          expect(after?.facing).toBe("setup")
        }),
      { timeout: 30000 },
    )
  }

  {
    const { layer: runtimeLayer, calls } = scriptedRuntime([NO_CREDENTIALS, NO_CREDENTIALS, COMPLETE])
    const net = scriptedNet()
    const it = testEffect(
      LayerNode.compile(LayerNode.group([GeeService.node, EventV2.node, MachineConfig.node, GeoStatus.node]), [
        [GeoRuntime.node, runtimeLayer],
        [GeoNet.node, net.layer],
      ]),
    )

    it.live(
      "a retry re-probes what a retry can fix, and debounces the rest",
      () =>
        Effect.gen(function* () {
          const config = yield* MachineConfig.Service
          const gee = yield* GeeService.Service
          yield* clear
          yield* write({ gee: { python, project: "demo-project" } })
          yield* config.reload()
          yield* waitFor((s) => s.setup.status === "credentials-missing", "never reached credentials-missing")
          const afterFirst = yield* Ref.get(calls)

          // The fix for `credentials-missing` is a command in a terminal, which touches no watched file, so the
          // tool retry is the only signal there is (§5.8).
          expect(yield* gee.recheck()).toBe(true)
          // The spawn and not the status: the state is already credentials-missing, so a status predicate is
          // satisfied by the round that produced it.
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const seen = yield* Ref.get(calls)
              return seen > afterFirst ? seen : undefined
            }),
            "the forced re-probe never spawned",
            "10 seconds",
          )
          expect(yield* Ref.get(calls)).toBe(afterFirst + 1)

          // A burst behind it collapses into that one probe rather than a subprocess per retry.
          expect(yield* gee.recheck()).toBe(false)
          expect(yield* gee.recheck()).toBe(false)
          expect(yield* Ref.get(calls)).toBe(afterFirst + 1)
        }),
      { timeout: 30000 },
    )
  }

  {
    const { layer: runtimeLayer, calls } = scriptedRuntime([COMPLETE])
    const net = scriptedNet()
    const it = testEffect(
      LayerNode.compile(LayerNode.group([GeeService.node, EventV2.node, MachineConfig.node, GeoStatus.node]), [
        [GeoRuntime.node, runtimeLayer],
        [GeoNet.node, net.layer],
      ]),
    )

    it.live(
      "states only the config can fix are not re-probed",
      () =>
        Effect.gen(function* () {
          const config = yield* MachineConfig.Service
          const gee = yield* GeeService.Service
          yield* clear
          yield* config.reload()
          yield* waitFor((s) => s.setup.status === "unconfigured", "never reached unconfigured")
          const before = yield* Ref.get(calls)

          // `unconfigured` and `project-missing` are fixed by editing machine.json, which is already watched, so
          // a re-probe here is a second trigger for an event that arrives anyway (§5.8).
          expect(yield* gee.recheck()).toBe(false)
          expect(yield* Ref.get(calls)).toBe(before)
        }),
      { timeout: 30000 },
    )
  }

  {
    const { layer: runtimeLayer } = scriptedRuntime([COMPLETE])
    const net = scriptedNet()
    const it = testEffect(
      LayerNode.compile(LayerNode.group([GeeService.node, EventV2.node, MachineConfig.node, GeoStatus.node]), [
        [GeoRuntime.node, runtimeLayer],
        [GeoNet.node, net.layer],
      ]),
    )

    it.live(
      "an unreadable config file is not an empty one",
      () =>
        Effect.gen(function* () {
          const config = yield* MachineConfig.Service
          yield* clear
          yield* Effect.promise(() => fs.promises.writeFile(FILE, `{ "gee": ,, }`, "utf-8"))
          yield* config.reload()

          const broken = yield* waitFor((s) => s.setup.status === "config-error", "the syntax error never surfaced")
          // Its own state and not `unconfigured`, which contradicts the file the user is looking at, nor a probe
          // failure: "go fix this line" and "your Python environment is broken" are different instructions (§8.1).
          expect(broken.setup).toMatchObject({ status: "config-error", file: FILE })
          // A position, not merely a non-empty string: on a JSONC failure the bare message is the class name
          // (geo/config/loader.ts).
          if (broken.setup.status === "config-error") expect(broken.setup.message).toMatch(/line \d+, column \d+/)
          expect(broken.facing).toBe("setup")
        }),
      { timeout: 30000 },
    )
  }
})
