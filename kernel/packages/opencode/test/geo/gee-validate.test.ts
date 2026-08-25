import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Fiber, Layer, PubSub, Ref, Stream } from "effect"
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

/* The remote authorization check (docs/GEOKERNEL.md §5.5). What is held down here is the scheduling: this is the
 * only credentialed call in the system, so it has to happen when an answer is needed and at no other time. */

const FILE = path.join(Global.Path.config, "machine.json")
const write = (value: object) => Effect.promise(() => fs.promises.writeFile(FILE, JSON.stringify(value), "utf-8"))
const clear = Effect.promise(() => fs.promises.rm(FILE, { force: true }))
// A dozen other test files read this same path, so a configuration left behind decides their starting state.
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
      status: () => Effect.succeed({ state: "idle" } as NetTypes.Reachability),
      watch: () => Stream.unwrap(Effect.map(PubSub.subscribe(hub), Stream.fromSubscription)),
      route: () => Effect.succeed(route),
      proxy: () => Effect.succeed(undefined),
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
    // The guidance prints one fix per cause, so a mis-attribution sends the user to fix the wrong thing
    // (gee/guidance.ts).
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

  test("a refusal has to come from the Earth Engine stack, not merely sound like one", () => {
    /* `classify` keys on ordinary Python words and `reject` feeds it a whole script's stderr, so without the
     * origin check a typo or an unwritable output directory caches a failed conclusion and shuts the gate for the
     * whole backoff (gee/index.ts). */
    const local = [
      "PermissionError: [Errno 13] Permission denied: '/Users/me/data/out.tif'",
      "OSError: [Errno 13] Permission denied",
      "SyntaxError: invalid token (<string>, line 3)",
      "ValueError: could not convert string to float: 'login'",
      "KeyError: 'project id'",
      "NameError: name 'ee' is not defined",
      "",
    ]
    for (const stderr of local) expect(GeeValidate.isRemoteRefusal(stderr)).toBe(false)

    // A path holding the word is not an origin, which is why the markers are module and exception identities.
    expect(
      GeeValidate.isRemoteRefusal("PermissionError: [Errno 13] Permission denied: '/Users/me/earthengine/out.tif'"),
    ).toBe(false)

    // A real refusal names the exception's fully qualified type, or the Earth Engine frame it was raised in.
    const refused = [
      'Traceback (most recent call last):\n  File "<string>", line 3, in <module>\n  File "/env/lib/python3.12/site-packages/ee/__init__.py", line 130, in Initialize\nee.ee_exception.EEException: Caller does not have permission to access project demo',
      "ee.ee_exception.EEException: Earth Engine API has not been used in project 12345 before or it is disabled.",
      "google.auth.exceptions.RefreshError: invalid_grant: Token has been expired or revoked.",
    ]
    for (const stderr of refused) expect(GeeValidate.isRemoteRefusal(stderr)).toBe(true)

    // An Earth Engine origin is necessary and not sufficient: a script that failed inside the library on its own
    // arguments is no verdict on authorization.
    expect(GeeValidate.isRemoteRefusal("ee.ee_exception.EEException: Image.load: parameter 'id' is required")).toBe(
      false,
    )
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

          // Reachability is no evidence about authorization, so ten link flaps must not become ten credentialed
          // calls (§5.5).
          expect(yield* validations(rt.labels)).toBe(0)
          const settled = yield* currentStatus
          expect(settled?.runtime).toEqual({ status: "unknown" })
          expect(settled?.facing).toBe("runtime")

          const conclusion = yield* gee.validate()
          expect(conclusion).toEqual({ status: "valid", route: "proxy:127.0.0.1:7890" })
          expect(yield* validations(rt.labels)).toBe(1)

          // Unlike the setup probe, this one really goes out, so it carries Net's route in subprocess form (§5.9).
          const env = (yield* Ref.get(rt.envs)).at(-1)!
          expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890")
          expect(env.GEE_PROJECT).toBe("demo-project")

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
          // Nothing to ask over, so the shown conclusion goes to unknown while the cached one stays.
          expect((yield* currentStatus)?.runtime).toEqual({ status: "unknown" })

          yield* PubSub.publish(net.hub, { state: "reachable", route: "direct" })
          const back = yield* waitFor((s) => s.runtime.status === "valid", "the conclusion never came back")
          // Re-asking here would spend a credentialed call to re-derive what the same exit already answered.
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
          // The conclusion is about the route it was reached over, and this is a different one.
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
            // Our reading of the message can be wrong, so what Google said travels beside it, word for word.
            expect(failed.message).toBe("Project 'projects/nope' not found or deleted.")
          }
          expect(yield* validations(rt.labels)).toBe(1)

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

          // Credentials are revoked without the route changing, and nothing polls, so a cached "valid" would sit
          // there until the user's own refused run corrected it (§5.5).
          expect(
            yield* gee.reject("google.auth.exceptions.RefreshError: invalid_grant: Token has been expired or revoked."),
          ).toBe(true)
          const after = yield* currentStatus
          expect(after?.runtime.status).toBe("failed")
          if (after?.runtime.status === "failed") expect(after.runtime.reason).toBe("credentials-expired")

          // A script with a bug, and a local failure whose words resemble a refusal, both leave it alone.
          expect(yield* gee.reject("NameError: name 'ee' is not defined")).toBe(false)
          expect(yield* gee.reject("PermissionError: [Errno 13] Permission denied: '/out.tif'")).toBe(false)
          expect(yield* validations(rt.labels)).toBe(1)
        }),
      { timeout: 30000 },
    )
  }

  {
    // A validate that takes its time, so a real rejection can land while one is still in flight.
    const slowLabels = Ref.makeUnsafe<string[]>([])
    const slow = Layer.mock(GeoRuntime.Service)({
      run: (options) =>
        Effect.gen(function* () {
          yield* Ref.update(slowLabels, (all) => [...all, options.label ?? "?"])
          if (options.label === "gee:validate") yield* Effect.sleep("400 millis")
          return {
            code: 0,
            reason: "exit",
            stdout: options.label === "gee:setup" ? SETUP_OK : VALID,
            stderr: "",
            durationMs: 1,
            truncated: false,
            drainIncomplete: false,
          } satisfies GeoRuntime.Result
        }),
      killAllSync: () => {},
    })
    const net = scriptedNet()
    const it = graph(slow, net.layer)

    it.live(
      "a refusal that lands mid-check outranks the check it overtook",
      () =>
        Effect.gen(function* () {
          const gee = yield* GeeService.Service
          yield* arrive(net.hub, "direct")

          // The probe's "valid" was true when it was asked and is older than the refusal, so it must not land on
          // top of it (§5.5 真实使用兜底).
          const asking = yield* Effect.forkScoped(gee.validate())
          yield* Effect.sleep("100 millis")
          expect(
            yield* gee.reject("google.auth.exceptions.RefreshError: invalid_grant: Token has been expired or revoked."),
          ).toBe(true)
          yield* Fiber.join(asking)

          const after = yield* currentStatus
          expect(after?.runtime.status).toBe("failed")
          if (after?.runtime.status === "failed") expect(after.runtime.reason).toBe("credentials-expired")

          expect((yield* gee.validate()).status).toBe("failed")
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

          // No interpreter and no project: there is nothing to ask about yet (§5.7).
          expect((yield* gee.validate()).status).toBe("unknown")
          expect(yield* validations(rt.labels)).toBe(0)

          yield* write({ gee: { python, project: "demo-project" } })
          yield* config.reload()
          yield* waitFor((s) => s.setup.status === "ready", "setup never reached ready")

          // Ready, but Net has reached no verdict, so still nothing to ask over.
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

          // The project is half of what was verified, so the conclusion says nothing about this configuration.
          yield* write({ gee: { python, project: "a-different-project" } })
          yield* config.reload()
          // `ready` is already true from the first round; the project it now carries is what tells the second apart.
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
