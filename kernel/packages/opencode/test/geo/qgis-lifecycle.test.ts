import { describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Ref, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { GeoEvent } from "@opencode-ai/schema/geo-event"
import { MachineConfig } from "@/geo/config"
import { GeoQgis, QgisCatalog } from "@/geo/qgis"
import { QgisProbe } from "@/geo/qgis/probe"
import { GeoRuntime } from "@/geo/runtime"
import { GeoStatus } from "@/geo/status"
import { pollWithTimeout, testEffect } from "../lib/effect"

/* The QGIS lifecycle (docs/GEOKERNEL.md §4.8–§4.10).
 *
 * This is where the spine closes into a loop: a machine.json edit travels
 * Config → lifecycle → resolution → Status → typed event, which is the M3.1
 * acceptance the infrastructure milestone deliberately left open at its
 * middle link. */

const FILE = path.join(Global.Path.config, "machine.json")
const write = (value: object) => Effect.promise(() => fs.promises.writeFile(FILE, JSON.stringify(value), "utf-8"))
const writeRaw = (text: string) => Effect.promise(() => fs.promises.writeFile(FILE, text, "utf-8"))

/** A minimal bundle that passes location and assembly; the probe is scripted. */
const bundles = fs.mkdtempSync(path.join(os.tmpdir(), "geo-qgis-lc-"))
function makeBundle(name: string): string {
  const bundle = path.join(bundles, name)
  const macos = path.join(bundle, "Contents", "MacOS")
  fs.mkdirSync(macos, { recursive: true })
  fs.writeFileSync(path.join(macos, "qgis_process"), "")
  fs.writeFileSync(path.join(macos, "python3.12"), "")
  return bundle
}

const PROBE_OK = `${QgisProbe.MARKER}${JSON.stringify({
  pythonVersion: "3.12.11",
  gdalVersion: "3.12.0",
  projTransformReady: true,
  qgisVersion: "3.44.9",
  processingReady: true,
})}`

/** Every probe spawn succeeds; resolution logic still runs for real. */
const runtimeMock = Layer.mock(GeoRuntime.Service)({
  run: () =>
    Effect.succeed({
      code: 0,
      reason: "exit",
      stdout: PROBE_OK,
      stderr: "",
      durationMs: 1,
      truncated: false,
      drainIncomplete: false,
    } satisfies GeoRuntime.Result),
  killAllSync: () => {},
})

/** A catalog whose outcomes are scripted per call, and which counts calls. */
function scriptedCatalog(outcomes: (QgisCatalog.BuildOutcome | "hang")[]) {
  const calls = Ref.makeUnsafe(0)
  const layer = Layer.succeed(
    QgisCatalog.Service,
    QgisCatalog.Service.of({
      build: () =>
        Effect.gen(function* () {
          const call = yield* Ref.updateAndGet(calls, (n) => n + 1)
          const outcome = outcomes[Math.min(call - 1, outcomes.length - 1)]!
          if (outcome === "hang") return yield* Effect.never
          return outcome
        }),
      invalidate: () => Effect.void,
      // The lifecycle only drives build/invalidate; queries are 2c's concern
      // and answer empty here.
      groups: () => Effect.succeed([]),
      inGroup: () => Effect.succeed([]),
      get: () => Effect.succeed(undefined),
      search: () => Effect.succeed([]),
      suggest: () => Effect.succeed([]),
    }),
  )
  return { layer, calls }
}

const waitForStatus = (predicate: (status: GeoEvent.QgisStatus) => boolean, message: string) =>
  Effect.gen(function* () {
    const status = yield* GeoStatus.Service
    return yield* pollWithTimeout(
      Effect.gen(function* () {
        const current = yield* status.current("qgis")
        return current && predicate(current) ? current : undefined
      }),
      message,
      "15 seconds",
    )
  })

describe("qgis lifecycle", () => {
  {
    const it = testEffect(
      LayerNode.compile(LayerNode.group([GeoQgis.node, EventV2.node, MachineConfig.node, GeoStatus.node]), [
        [GeoRuntime.node, runtimeMock],
      ]),
    )

    it.live(
      "a config edit travels the whole loop and comes out as typed events",
      () =>
        Effect.gen(function* () {
          const events = yield* EventV2.Service
          const config = yield* MachineConfig.Service
          const seen: string[] = []
          yield* Effect.forkScoped(
            Stream.runForEach(events.subscribe(GeoEvent.QgisChanged), (event) =>
              Effect.sync(() => void seen.push(event.data.status.status)),
            ),
          )

          yield* write({ qgis: "/nonexistent/qgis/python3" })
          yield* config.reload()

          yield* waitForStatus((s) => s.status === "path-missing", `never settled; events: ${seen.join(" -> ")}`)
          // The intermediate state is a member of the flow, not an absence:
          // users watch resolution happen (§2.4 principle 4).
          expect(seen).toContain("resolving")
          expect(seen).toContain("path-missing")
        }),
      { timeout: 30000 },
    )

    it.live(
      "an unparsable file is shown as what it is, with its location",
      () =>
        Effect.gen(function* () {
          const config = yield* MachineConfig.Service
          yield* writeRaw(`{ "qgis": ,, }`)
          yield* config.reload()

          const status = yield* waitForStatus((s) => s.status === "config-error", "config-error never arrived")
          // Calling this "unconfigured" would contradict the file the user has
          // open in front of them (§3.1).
          if (status.status === "config-error") {
            expect(status.file).toBe(FILE)
            expect(status.message.length).toBeGreaterThan(0)
          }
        }),
      { timeout: 30000 },
    )

    it.live(
      "an emptied config returns the slot to unconfigured",
      () =>
        Effect.gen(function* () {
          const config = yield* MachineConfig.Service
          yield* write({})
          yield* config.reload()
          yield* waitForStatus((s) => s.status === "unconfigured", "unconfigured never arrived")
        }),
      { timeout: 30000 },
    )
  }

  {
    const catalog = scriptedCatalog([{ ok: true }])
    const it = testEffect(
      LayerNode.compile(LayerNode.group([GeoQgis.node, EventV2.node, MachineConfig.node, GeoStatus.node]), [
        [GeoRuntime.node, runtimeMock],
        [QgisCatalog.node, catalog.layer],
      ]),
    )

    it.live(
      "both stages land in order and the gate opens on the verified environment",
      () =>
        Effect.gen(function* () {
          const qgis = yield* GeoQgis.Service
          const config = yield* MachineConfig.Service
          const events = yield* EventV2.Service
          const stages: string[] = []
          yield* Effect.forkScoped(
            Stream.runForEach(events.subscribe(GeoEvent.QgisChanged), (event) =>
              Effect.sync(() => {
                const status = event.data.status
                stages.push(status.status === "ready" ? `ready:${status.catalog}` : status.status)
              }),
            ),
          )

          // Before anything: the gate is shut and says why.
          const before = yield* qgis.gate()
          expect(before.ok).toBe(false)

          yield* write({ qgis: makeBundle("QGIS-A.app") })
          yield* config.reload()

          yield* waitForStatus(
            (s) => s.status === "ready" && s.catalog === "ready",
            `never became ready; stages: ${stages.join(" -> ")}`,
          )
          // Each stage commits as it lands (§4.10): the building state is
          // visible, not swallowed by the round's final result.
          expect(stages).toContain("ready:building")
          expect(stages).toContain("ready:ready")

          const gate = yield* qgis.gate()
          expect(gate.ok).toBe(true)
          if (gate.ok) {
            expect(gate.environment.versions.qgis).toBe("3.44.9")
            expect(gate.environment.processing).toBe(true)
            // The verified environment is handed over directly — execution
            // receives THIS object, it does not re-check (§4.9, §9.1).
            expect(gate.environment.python.endsWith("python3.12")).toBe(true)
          }
        }),
      { timeout: 30000 },
    )
  }

  {
    // Default stub catalog: honest failure until the real exporter lands.
    const it = testEffect(
      LayerNode.compile(LayerNode.group([GeoQgis.node, EventV2.node, MachineConfig.node, GeoStatus.node]), [
        [GeoRuntime.node, runtimeMock],
      ]),
    )

    it.live(
      "a failed catalog keeps the unified gate shut for all three capabilities",
      () =>
        Effect.gen(function* () {
          const qgis = yield* GeoQgis.Service
          const config = yield* MachineConfig.Service
          yield* write({ qgis: makeBundle("QGIS-B.app") })
          yield* config.reload()

          const status = yield* waitForStatus(
            (s) => s.status === "ready" && s.catalog === "failed",
            "catalog failure never arrived",
          )
          if (status.status === "ready") expect(status.catalogError).toBeTruthy()

          // §4.9, and the §12 tradeoff accepted with it: data reading also
          // waits on the catalog, because one environment gets one verdict.
          const gate = yield* qgis.gate()
          expect(gate.ok).toBe(false)
        }),
      { timeout: 30000 },
    )
  }

  {
    const catalog = scriptedCatalog(["hang", { ok: true }])
    const it = testEffect(
      LayerNode.compile(LayerNode.group([GeoQgis.node, EventV2.node, MachineConfig.node, GeoStatus.node]), [
        [GeoRuntime.node, runtimeMock],
        [QgisCatalog.node, catalog.layer],
      ]),
    )

    it.live(
      "a new round interrupts the catalog build the old one left in flight",
      () =>
        Effect.gen(function* () {
          const config = yield* MachineConfig.Service
          yield* write({ qgis: makeBundle("QGIS-C.app") })
          yield* config.reload()

          // Round one is now stuck inside its catalog build, forever.
          yield* waitForStatus((s) => s.status === "ready" && s.catalog === "building", "round one never got stuck")

          yield* write({ qgis: makeBundle("QGIS-D.app") })
          yield* config.reload()

          // Round two runs to completion: the catalog belongs to the
          // verification that produced it, so round one's build was voided,
          // not awaited (§4.8 阶段依附).
          yield* waitForStatus((s) => s.status === "ready" && s.catalog === "ready", "round two never completed")
          expect(yield* Ref.get(catalog.calls)).toBe(2)

          // And nothing from round one lands afterwards: its token died with
          // it (§4.8 代际守卫). Give any straggler a moment to try.
          yield* Effect.sleep("300 millis")
          const status = yield* GeoStatus.Service
          const final = yield* status.current("qgis")
          expect(final?.status === "ready" && final.catalog).toBe("ready")
        }),
      { timeout: 30000 },
    )
  }
})
