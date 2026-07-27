import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, PubSub, Ref, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import { MachineConfig } from "@/geo/config"
import { GeeService } from "@/geo/gee"
import { GeeSetup } from "@/geo/gee/setup"
import { GeeValidate } from "@/geo/gee/validate"
import { GeoNet } from "@/geo/net"
import type { NetTypes } from "@/geo/net/types"
import { GeoRuntime } from "@/geo/runtime"
import { GeoStatus } from "@/geo/status"
import { pollWithTimeout, testEffect } from "../lib/effect"

/* The remote authorization check (docs/GEOKERNEL.md §5.5).
 *
 * The check itself ran against the real project on this machine: valid in
 * about five seconds, and a deliberately wrong project came back with
 * "Project 'projects/…' not found or deleted." — which is where the
 * attribution patterns below were confirmed rather than assumed.
 *
 * What these tests hold down is the SCHEDULING, because that is the whole
 * design: this is the only credentialed call in the system, so it happens when
 * an answer is needed and at no other time. */

const FILE = path.join(Global.Path.config, "machine.json")
const write = (value: object) => Effect.promise(() => fs.promises.writeFile(FILE, JSON.stringify(value), "utf-8"))
const clear = Effect.promise(() => fs.promises.rm(FILE, { force: true }))
// The config directory is shared across test files; leaving a configuration
// behind would decide another file's starting state.
afterAll(() => fs.rmSync(FILE, { force: true }))

const home = fs.mkdtempSync(path.join(os.tmpdir(), "geo-gee-rt-"))
const python = path.join(home, "python3")
fs.writeFileSync(python, "")

const SETUP_OK = `${GeeSetup.MARKER}${JSON.stringify({ missing: [], credentials: true, version: "1.7.24" })}`
const VALID = `${GeeValidate.MARKER}${JSON.stringify({ ok: true })}`
const REJECTED = `${GeeValidate.MARKER}${JSON.stringify({
  ok: false,
  type: "EEException",
  message: "Project 'projects/nope' not found or deleted.",
})}`

/** Records every spawn by label, so "did it call the remote?" is answerable. */
function recordingRuntime(byLabel: Record<string, string>) {
  const labels = Ref.makeUnsafe<string[]>([])
  const envs = Ref.makeUnsafe<Record<string, string>[]>([])
  const layer = Layer.mock(GeoRuntime.Service)({
    run: (options) =>
      Effect.gen(function* () {
        yield* Ref.update(labels, (all) => [...all, options.label ?? "?"])
        yield* Ref.update(envs, (all) => [...all, (options.env ?? {}) as Record<string, string>])
        return {
          code: 0,
          reason: "exit",
          stdout: byLabel[options.label ?? ""] ?? "",
          stderr: "",
          durationMs: 1,
          truncated: false,
          drainIncomplete: false,
        } satisfies GeoRuntime.Result
      }),
    killAllSync: () => {},
  })
  return { layer, labels, envs }
}

function scriptedNet(route: NetTypes.Route = { kind: "direct" }) {
  const hub = PubSub.unbounded<NetTypes.Reachability>().pipe(Effect.runSync)
  const layer = Layer.succeed(
    GeoNet.Service,
    GeoNet.Service.of({
      register: () => Effect.void,
      registerGroup: () => Effect.void,
      status: () => Effect.succeed({ state: "idle" } as NetTypes.Reachability),
      watch: () => Stream.unwrap(Effect.map(PubSub.subscribe(hub), Stream.fromSubscription)),
      route: () => Effect.succeed(route),
      ranking: () => Effect.succeed([]),
    }),
  )
  return { layer, hub }
}

const validations = (labels: Ref.Ref<string[]>) =>
  Effect.map(Ref.get(labels), (all) => all.filter((label) => label === "gee:validate").length)

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

describe("gee rejection attribution", () => {
  test("real remote messages land on the right cause", () => {
    // The wrong-project message is verbatim from this machine; the rest are
    // the shapes the ported patterns were built around. Order matters: an
    // interface-not-enabled rejection also says "permission", and answering
    // "permission denied" sends the user to the wrong console page.
    expect(GeeValidate.classify("Project 'projects/nope' not found or deleted.")).toBe("project-invalid")
    expect(
      GeeValidate.classify(
        "Earth Engine API has not been used in project 12345 before or it is disabled. Enable it by visiting…",
      ),
    ).toBe("api-disabled")
    expect(GeeValidate.classify("Caller does not have permission to access the project")).toBe("permission-denied")
    expect(GeeValidate.classify("invalid_grant: Token has been expired or revoked.")).toBe("credentials-expired")
    expect(GeeValidate.classify("Image.load: parameter 'id' is required")).toBe("unknown")
  })

  test("only an attributable message counts as a rejection", () => {
    // The feedback loop turns a refused run into a status update. A script
    // that failed on its own logic must not invalidate a good authorization.
    expect(GeeValidate.isRejection("Project 'projects/nope' not found or deleted.")).toBe(true)
    expect(GeeValidate.isRejection("NameError: name 'ee' is not defined")).toBe(false)
    expect(GeeValidate.isRejection("")).toBe(false)
  })
})

describe("gee remote authorization", () => {
  const graph = (runtimeLayer: Layer.Layer<GeoRuntime.Service>, netLayer: Layer.Layer<GeoNet.Service>) =>
    testEffect(
      LayerNode.compile(LayerNode.group([GeeService.node, EventV2.node, MachineConfig.node, GeoStatus.node]), [
        [GeoRuntime.node, runtimeLayer],
        [GeoNet.node, netLayer],
      ]),
    )

  const arrive = (hub: PubSub.PubSub<NetTypes.Reachability>, route: string) =>
    Effect.gen(function* () {
      const config = yield* MachineConfig.Service
      yield* clear
      yield* write({ gee: { python, project: "demo-project" } })
      yield* config.reload()
      yield* waitFor((s) => s.setup.status === "ready", "setup never reached ready")
      yield* PubSub.publish(hub, { state: "reachable", route })
      yield* waitFor((s) => s.network.status === "reachable", "never became reachable")
    })

  {
    const rt = recordingRuntime({ "gee:setup": SETUP_OK, "gee:validate": VALID })
    const net = scriptedNet({ kind: "proxy", url: "http://127.0.0.1:7890" })
    const it = graph(rt.layer, net.layer)

    it.live(
      "reaching the network does not ask the remote; being asked does",
      () =>
        Effect.gen(function* () {
          const gee = yield* GeeService.Service
          yield* arrive(net.hub, "proxy:127.0.0.1:7890")

          // The whole point of §5.5: connectivity changing is not evidence
          // about authorization, and this is the one call that carries
          // credentials. Ten link flaps must not become ten calls.
          expect(yield* validations(rt.labels)).toBe(0)
          const settled = yield* currentStatus
          expect(settled?.runtime).toEqual({ status: "unknown" })
          expect(settled?.facing).toBe("runtime")

          const conclusion = yield* gee.validate()
          expect(conclusion).toEqual({ status: "valid", route: "proxy:127.0.0.1:7890" })
          expect(yield* validations(rt.labels)).toBe(1)

          // The check runs WITH the route, unlike the setup probe which runs
          // deliberately without one — this one makes a real remote call.
          const env = (yield* Ref.get(rt.envs)).at(-1)!
          expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890")
          expect(env.GEE_PROJECT).toBe("demo-project")

          // A second ask over the same route is free.
          expect(yield* gee.validate()).toEqual({ status: "valid", route: "proxy:127.0.0.1:7890" })
          expect(yield* validations(rt.labels)).toBe(1)
        }),
      { timeout: 30000 },
    )
  }

  {
    const rt = recordingRuntime({ "gee:setup": SETUP_OK, "gee:validate": VALID })
    const net = scriptedNet()
    const it = graph(rt.layer, net.layer)

    it.live(
      "an outage and return to the same route reuses the conclusion",
      () =>
        Effect.gen(function* () {
          const gee = yield* GeeService.Service
          yield* arrive(net.hub, "direct")
          yield* gee.validate()
          expect(yield* validations(rt.labels)).toBe(1)

          yield* PubSub.publish(net.hub, { state: "unreachable" })
          yield* waitFor((s) => s.network.status === "unreachable", "never went down")
          // Down means we cannot ask, so the displayed conclusion is unknown —
          // but the knowledge is not thrown away.
          expect((yield* currentStatus)?.runtime).toEqual({ status: "unknown" })

          yield* PubSub.publish(net.hub, { state: "reachable", route: "direct" })
          const back = yield* waitFor((s) => s.runtime.status === "valid", "the conclusion never came back")
          // Same exit, so the same conclusion holds. This is where the rule
          // differs from the ranking's (§3.3), which invalidates on any change
          // including gone-and-back: latency loses its reference across an
          // outage, authorization does not.
          expect(back.runtime).toEqual({ status: "valid", route: "direct" })
          expect(yield* validations(rt.labels)).toBe(1)
        }),
      { timeout: 30000 },
    )
  }

  {
    const rt = recordingRuntime({ "gee:setup": SETUP_OK, "gee:validate": VALID })
    const net = scriptedNet()
    const it = graph(rt.layer, net.layer)

    it.live(
      "a genuinely different route drops the conclusion",
      () =>
        Effect.gen(function* () {
          const gee = yield* GeeService.Service
          yield* arrive(net.hub, "direct")
          yield* gee.validate()
          expect(yield* validations(rt.labels)).toBe(1)

          yield* PubSub.publish(net.hub, { state: "reachable", route: "proxy:10.0.0.1:8080" })
          yield* waitFor(
            (s) => s.network.status === "reachable" && s.network.route.startsWith("proxy"),
            "route never changed",
          )
          // The exit really did change, so the old conclusion no longer
          // describes anything: back to unknown, and the next ask pays.
          expect((yield* currentStatus)?.runtime).toEqual({ status: "unknown" })
          yield* gee.validate()
          expect(yield* validations(rt.labels)).toBe(2)
        }),
      { timeout: 30000 },
    )
  }

  {
    const rt = recordingRuntime({ "gee:setup": SETUP_OK, "gee:validate": REJECTED })
    const net = scriptedNet()
    const it = graph(rt.layer, net.layer)

    it.live(
      "a rejection is attributed, kept verbatim, and not re-asked immediately",
      () =>
        Effect.gen(function* () {
          const gee = yield* GeeService.Service
          yield* arrive(net.hub, "direct")

          const failed = yield* gee.validate()
          expect(failed.status).toBe("failed")
          if (failed.status === "failed") {
            expect(failed.reason).toBe("project-invalid")
            // Our reading of the message can be wrong, so what the remote
            // actually said travels beside it, word for word.
            expect(failed.message).toBe("Project 'projects/nope' not found or deleted.")
          }
          expect(yield* validations(rt.labels)).toBe(1)

          // Backoff: a caller retrying in a loop does not become a
          // credentialed call per try.
          yield* gee.validate()
          yield* gee.validate()
          expect(yield* validations(rt.labels)).toBe(1)
        }),
      { timeout: 30000 },
    )
  }

  {
    const rt = recordingRuntime({ "gee:setup": SETUP_OK, "gee:validate": VALID })
    const net = scriptedNet()
    const it = graph(rt.layer, net.layer)

    it.live(
      "a refused run closes the loop that no polling would close",
      () =>
        Effect.gen(function* () {
          const gee = yield* GeeService.Service
          yield* arrive(net.hub, "direct")
          expect((yield* gee.validate()).status).toBe("valid")

          // Credentials get revoked without the route changing, so a cached
          // "valid" can sit there indefinitely. Nothing polls for it — instead
          // the user's own call is the check, being the same operation against
          // the same remote with the same credentials (§5.5).
          expect(yield* gee.reject("invalid_grant: Token has been expired or revoked.")).toBe(true)
          const after = yield* currentStatus
          expect(after?.runtime.status).toBe("failed")
          if (after?.runtime.status === "failed") expect(after.runtime.reason).toBe("credentials-expired")

          // And a script that simply had a bug leaves the conclusion alone.
          expect(yield* gee.reject("NameError: name 'ee' is not defined")).toBe(false)
          // No remote call was made by either report.
          expect(yield* validations(rt.labels)).toBe(1)
        }),
      { timeout: 30000 },
    )
  }

  {
    const rt = recordingRuntime({ "gee:setup": SETUP_OK, "gee:validate": VALID })
    const net = scriptedNet()
    const it = graph(rt.layer, net.layer)

    it.live(
      "nothing is asked while a lower layer is the one with the problem",
      () =>
        Effect.gen(function* () {
          const config = yield* MachineConfig.Service
          const gee = yield* GeeService.Service
          yield* clear
          yield* config.reload()
          yield* waitFor((s) => s.setup.status === "unconfigured", "never reached unconfigured")

          // Local chain incomplete: a credentialed call could only answer a
          // question nobody is in a position to act on (§5.7).
          expect((yield* gee.validate()).status).toBe("unknown")
          expect(yield* validations(rt.labels)).toBe(0)

          yield* write({ gee: { python, project: "demo-project" } })
          yield* config.reload()
          yield* waitFor((s) => s.setup.status === "ready", "setup never reached ready")

          // Ready but no verdict from Net yet — still nothing to ask over.
          expect((yield* gee.validate()).status).toBe("unknown")
          expect(yield* validations(rt.labels)).toBe(0)
        }),
      { timeout: 30000 },
    )
  }

  {
    const rt = recordingRuntime({ "gee:setup": SETUP_OK, "gee:validate": VALID })
    const net = scriptedNet()
    const it = graph(rt.layer, net.layer)

    it.live(
      "changing the configuration drops the conclusion it was about",
      () =>
        Effect.gen(function* () {
          const config = yield* MachineConfig.Service
          const gee = yield* GeeService.Service
          yield* arrive(net.hub, "direct")
          expect((yield* gee.validate()).status).toBe("valid")
          expect(yield* validations(rt.labels)).toBe(1)

          // The project identifier is half of what was verified, so a config
          // edit makes the conclusion meaningless regardless of the route.
          yield* write({ gee: { python, project: "a-different-project" } })
          yield* config.reload()
          // Wait for the SECOND round specifically. "ready" alone is already
          // true from the first one, so it would prove nothing — the project
          // the ready state now carries is what tells them apart.
          yield* waitFor(
            (s) => s.setup.status === "ready" && s.setup.project === "a-different-project",
            "the second round never settled",
          )
          yield* PubSub.publish(net.hub, { state: "reachable", route: "direct" })
          yield* waitFor((s) => s.network.status === "reachable", "never became reachable again")

          expect((yield* currentStatus)?.runtime).toEqual({ status: "unknown" })
          yield* gee.validate()
          expect(yield* validations(rt.labels)).toBe(2)
        }),
      { timeout: 30000 },
    )
  }
})
