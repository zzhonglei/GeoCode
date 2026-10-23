import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { until } from "../../support/common.ts"
import { python3, start } from "../../support/gee.ts"

const machineGee = async (machine: string) => JSON.parse(await fs.readFile(machine, "utf-8")).gee

// Guards against a configuration written wrong that the settings cannot fix.
test("the settings write the project, over a block written wrong", async () => {
  const engine = await start({ project: "majestic" })
  try {
    assert.equal((await engine.settled()).status, "config-error")
    const refused = await engine.response(engine.send({ project: "not a project" }, "gee.configure"))
    assert.equal(!refused.ok && refused.error.code, "invalid-params")
    assert.ok((await engine.response(engine.send({ project: "majestic" }, "gee.configure"))).ok)
    assert.equal(await machineGee(engine.machine), "majestic")
  } finally {
    await engine.stop()
  }
})

/** Starts a sign-in and comes back from the browser with `query`, as Google sends the user back. */
const signIn = async (engine: Awaited<ReturnType<typeof start>>, query: string) => {
  const id = engine.send({}, "gee.signIn")
  await until(() => engine.progress(id).length > 0, 10000, "the address to open")
  const { url } = engine.progress(id)[0] as { url: string }
  const back = new URL(url).searchParams.get("redirect_uri")
  assert.match(back ?? "", /^http:\/\/localhost:\d+$/)
  // Guards against a request that is not the sign-in coming back, as the browser's for the page's icon, ending it.
  assert.equal((await fetch(`${back}/favicon.ico`)).status, 404)
  assert.ok(!engine.sent.some((message) => message.type === "response" && message.id === id))
  await fetch(`${back}/?${query}`).then((answer) => answer.text())
  return { response: await engine.response(id), back: back ?? "" }
}

test("signing in through the browser checks again, and finds the user signed in", { skip: !python3 }, async () => {
  const engine = await start("majestic", ["signed-out"])
  try {
    assert.equal((await engine.settled()).status, "signed-out")
    const { response, back } = await signIn(engine, "code=granted")
    assert.ok(response.ok, JSON.stringify(response))
    // Guards against the code reaching earthengine-api without the address Google sent it to, which Google refuses.
    assert.equal(await fs.readFile(path.join(engine.directory, "stubs", "flags", "token"), "utf-8"), `granted ${back}`)
    await until(() => engine.states().at(-1)?.status === "ready", 10000, "the check after signing in")
  } finally {
    await engine.stop()
  }
})

// Guards against a denied sign-in hanging until its time is up, as earthengine-api then waits for a code typed in.
test("access denied in the browser ends the sign-in at once", { skip: !python3 }, async () => {
  const engine = await start(undefined, ["signed-out"])
  try {
    assert.equal((await engine.settled()).status, "signed-out")
    const { response } = await signIn(engine, "error=access_denied")
    assert.equal(!response.ok && response.error.code, "denied")
    assert.equal(engine.states().at(-1)?.status, "signed-out")
  } finally {
    await engine.stop()
  }
})
