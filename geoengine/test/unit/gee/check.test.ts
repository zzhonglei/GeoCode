import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { Gee } from "../../../src/gee/index.ts"
import { python3 } from "../../support/common.ts"
import { type Flag, raise, start, result } from "../../support/gee.ts"

test(
  "each finding of the check settles on its own state, and nothing runs until it is ready",
  { skip: !python3 },
  async () => {
    const cases: {
      readonly flags?: readonly Flag[]
      /** The "gee" entry of machine.json. */
      readonly project?: unknown
      readonly status: string
      readonly diagnostics?: Record<string, unknown>
    }[] = [
      { project: { project: "majestic" }, status: "config-error" },
      { flags: ["signed-out"], status: "signed-out" },
      // Guards against signing in as another account, or without Earth Engine's scope, through Google Cloud's default
      // credentials, which earthengine-api would fall back to.
      { flags: ["adc"], project: "majestic", status: "signed-out" },
      // Signed in, the project is asked for only then: a missing project never hides a missing sign-in.
      { status: "project-missing" },
      // Guards against a refused refresh reading as no credentials at all, as earthengine-api words it.
      { flags: ["revoked"], project: "majestic", status: "rejected", diagnostics: { refusal: "credentials-invalid" } },
      { project: "scoped", status: "rejected", diagnostics: { refusal: "credentials-invalid" } },
      { project: "absent", status: "rejected", diagnostics: { refusal: "project-not-found" } },
      { project: "refused", status: "rejected", diagnostics: { refusal: "no-permission" } },
      { project: "disabled", status: "rejected", diagnostics: { refusal: "api-disabled" } },
      // Without a status, GeoAgent is told there is no network.
      { project: "offline", status: "unreachable", diagnostics: { status: undefined } },
      // Guards against the network failing at the sign-in's refresh reading as refused credentials.
      { flags: ["offline-refresh"], project: "majestic", status: "unreachable", diagnostics: { status: undefined } },
      // Guards against Earth Engine failing on its side reading as a refusal of the project, or as no network.
      { project: "overloaded", status: "unreachable", diagnostics: { status: 503 } },
      { project: "majestic", status: "ready" },
    ]
    for (const item of cases) {
      const engine = await start(item.project, item.flags)
      try {
        const state = await engine.settled()
        assert.equal(state.status, item.status, JSON.stringify(state))
        if (state.status === "ready") continue
        if (item.diagnostics && "diagnostics" in state) {
          for (const [key, value] of Object.entries(item.diagnostics)) {
            assert.deepEqual(state.diagnostics[key as keyof Gee.Diagnostics], value, key)
          }
        }
        // Through the check the kernel makes before asking, which answers as a run would.
        const response = await engine.response(engine.send({ cwd: engine.directory }, "gee.check"))
        assert.equal(!response.ok && response.error.code, "not-ready")
      } finally {
        await engine.stop()
      }
    }
  },
)

// Guards against checking, or signing in, in a base environment still being installed or warmed up, where a check would
// time out on libraries loaded for the first time.
test("Earth Engine is checked only once GeoCode's Python environment is ready", { skip: !python3 }, async () => {
  let open: () => void = () => {}
  const engine = await start("majestic", [], new Promise<void>((resolve) => (open = resolve)))
  try {
    const early = await engine.response(engine.send({}, "gee.signIn"))
    assert.equal(!early.ok && early.error.code, "not-ready")
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.deepEqual(engine.states(), [{ status: "checking" }])
    open()
    assert.equal((await engine.settled()).status, "ready")
  } finally {
    await engine.stop()
  }
})

// Guards against an interpreter removed since the check failing every run with no word of why.
test("a run whose Python is gone checks again, and answers with what is now wrong", { skip: !python3 }, async () => {
  const engine = await start("majestic")
  try {
    assert.equal((await engine.settled()).status, "ready")
    await fs.rm(engine.python)
    const response = await engine.response(engine.send({ script: "print(1)", cwd: engine.directory }))
    assert.equal(!response.ok && response.error.code, "not-ready")
    assert.equal(engine.states().at(-1)?.status, "check-failed")
  } finally {
    await engine.stop()
  }
})

// Guards against a run failing on credentials revoked since the check, and the indicator still showing it ready.
test(
  "a run whose initialization fails checks again, and answers with what is now wrong",
  { skip: !python3 },
  async () => {
    const engine = await start("majestic")
    try {
      assert.equal((await engine.settled()).status, "ready")
      await raise(engine.directory, "revoked")
      // The run's own initialization is refused, as Earth Engine refuses revoked credentials.
      await fs.writeFile(path.join(engine.directory, "refuse"), "")
      const response = await engine.response(engine.send({ script: "print(1)", cwd: engine.directory }))
      assert.equal(!response.ok && response.error.code, "not-ready")
      assert.equal(engine.states().at(-1)?.status, "rejected")
    } finally {
      await engine.stop()
    }
  },
)

test("a project written once signed in is seen by the next run", { skip: !python3 }, async () => {
  const engine = await start()
  try {
    const state = await engine.settled()
    assert.equal(state.status, "project-missing")
    await fs.writeFile(engine.machine, JSON.stringify({ gee: "majestic" }))
    // At once, within the watch's debounce: the run reads the file again itself.
    const done = result(
      await engine.response(engine.send({ script: "print(ee.Number(7).getInfo())", cwd: engine.directory })),
    )
    assert.equal(done.outcome, "finished")
    assert.equal(done.output, "7\n")
  } finally {
    await engine.stop()
  }
})
