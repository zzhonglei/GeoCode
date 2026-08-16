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

/* The GEE lifecycle (docs/GEOKERNEL.md §5.4, §5.6–§5.8).
 *
 * Three facts from three places that know nothing of each other, composed so
 * the user faces one problem at a time. What these tests pin down is the
 * wiring between them: when the network subscription opens and closes, what a
 * retry is allowed to re-probe, and that the composition stays a pure function
 * of the three. */

const FILE = path.join(Global.Path.config, "machine.json")
const write = (value: object) => Effect.promise(() => fs.promises.writeFile(FILE, JSON.stringify(value), "utf-8"))
const clear = Effect.promise(() => fs.promises.rm(FILE, { force: true }))
// The config directory is shared across test files; leaving a configuration
// behind would decide another file's starting state.
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
 * A Net whose verdicts are pushed by the test, recording who subscribed.
 *
 * Subscription COUNT is the thing under test: §5.4 defines `idle` as "nobody is
 * watching", so the only honest way to check it is to watch the watching.
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
    /* The published schema's edge.
     *
     * Net now records the two facts that turn "cannot be reached" into
     * something a person can act on — the paths tried, and the declarations
     * that could not be tried at all. Dropping either of them HERE is invisible
     * from both ends: Net still carries it and the interface simply never sees
     * it, which is how the SOCKS skip stayed silent for as long as it did.
     */
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

    // `detail` is the one field that stays behind. It is the raw error, kept as
    // diagnostics rather than handed to a reader (§3.3) — and unlike the other
    // two it has never been through redaction.
    expect(GeeService.toNetwork({ state: "unreachable", detail: "connect ETIMEDOUT" })).toEqual({
      status: "unreachable",
    })

    // The other three states are unchanged by any of this.
    expect(GeeService.toNetwork({ state: "reachable", route: "direct" })).toEqual({
      status: "reachable",
      route: "direct",
    })
    expect(GeeService.toNetwork({ state: "idle" })).toEqual({ status: "idle" })
    expect(GeeService.toNetwork({ state: "checking" })).toEqual({ status: "checking" })
  })

  test("and the wire keeps them, which is a separate question from whether the code does", () => {
    /* `toNetwork` above returns a plain object; the interface receives an
     * ENCODED one, and the encoding is what decides which keys survive.
     *
     * The two come apart in one specific and entirely ordinary way. `GeeNetwork`
     * is a union, and a union member is chosen by matching — so a second
     * `unreachable` member without these fields, sitting anywhere ahead of the
     * real one, silently wins and strips them. That is precisely the residue a
     * merge conflict leaves behind, it type-checks cleanly, and every assertion
     * above still passes because none of them encodes anything.
     */
    const encoded = Schema.encodeUnknownSync(GeoEvent.GeeNetwork)({
      status: "unreachable",
      tried: ["direct", "proxy:127.0.0.1:7890"],
      skipped: ["socks5:127.0.0.1:1080"],
    }) as Record<string, unknown>

    expect(encoded.tried).toEqual(["direct", "proxy:127.0.0.1:7890"])
    expect(encoded.skipped).toEqual(["socks5:127.0.0.1:1080"])
    // Both are optional, so an unreachable with neither is still valid — the
    // offline branch publishes exactly that on purpose.
    expect(Schema.encodeUnknownSync(GeoEvent.GeeNetwork)({ status: "unreachable" })).toEqual({
      status: "unreachable",
    })
  })

  test("local comes before network comes before remote", () => {
    // The priority IS the design (§5.6): one problem at a time, and never the
    // wrong attribution. Telling someone their credentials were rejected while
    // the network is down sends them to re-authenticate over a link that
    // cannot carry the request.
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
    // Diagnostics need the layers the short-circuit hid; the status surface
    // renders "step N of 4" from the setup fact even while facing is runtime.
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

          // Wait for the round rather than reading straight after reload: a
          // reload dispatches the block change and the round that answers it
          // runs on its own fiber, so an immediate read returns whatever the
          // previous state was — including a configuration another test file
          // left in this shared config directory.
          const initial = yield* waitFor((s) => s.setup.status === "unconfigured", "never reached unconfigured")
          // Nothing configured: no subscription exists to spend probes on.
          expect(initial.network.status).toBe("idle")
          expect(initial.facing).toBe("setup")
          expect(yield* Ref.get(net.subscribes)).toBe(0)

          yield* write({ gee: { python, project: "demo-project" } })
          yield* config.reload()

          const ready = yield* waitFor((s) => s.setup.status === "ready", "setup never reached ready")
          // Ready and only ready opens the watch (§5.4). The endpoint is
          // registered as a single target, not a group: these addresses are
          // not interchangeable.
          expect(yield* Ref.get(net.registered)).toEqual([GeeService.TARGET.id])
          expect(yield* Ref.get(net.subscribes)).toBe(1)
          // Subscribed but no verdict yet — Net's own "checking" has not
          // arrived, so the composed answer still faces the network.
          expect(ready.facing).toBe("network")

          // Net speaks; the fact is read, never recomputed here (§8.3).
          yield* PubSub.publish(net.hub, { state: "checking" })
          yield* waitFor((s) => s.network.status === "checking", "checking never arrived")

          yield* PubSub.publish(net.hub, { state: "reachable", route: "proxy:127.0.0.1:7890" })
          const reachable = yield* waitFor((s) => s.network.status === "reachable", "reachable never arrived")
          expect(reachable.network).toEqual({ status: "reachable", route: "proxy:127.0.0.1:7890" })
          // Local ready, network reachable — now the remote layer is the one
          // with something to say. It says "unknown": nothing has asked it,
          // and §5.5 says nothing should until an answer is needed.
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

          // Same file, different value: the second probe reports no
          // credentials, so the chain leaves ready.
          yield* write({ gee: { python, project: "another-project" } })
          yield* config.reload()
          yield* waitFor((s) => s.setup.status === "credentials-missing", "never left ready")

          // The subscription is released — which is the mechanism behind
          // `idle`: not a flag, but monitoring that has stopped (§5.4, §3.3
          // 按需驱动). Watching now would spend probes on a fact the user
          // cannot act on until the local chain is fixed.
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

          // The user just ran the authentication command in a terminal. That
          // touches no config file, so nothing we watch can see it — the tool
          // retry is the only signal, and it is treated as one (§5.8).
          expect(yield* gee.recheck()).toBe(true)
          // Wait for the spawn itself, not for the status: the state is
          // already credentials-missing, so a status predicate would be
          // satisfied by the round that produced it and prove nothing.
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const seen = yield* Ref.get(calls)
              return seen > afterFirst ? seen : undefined
            }),
            "the forced re-probe never spawned",
            "10 seconds",
          )
          expect(yield* Ref.get(calls)).toBe(afterFirst + 1)

          // A burst behind it collapses into that one probe rather than a
          // subprocess per retry.
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

          // `unconfigured` and `project-missing` are fixed by editing the
          // file, and that path is already watched. Re-probing here would be a
          // second trigger for an event we already receive (§5.8).
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
          // Showing "unconfigured" would contradict the file the user is
          // looking at, which plainly says something (§3.1, §8.1). Its own
          // state rather than a probe failure: the interface has to tell "go
          // fix this line" apart from "your Python environment is broken", and
          // it needs the location as a field to do anything with it.
          expect(broken.setup).toMatchObject({ status: "config-error", file: FILE })
          // A position, not merely a non-empty string — see the same assertion
          // in gdal-lifecycle.test.ts for what `length > 0` let by.
          if (broken.setup.status === "config-error") expect(broken.setup.message).toMatch(/line \d+, column \d+/)
          expect(broken.facing).toBe("setup")
        }),
      { timeout: 30000 },
    )
  }
})
