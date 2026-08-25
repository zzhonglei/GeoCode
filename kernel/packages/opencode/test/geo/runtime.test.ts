import { expect, describe } from "bun:test"
import { Effect, Fiber, Ref } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GeoRuntime } from "@/geo/runtime"
import { pollWithTimeout, testEffect } from "../lib/effect"

/* Runtime, the subprocess primitive of GeoKernel (docs/GEOKERNEL.md §3.2): what it fixes rather than what callers
 * choose — the clocks, the two deliveries, and how an execution is made to end. */

const it = testEffect(LayerNode.compile(LayerNode.group([GeoRuntime.node])))

/** Runs a snippet under the same interpreter the tests run under. */
const script = (source: string) => ({ command: process.execPath, args: ["-e", source] })

/** Prints `count` lines `gapMs` apart, then exits cleanly. */
const ticker = (count: number, gapMs: number) =>
  script(
    `let i = 0
     const t = setInterval(() => {
       console.log("chunk" + i)
       if (++i >= ${count}) { clearInterval(t); process.exit(0) }
     }, ${gapMs})`,
  )

/** True while the OS still knows about this pid. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitUntilGone = (pid: number, message: string) =>
  pollWithTimeout(
    Effect.sync(() => (alive(pid) ? undefined : true)),
    message,
    "15 seconds",
  )

describe("geo runtime", () => {
  it.live("collect mode returns the whole output and the exit code", () =>
    Effect.gen(function* () {
      const runtime = yield* GeoRuntime.Service
      const result = yield* runtime.run({
        ...script(`console.log("first"); console.error("problem"); console.log("last")`),
        delivery: { mode: "collect" },
        clocks: { total: "20 seconds" },
      })

      expect(result.reason).toBe("exit")
      expect(result.code).toBe(0)
      // Draining runs on the normal-exit path too, or the last line goes with whatever was still in flight.
      expect(result.stdout).toContain("first")
      expect(result.stdout).toContain("last")
      expect(result.stderr).toContain("problem")
      expect(result.truncated).toBe(false)
      expect(result.drainIncomplete).toBe(false)
    }),
  )

  it.live("incremental mode delivers chunks and accumulates nothing", () =>
    Effect.gen(function* () {
      const runtime = yield* GeoRuntime.Service
      const seen: string[] = []
      const result = yield* runtime.run({
        ...ticker(3, 50),
        delivery: { mode: "incremental", onChunk: (chunk) => Effect.sync(() => void seen.push(chunk)) },
        clocks: { idle: "10 seconds" },
      })

      expect(result.reason).toBe("exit")
      expect(seen.join("")).toContain("chunk0")
      expect(seen.join("")).toContain("chunk2")
      expect(result.stdout).toBe("")
    }),
  )

  it.live(
    "a slow consumer does not spend the task's idle budget",
    () =>
      Effect.gen(function* () {
        const runtime = yield* GeoRuntime.Service
        const seen = yield* Ref.make(0)

        // Output every 300ms, 700ms to handle each of them, and the idle limit between the two: this goes red if
        // the reader is ever recoupled to the consumer, since the gaps the clock sees would become the 700ms ones.
        const result = yield* runtime.run({
          ...ticker(5, 300),
          delivery: {
            mode: "incremental",
            onChunk: () => Effect.sleep("700 millis").pipe(Effect.andThen(Ref.update(seen, (n) => n + 1))),
          },
          clocks: { idle: "600 millis", total: "30 seconds" },
        })

        expect(result.reason).toBe("exit")
        expect(yield* Ref.get(seen)).toBe(5)
      }),
    { timeout: 30000 },
  )

  it.live(
    "the total clock catches a task that never stops talking",
    () =>
      Effect.gen(function* () {
        const runtime = yield* GeoRuntime.Service
        // Never exits and never goes quiet, the shape a task stuck in a logging loop takes, and the one the idle
        // clock alone would wait out forever (§3.2).
        const result = yield* runtime.run({
          ...script(`setInterval(() => console.log("still here"), 50)`),
          delivery: { mode: "incremental", onChunk: () => Effect.void },
          clocks: { idle: "30 seconds", total: "1 second" },
        })

        expect(result.reason).toBe("timeout")
        expect(result.code).toBeNull()
      }),
    { timeout: 30000 },
  )

  it.live(
    "the idle clock catches a task that goes quiet",
    () =>
      Effect.gen(function* () {
        const runtime = yield* GeoRuntime.Service
        const result = yield* runtime.run({
          ...script(`console.log("hello"); setTimeout(() => {}, 60000)`),
          delivery: { mode: "incremental", onChunk: () => Effect.void },
          clocks: { idle: "800 millis" },
        })

        expect(result.reason).toBe("idle")
      }),
    { timeout: 30000 },
  )

  it.live(
    "an interrupt keeps whatever output already arrived",
    () =>
      Effect.gen(function* () {
        const runtime = yield* GeoRuntime.Service
        const controller = new AbortController()
        yield* Effect.forkScoped(Effect.sleep("500 millis").pipe(Effect.andThen(Effect.sync(() => controller.abort()))))

        const result = yield* runtime.run({
          ...script(`console.log("before interrupt"); setTimeout(() => {}, 60000)`),
          delivery: { mode: "collect" },
          clocks: { total: "30 seconds" },
          abort: controller.signal,
        })

        expect(result.reason).toBe("abort")
        expect(result.stdout).toContain("before interrupt")
      }),
    { timeout: 30000 },
  )

  it.live(
    "collect mode stops a task that floods its cap",
    () =>
      Effect.gen(function* () {
        const runtime = yield* GeoRuntime.Service
        const result = yield* runtime.run({
          ...script(`setInterval(() => console.log("x".repeat(100000)), 10)`),
          delivery: { mode: "collect", limit: 200_000 },
          // Present only so a regression fails the test instead of hanging it.
          clocks: { total: "20 seconds" },
        })

        expect(result.reason).toBe("output-limit")
        expect(result.truncated).toBe(true)
        expect(result.stdout.length).toBeLessThanOrEqual(200_000)
      }),
    { timeout: 40000 },
  )

  it.live("the environment is overlaid on the host's, not swapped for it", () =>
    Effect.gen(function* () {
      const runtime = yield* GeoRuntime.Service
      const result = yield* runtime.run({
        ...script(`console.log(process.env.GEO_TEST_MARKER + "|" + (process.env.PATH ? "inherited" : "lost"))`),
        delivery: { mode: "collect" },
        clocks: { total: "20 seconds" },
        env: { GEO_TEST_MARKER: "overlaid" },
      })

      expect(result.stdout).toContain("overlaid|inherited")
    }),
  )

  it.live(
    "a running execution can be stopped from outside and still reports its output",
    () =>
      Effect.gen(function* () {
        const runtime = yield* GeoRuntime.Service
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* runtime.start({
              ...script(`console.log("work started"); setInterval(() => {}, 1000)`),
              delivery: { mode: "collect" },
              clocks: { total: "60 seconds" },
              label: "qgis:buffer",
            })

            yield* pollWithTimeout(
              Effect.gen(function* () {
                const so_far = yield* handle.partial()
                return so_far.stdout.includes("work started") ? true : undefined
              }),
              "no partial output while running",
            )

            const running = yield* runtime.list()
            expect(running.map((item) => item.label)).toContain("qgis:buffer")

            // The user clicking stop on a QGIS run.
            yield* handle.terminate()
            // Twice, because a stop button can be pressed twice and a teardown can race a user action.
            yield* handle.terminate()
            return yield* handle.result
          }),
        )

        expect(result.reason).toBe("abort")
        expect(result.stdout).toContain("work started")
      }),
    { timeout: 30000 },
  )

  it.live(
    "terminateAll stops everything and the registry empties",
    () =>
      Effect.gen(function* () {
        const runtime = yield* GeoRuntime.Service
        yield* Effect.scoped(
          Effect.gen(function* () {
            const first = yield* runtime.start({
              ...script(`setInterval(() => {}, 1000)`),
              delivery: { mode: "collect" },
              clocks: { total: "60 seconds" },
            })
            const second = yield* runtime.start({
              ...script(`setInterval(() => {}, 1000)`),
              delivery: { mode: "collect" },
              clocks: { total: "60 seconds" },
            })
            expect((yield* runtime.list()).length).toBe(2)

            yield* runtime.terminateAll()
            expect((yield* first.result).reason).toBe("abort")
            expect((yield* second.result).reason).toBe("abort")
          }),
        )
        expect((yield* runtime.list()).length).toBe(0)
      }),
    { timeout: 30000 },
  )

  it.live(
    "interrupting the owner kills the process tree",
    () =>
      Effect.gen(function* () {
        const runtime = yield* GeoRuntime.Service
        const pids = yield* Ref.make<{ child?: number; grandchild?: number }>({})

        // A QGIS run is never one process, and killing only the direct child leaves the rest holding the streams.
        const fiber = yield* Effect.forkScoped(
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* runtime.start({
                ...script(
                  `const { spawn } = require("child_process")
                   const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
                   console.log("GRANDCHILD:" + g.pid)
                   setInterval(() => {}, 1000)`,
                ),
                delivery: {
                  mode: "incremental",
                  onChunk: (chunk) =>
                    Ref.update(pids, (current) => {
                      const match = /GRANDCHILD:(\d+)/.exec(chunk)
                      return match ? { ...current, grandchild: Number(match[1]) } : current
                    }),
                },
                clocks: { total: "60 seconds" },
              })
              yield* Ref.update(pids, (current) => ({ ...current, child: handle.pid }))
              yield* handle.result
            }),
          ),
        )

        const found = yield* pollWithTimeout(
          Effect.gen(function* () {
            const current = yield* Ref.get(pids)
            return current.child !== undefined && current.grandchild !== undefined ? current : undefined
          }),
          "the child never reported its grandchild",
        )

        // Neither the signal nor terminate: the owning fiber is interrupted, as when a session is torn down mid-run.
        yield* Fiber.interrupt(fiber)

        yield* waitUntilGone(found.child!, "the child survived interruption")
        yield* waitUntilGone(found.grandchild!, "the grandchild was orphaned")
      }),
    { timeout: 40000 },
  )

  it.live("a finished execution leaves the registry even while its scope stays open", () =>
    Effect.gen(function* () {
      const runtime = yield* GeoRuntime.Service
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* runtime.start({
            ...script(`console.log("done")`),
            delivery: { mode: "collect" },
            clocks: { total: "20 seconds" },
          })
          expect((yield* handle.result).reason).toBe("exit")

          // A scope can outlive many executions, and killAllSync over a finished entry would signal a reused pid.
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const running = yield* runtime.list()
              return running.some((item) => item.id === handle.id) ? undefined : true
            }),
            "the finished execution stayed in the registry",
          )
        }),
      )
    }),
  )

  it.live("incremental mode keeps stderr aside for diagnosis", () =>
    Effect.gen(function* () {
      const runtime = yield* GeoRuntime.Service
      const streamed: string[] = []
      const result = yield* runtime.run({
        ...script(`console.log("progress"); console.error("a warning")`),
        delivery: { mode: "incremental", onChunk: (chunk) => Effect.sync(() => void streamed.push(chunk)) },
        clocks: { idle: "10 seconds" },
      })

      expect(streamed.join("")).toContain("progress")
      expect(result.stderr).toContain("a warning")
    }),
  )

  it.live(
    "killAllSync takes down process trees without awaiting anything",
    () =>
      Effect.gen(function* () {
        const runtime = yield* GeoRuntime.Service
        const pids = yield* Ref.make<{ child?: number; grandchild?: number }>({})

        yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* runtime.start({
              ...script(
                `const { spawn } = require("child_process")
                 const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
                 console.log("GRANDCHILD:" + g.pid)
                 setInterval(() => {}, 1000)`,
              ),
              delivery: {
                mode: "incremental",
                onChunk: (chunk) =>
                  Ref.update(pids, (current) => {
                    const match = /GRANDCHILD:(\d+)/.exec(chunk)
                    return match ? { ...current, grandchild: Number(match[1]) } : current
                  }),
              },
              clocks: { total: "60 seconds" },
            })
            yield* Ref.update(pids, (current) => ({ ...current, child: handle.pid }))

            const found = yield* pollWithTimeout(
              Effect.gen(function* () {
                const current = yield* Ref.get(pids)
                return current.grandchild !== undefined ? current : undefined
              }),
              "the child never reported its grandchild",
            )

            // The host's shutdown path, where nothing asynchronous gets a chance to finish.
            yield* Effect.sync(() => runtime.killAllSync())

            yield* waitUntilGone(found.child!, "the child survived the shutdown sweep")
            yield* waitUntilGone(found.grandchild!, "the grandchild survived the shutdown sweep")
          }),
        )
      }),
    { timeout: 40000 },
  )

  it.live(
    "a dead process with held-open streams is called a crash, quickly",
    () =>
      Effect.gen(function* () {
        // The child dies while a grandchild it gave its stdio to keeps the streams open, so the close event never
        // fires: liveness read off the handle instead of off the pid would sit out the whole idle budget here.
        if (process.platform !== "darwin") return
        const runtime = yield* GeoRuntime.Service
        const pids = yield* Ref.make<number | undefined>(undefined)

        const result = yield* runtime.run({
          ...script(
            `const { spawn } = require("child_process")
             const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" })
             console.log("GRANDCHILD:" + g.pid)
             setTimeout(() => process.exit(0), 300)`,
          ),
          delivery: {
            mode: "incremental",
            onChunk: (chunk) =>
              Ref.update(pids, (current) => {
                const match = /GRANDCHILD:(\d+)/.exec(chunk)
                return match ? Number(match[1]) : current
              }),
          },
          clocks: { idle: "30 seconds" },
        })

        expect(result.reason).toBe("crash")
        // Well under the idle budget: the point is not waiting it out.
        expect(result.durationMs).toBeLessThan(15_000)
        // No drain flag asserted: the kill takes the stream-holding grandchild with it, as the wait below checks,
        // so the streams close and the drain completes.

        const grandchild = yield* Ref.get(pids)
        if (grandchild) yield* waitUntilGone(grandchild, "the stream-holding grandchild was left behind")
      }),
    { timeout: 40000 },
  )

  it.live("a signal that already fired stops the execution immediately", () =>
    Effect.gen(function* () {
      const runtime = yield* GeoRuntime.Service
      const controller = new AbortController()
      controller.abort()

      // The window between deciding to run something and running it is real, and a cancellation can land inside it.
      const result = yield* runtime.run({
        ...script(`setInterval(() => {}, 1000)`),
        delivery: { mode: "collect" },
        clocks: { total: "60 seconds" },
        abort: controller.signal,
      })

      expect(result.reason).toBe("abort")
    }),
  )

  it.live("a command that does not exist fails instead of hanging", () =>
    Effect.gen(function* () {
      const runtime = yield* GeoRuntime.Service
      const exit = yield* Effect.exit(
        runtime.run({
          command: "geocode-definitely-not-a-real-binary",
          args: [],
          delivery: { mode: "collect" },
          clocks: { total: "10 seconds" },
        }),
      )

      // A misconfigured toolchain path is the likeliest thing to be wrong on a user's machine.
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.live("a failing chunk handler does not corrupt the execution's result", () =>
    Effect.gen(function* () {
      const runtime = yield* GeoRuntime.Service
      const result = yield* runtime.run({
        ...ticker(3, 50),
        delivery: { mode: "incremental", onChunk: () => Effect.die(new Error("consumer blew up")) },
        clocks: { idle: "10 seconds" },
      })

      // What the process did and what our handling of it did are separate facts.
      expect(result.reason).toBe("exit")
      expect(result.code).toBe(0)
    }),
  )

  it.live("stdin is piped and closed", () =>
    Effect.gen(function* () {
      const runtime = yield* GeoRuntime.Service
      const result = yield* runtime.run({
        ...script(
          `let data = ""
           process.stdin.on("data", (c) => (data += c))
           process.stdin.on("end", () => console.log("got:" + data.trim()))`,
        ),
        delivery: { mode: "collect" },
        clocks: { total: "20 seconds" },
        input: "hello from the caller",
      })

      expect(result.stdout).toContain("got:hello from the caller")
    }),
  )
})
