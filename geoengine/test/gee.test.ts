import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Effect, Fiber, Layer } from "effect"
import { Config } from "../src/config.ts"
import { Engine } from "../src/engine.ts"
import { Gee } from "../src/gee/index.ts"
import { Python } from "../src/gee/python.ts"
import type { Protocol } from "../src/protocol.ts"
import { Runtime } from "../src/runtime.ts"
import { Status } from "../src/status.ts"
import type { Transport } from "../src/transport.ts"

const posix = process.platform !== "win32"

/** A Python 3 to run the real scripts with, or none, which skips the tests that need one. */
const python3 = (() => {
  if (!posix) return
  try {
    return execFileSync("/bin/sh", ["-c", "command -v python3"], { encoding: "utf-8" }).trim() || undefined
  } catch {
    return
  }
})()

/**
 * A file in the stubs' "flags" folder that makes them behave as the named environment does: "adc" has no credentials of
 * Earth Engine's own but Google Cloud's default ones; "no-geopandas" leaves the package out.
 */
type Flag = "signed-out" | "adc" | "revoked" | "offline-refresh" | "no-geopandas" | "broken-geedim"

/**
 * Stand in for earthengine-api and what the check imports with it, so the real scripts run without a network: a
 * request sends nothing and waits as long as it is given. A project named "refused", "absent" or "disabled" is refused
 * as Earth Engine refuses one the account may not use, one that does not exist and one without the API; "offline"
 * cannot be reached. The flags stand for the rest.
 */
const STUBS = {
  "flags.py": `import os

FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "flags")


def raised(name):
    return os.path.exists(os.path.join(FOLDER, name))
`,
  "requests/__init__.py": `import time

from requests import exceptions


class Session:
    def send(self, prepared, **options):
        time.sleep(prepared or 0)
        return "sent"
`,
  "requests/exceptions.py": `class ConnectionError(IOError):
    pass


class Timeout(IOError):
    pass
`,
  "google/__init__.py": "",
  "google/auth/__init__.py": `from google.auth import exceptions


def default():
    raise exceptions.DefaultCredentialsError("no application default credentials")
`,
  "google/auth/exceptions.py": `class TransportError(Exception):
    pass


class RefreshError(Exception):
    retryable = False
`,
  "google/auth/_cloud_sdk.py": `import os

import flags


def get_application_default_credentials_path():
    return os.path.join(flags.FOLDER, "application_default_credentials.json")
`,
  "google/auth/transport/__init__.py": "",
  "google/auth/transport/requests.py": `class Request:
    pass
`,
  "google/oauth2/__init__.py": "",
  "google/oauth2/credentials.py": `import flags
from google.auth import exceptions


class Credentials:
    def __init__(self, token, **arguments):
        pass

    def refresh(self, request):
        if flags.raised("revoked"):
            raise exceptions.RefreshError("invalid_grant: Token has been expired or revoked.", {"error": "invalid_grant"})
        if flags.raised("offline-refresh"):
            raise exceptions.TransportError("HTTPSConnectionPool(host='oauth2.googleapis.com', port=443): Max retries exceeded")
`,
  "googleapiclient/__init__.py": "",
  "googleapiclient/errors.py": `class HttpError(Exception):
    def __init__(self, status, reasons, message):
        Exception.__init__(self, message)
        self.resp = type("Response", (), {"status": status})()
        self.error_details = [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": reason} for reason in reasons]
`,
  "geedim/__init__.py": `import flags

if flags.raised("broken-geedim"):
    raise ImportError("dlopen(libgdal.37.dylib): image not found", name="rasterio._base")
__version__ = "2.0.0"
`,
  "geopandas/__init__.py": `__version__ = "1.1.3"
`,
  "ee/ee_exception.py": `class EEException(Exception):
    pass
`,
  "ee/oauth.py": `import flags


def get_credentials_arguments():
    if flags.raised("signed-out") or flags.raised("adc"):
        raise IOError("no credentials file")
    return {"refresh_token": "token"}
`,
  "ee/data.py": `def get_persistent_credentials():
    return "credentials"
`,
  "ee/__init__.py": `import os

import requests
from googleapiclient import errors

from ee import data, oauth
from ee.ee_exception import EEException

__version__ = "1.7.19"


def refuse(status, reasons, message):
    try:
        raise errors.HttpError(status, reasons, message)
    except errors.HttpError:
        raise EEException(message)


def Initialize(credentials=None, project=None):
    print("*** Earth Engine *** Share your feedback")
    # The file stands for a project refused after the check passed; the check does not run in the session's folder.
    if project == "refused" or os.path.exists("refuse"):
        refuse(403, ["USER_PROJECT_DENIED"], "Caller does not have required permission to use project %s" % project)
    if project == "absent":
        refuse(400, ["USER_PROJECT_DENIED"], "Project 'projects/absent' not found or deleted.")
    if project == "disabled":
        refuse(403, ["SERVICE_DISABLED"], "Google Earth Engine API has not been used in project disabled before")
    if project == "offline":
        raise requests.exceptions.ConnectionError("Failed to establish a new connection")
    if project == "overloaded":
        refuse(503, [], "The service is currently unavailable.")
    if project == "scoped":
        refuse(403, ["ACCESS_TOKEN_SCOPE_INSUFFICIENT"], "Request had insufficient authentication scopes.")


def wait(seconds):
    return requests.Session().send(seconds)


class Number:
    def __init__(self, value):
        self.value = value

    def getInfo(self):
        wait(0)
        return self.value
`,
}

/** A shell script standing in for the configured Python; `body` reads the program from stdin as Python would. */
const fakePython = async (directory: string, body: string, name = "python") => {
  const file = path.join(directory, name)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`)
  await fs.chmod(file, 0o755)
  return file
}

/** The real Python 3 with the stubs first on its path, behaving as the flags say. */
const stubbedPython = async (directory: string, raised: readonly Flag[] = []) => {
  const stubs = path.join(directory, "stubs")
  for (const [name, text] of Object.entries(STUBS)) {
    if (raised.includes("no-geopandas") && name.startsWith("geopandas/")) continue
    await fs.mkdir(path.dirname(path.join(stubs, name)), { recursive: true })
    await fs.writeFile(path.join(stubs, name), text)
  }
  await fs.mkdir(path.join(stubs, "flags"), { recursive: true })
  for (const flag of raised) await fs.writeFile(path.join(stubs, "flags", flag), "")
  if (raised.includes("adc"))
    await fs.writeFile(path.join(stubs, "flags", "application_default_credentials.json"), "{}")
  return fakePython(directory, `PYTHONPATH='${stubs}' exec '${python3}' "$@"`)
}

/** Raises a flag of the stubbed Python made in `directory` while it is in use. */
const raise = (directory: string, flag: Flag) => fs.writeFile(path.join(directory, "stubs", "flags", flag), "")

const mark = (payload: unknown) => `cat >/dev/null; echo '${Python.MARKER}${JSON.stringify(payload)}'`

type Response = Extract<Protocol.Outbound, { type: "response" }>
type Progress = Extract<Protocol.Outbound, { type: "progress" }>

const until = async (predicate: () => boolean | Promise<boolean>, ms: number, what: string) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 20) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const start = async (block?: (directory: string) => Promise<unknown>) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-gee-"))
  const machine = path.join(directory, "machine.json")
  if (block) await fs.writeFile(machine, JSON.stringify({ gee: await block(directory) }))
  const sent: Protocol.Outbound[] = []
  let deliver: (message: unknown) => void = () => {}
  const transport: Transport = {
    send: (message) => void sent.push(structuredClone(message)),
    listen: (handler) => {
      deliver = handler
      return () => {}
    },
  }
  const layer = Layer.mergeAll(Runtime.layer(Engine.ledger(transport)), Status.layer, Config.layer(machine))
  const fiber = Effect.runFork(Effect.scoped(Engine.run(transport, [Gee.capability])).pipe(Effect.provide(layer)))
  const states = () =>
    sent.flatMap((message) =>
      message.type === "status" && message.domain === "gee" ? [message.value as Gee.State] : [],
    )
  const settled = async (ms = 10000) => {
    await until(() => (states().at(-1)?.status ?? "checking") !== "checking", ms, "GEE to settle")
    return states().at(-1)!
  }
  let nextId = 0
  const send = (params: unknown, method = "gee.run") => {
    nextId += 1
    deliver({ type: "request", id: nextId, method, params })
    return nextId
  }
  const response = async (id: number, ms = 20000) => {
    const find = () => sent.find((message): message is Response => message.type === "response" && message.id === id)
    await until(() => find() !== undefined, ms, `the response to ${id}`)
    return find()!
  }
  const progress = (id: number) =>
    sent.flatMap((message) => (message.type === "progress" && message.id === id ? [(message as Progress).data] : []))
  const stop = async () => {
    await Effect.runPromise(Fiber.interrupt(fiber))
    await fs.rm(directory, { recursive: true, force: true })
  }
  try {
    await until(() => sent.some((message) => message.type === "ready"), 10000, "the engine")
  } catch (error) {
    await stop()
    throw error
  }
  return { directory, machine, states, settled, send, response, progress, deliver: (m: unknown) => deliver(m), stop }
}

const result = (response: Response) => {
  assert.ok(response.ok, JSON.stringify(response))
  return response.result as { outcome: string; output: string; truncated: boolean; durationMs: number; exit?: string }
}

test("no configuration settles on unconfigured, and a run is refused with what to do", async () => {
  const engine = await start()
  try {
    assert.equal((await engine.settled()).status, "unconfigured")
    const response = await engine.response(engine.send({ script: "print(1)", cwd: engine.directory }))
    assert.equal(!response.ok && response.error.code, "not-ready")
    assert.match(!response.ok ? response.error.message : "", /"gee" block of .*machine\.json/)
    assert.match(!response.ok ? response.error.message : "", /never guess it/)
  } finally {
    await engine.stop()
  }
})

/** A check's report of a Python with every package, whose user is signed in. */
const SIGNED_IN = { python: "3.12.1", versions: { "earthengine-api": "1.7.19", geedim: "2.0.0", geopandas: "1.1.3" } }

test("a Python that cannot start or ends without a report settles on its own state", { skip: !posix }, async () => {
  const cases: [(directory: string) => Promise<unknown>, string][] = [
    [async (directory) => ({ python: path.join(directory, "missing", "python"), project: "p" }), "python-missing"],
    // Guards against a Python that ends without a report reading as anything but a failed check, losing its output.
    [
      async (directory) => ({
        python: await fakePython(directory, "echo 'Segmentation fault' >&2; exit 139"),
        project: "p",
      }),
      "check-failed",
    ],
    [async (directory) => ({ python: await fakePython(directory, mark(SIGNED_IN)), project: "p" }), "ready"],
  ]
  for (const [block, expected] of cases) {
    const engine = await start(block)
    try {
      const state = await engine.settled()
      assert.equal(state.status, expected, JSON.stringify(state))
    } finally {
      await engine.stop()
    }
  }
})

// Guards against GeoAgent being told only that the check ended without a report, not what the Python said.
test("a Python that ends without a report is described by what it printed", { skip: !posix }, async () => {
  const engine = await start(async (directory) => ({
    python: await fakePython(directory, "cat >/dev/null; echo 'Python was not found' >&2; exit 9"),
  }))
  try {
    const state = await engine.settled()
    assert.equal(state.status, "check-failed")
    const response = await engine.response(engine.send({ script: "print(1)", cwd: engine.directory }))
    const message = !response.ok ? response.error.message : ""
    assert.match(message, /exited with code 9 without a report\nPython was not found\n/)
    // Guards against naming a project that is not configured.
    assert.doesNotMatch(message, /undefined/)
  } finally {
    await engine.stop()
  }
})

// Guards against a call waiting out the settle limit for a check nothing starts, when the file has not changed.
test("a run without a project is refused at once with what to do", { skip: !posix }, async () => {
  const engine = await start(async (directory) => ({ python: await fakePython(directory, mark(SIGNED_IN)) }))
  try {
    assert.equal((await engine.settled()).status, "project-missing")
    const started = Date.now()
    const response = await engine.response(engine.send({ script: "print(1)", cwd: engine.directory }))
    assert.ok(Date.now() - started < 5000, `answered after ${Date.now() - started} ms`)
    assert.equal(!response.ok && response.error.code, "not-ready")
    assert.match(!response.ok ? response.error.message : "", /no Google Cloud project is configured/)
  } finally {
    await engine.stop()
  }
})

/** The lines several of GeoAgent's hints share. */
const CONFIGURED = (file: string) =>
  `The configuration is the "gee" block of ${file}: {"python": "<absolute path of the Python>", "project": "<Google Cloud project ID>"}. It is checked as soon as the file is saved; then call geerun again.`
const AGAIN = "It is checked again the next time geerun is called."
const SIGN_IN = (command: string) =>
  `The user must sign in with their Google account. Ask them to get it ready; once they say so, run \`${command}\` with a timeout of 10 minutes. It opens their browser and ends when they finish there.`
const REVOKED = (python: string) =>
  [
    "Google refused the Earth Engine credentials on this computer: they have expired, been revoked, or do not cover Earth Engine.",
    "Google said: invalid_grant: Token has been expired or revoked.",
    SIGN_IN(`"${python}" -m ee.cli.eecli authenticate --auth_mode=localhost --force`),
    AGAIN,
  ].join("\n")

test(
  "each finding of the check settles on its own state, and tells GeoAgent what to do",
  { skip: !python3 },
  async () => {
    const cases: {
      readonly flags?: readonly Flag[]
      readonly project?: string
      /** Lays out more of the Python's folder. */
      readonly folder?: (directory: string) => Promise<void>
      readonly status: string
      readonly diagnostics?: Record<string, unknown>
      readonly hint?: (python: string, file: string) => string
    }[] = [
      {
        flags: ["no-geopandas"],
        status: "packages-missing",
        diagnostics: { missing: ["geopandas"] },
        hint: (python, file) =>
          [
            `The configured Python, ${python}, lacks geopandas. GeoCode needs earthengine-api, geedim, geopandas in that Python.`,
            `With the user's consent, install them: \`"${python}" -m pip install geopandas\`.`,
            CONFIGURED(file),
          ].join("\n"),
      },
      // Guards against installing into a conda environment with pip, or with a conda the shell cannot find.
      {
        flags: ["no-geopandas"],
        folder: async (directory) => {
          await fs.mkdir(path.join(directory, "conda-meta"))
          await fakePython(directory, "exit 0", path.join("bin", "conda"))
        },
        status: "packages-missing",
        hint: (python, file) =>
          [
            `The configured Python, ${python}, lacks geopandas. GeoCode needs earthengine-api, geedim, geopandas in that Python.`,
            `With the user's consent, install them: \`"${path.dirname(python)}/bin/conda" install --prefix "${path.dirname(python)}" -c conda-forge -y geopandas\`.`,
            CONFIGURED(file),
          ].join("\n"),
      },
      // Guards against a package that is there but cannot load reading as one to install: installing it again rarely helps.
      {
        flags: ["no-geopandas", "broken-geedim"],
        status: "packages-broken",
        diagnostics: {
          missing: ["geopandas"],
          broken: [{ package: "geedim", error: "ImportError: dlopen(libgdal.37.dylib): image not found" }],
        },
        hint: (python, file) =>
          [
            `In the configured Python, ${python}, these packages are installed but fail to import:`,
            "- geedim: ImportError: dlopen(libgdal.37.dylib): image not found",
            "Installing them again rarely helps. Show the user the errors; with their consent, repair the environment or set up another one.",
            `The configured Python, ${python}, lacks geopandas. GeoCode needs earthengine-api, geedim, geopandas in that Python.`,
            `With the user's consent, install them: \`"${python}" -m pip install geopandas\`.`,
            CONFIGURED(file),
          ].join("\n"),
      },
      // Without an earthengine command beside the Python, through its own module.
      {
        flags: ["signed-out"],
        status: "signed-out",
        hint: (python) =>
          [
            "Google Earth Engine is not signed in: there are no Earth Engine credentials on this computer.",
            SIGN_IN(`"${python}" -m ee.cli.eecli authenticate --auth_mode=localhost`),
            AGAIN,
          ].join("\n"),
      },
      {
        flags: ["signed-out"],
        folder: (directory) => fakePython(directory, "exit 0", "earthengine").then(() => {}),
        status: "signed-out",
        hint: (python) =>
          [
            "Google Earth Engine is not signed in: there are no Earth Engine credentials on this computer.",
            SIGN_IN(`"${path.dirname(python)}/earthengine" authenticate --auth_mode=localhost`),
            AGAIN,
          ].join("\n"),
      },
      // Signed in, the project is asked for only then: a missing project never hides a missing sign-in.
      {
        status: "project-missing",
        hint: (_python, file) =>
          [
            "Google Earth Engine is signed in, but no Google Cloud project is configured.",
            "Ask the user for the ID of their Google Cloud project registered for Earth Engine, which the Code Editor (https://code.earthengine.google.com) shows at its top; never guess it.",
            CONFIGURED(file),
          ].join("\n"),
      },
      // Guards against a refused refresh reading as no credentials at all, as earthengine-api words it.
      { flags: ["revoked"], project: "majestic", status: "rejected", hint: REVOKED },
      {
        project: "scoped",
        status: "rejected",
        diagnostics: { refusal: "credentials-invalid" },
        hint: (python) =>
          [
            "Google refused the Earth Engine credentials on this computer: they have expired, been revoked, or do not cover Earth Engine.",
            "Google said: Request had insufficient authentication scopes.",
            SIGN_IN(`"${python}" -m ee.cli.eecli authenticate --auth_mode=localhost --force`),
            AGAIN,
          ].join("\n"),
      },
      {
        project: "absent",
        status: "rejected",
        diagnostics: { refusal: "project-not-found" },
        hint: (_python, file) =>
          [
            "There is no Google Cloud project with the configured ID, absent.",
            "Google said: Project 'projects/absent' not found or deleted.",
            "Ask the user for the right ID, which the Code Editor (https://code.earthengine.google.com) shows at its top; never guess it.",
            CONFIGURED(file),
            AGAIN,
          ].join("\n"),
      },
      {
        project: "refused",
        status: "rejected",
        diagnostics: { refusal: "no-permission" },
        hint: (_python, file) =>
          [
            "The signed-in Google account may not use the configured project, refused.",
            "Google said: Caller does not have required permission to use project refused",
            "Ask the user whether the ID is right and whether the project belongs to the account they signed in with; they may need to sign in with another account, or use a project of their own.",
            CONFIGURED(file),
            AGAIN,
          ].join("\n"),
      },
      {
        project: "disabled",
        status: "rejected",
        diagnostics: { refusal: "api-disabled" },
        hint: (_python, file) =>
          [
            "The Earth Engine API is not enabled in the configured project, disabled.",
            "Google said: Google Earth Engine API has not been used in project disabled before",
            "Ask the user to enable it at https://console.cloud.google.com/apis/library/earthengine.googleapis.com?project=disabled; it takes a few minutes to apply.",
            CONFIGURED(file),
            AGAIN,
          ].join("\n"),
      },
      {
        project: "offline",
        status: "unreachable",
        hint: () =>
          [
            "Google Earth Engine cannot be reached: ConnectionError: Failed to establish a new connection",
            "The local setup is in place; the network, or Google, is at fault. Tell the user, and do not reinstall, reconfigure or sign in again.",
            AGAIN,
          ].join("\n"),
      },
      // Guards against the network failing at the sign-in's refresh reading as refused credentials.
      { flags: ["offline-refresh"], project: "majestic", status: "unreachable" },
      // Guards against Earth Engine failing on its side reading as a refusal of the project.
      {
        project: "overloaded",
        status: "unreachable",
        hint: () =>
          [
            "Google Earth Engine cannot be reached: EEException: The service is currently unavailable.",
            "Google said: The service is currently unavailable.",
            "The local setup is in place; the network, or Google, is at fault. Tell the user, and do not reinstall, reconfigure or sign in again.",
            AGAIN,
          ].join("\n"),
      },
      // Google Cloud's default credentials sign in as well as Earth Engine's own.
      { flags: ["adc"], project: "majestic", status: "ready" },
      { project: "majestic", status: "ready" },
    ]
    for (const item of cases) {
      let python = ""
      const engine = await start(async (directory) => {
        python = await stubbedPython(directory, item.flags)
        await item.folder?.(directory)
        return { python, ...(item.project === undefined ? {} : { project: item.project }) }
      })
      try {
        const state = await engine.settled()
        assert.equal(state.status, item.status, JSON.stringify(state))
        if (state.status === "ready") {
          assert.deepEqual(state.versions, {
            python: state.versions.python,
            "earthengine-api": "1.7.19",
            geedim: "2.0.0",
            geopandas: "1.1.3",
            requests: "",
          })
          continue
        }
        if (item.diagnostics && "diagnostics" in state) {
          for (const [key, value] of Object.entries(item.diagnostics)) {
            assert.deepEqual(state.diagnostics[key as keyof Gee.Diagnostics], value, key)
          }
        }
        // Through the check the kernel makes before asking, which answers as a run would.
        const response = await engine.response(engine.send({ cwd: engine.directory }, "gee.check"))
        assert.equal(!response.ok && response.error.code, "not-ready")
        if (item.hint) assert.equal(!response.ok ? response.error.message : "", item.hint(python, engine.machine))
      } finally {
        await engine.stop()
      }
    }
  },
)

test(
  "the check before asking answers for a ready environment, and refuses a missing file",
  { skip: !python3 },
  async () => {
    const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
    try {
      assert.equal((await engine.settled()).status, "ready")
      const ready = await engine.response(engine.send({ cwd: engine.directory }, "gee.check"))
      assert.deepEqual(ready.ok && ready.result, {})
      const file = path.join(engine.directory, "none.py")
      const missing = await engine.response(engine.send({ cwd: engine.directory, file }, "gee.check"))
      assert.equal(!missing.ok && missing.error.code, "invalid-params")
      assert.equal(!missing.ok && missing.error.message, `${file} is not a file`)
    } finally {
      await engine.stop()
    }
  },
)

// Guards against a Python removed since the check failing every run with no word of why.
test("a run whose Python is gone checks again, and answers with what is now wrong", { skip: !python3 }, async () => {
  let python = ""
  const engine = await start(async (directory) => {
    python = await stubbedPython(directory)
    return { python, project: "majestic" }
  })
  try {
    assert.equal((await engine.settled()).status, "ready")
    await fs.rm(python)
    const response = await engine.response(engine.send({ script: "print(1)", cwd: engine.directory }))
    assert.equal(!response.ok && response.error.code, "not-ready")
    assert.match(!response.ok ? response.error.message : "", /^The configured Python, .*, cannot be started/)
    assert.equal(engine.states().at(-1)?.status, "python-missing")
  } finally {
    await engine.stop()
  }
})

// Guards against a run failing on credentials revoked since the check, and the indicator still showing it ready.
test(
  "a run whose initialization fails checks again, and answers with what is now wrong",
  { skip: !python3 },
  async () => {
    const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
    try {
      assert.equal((await engine.settled()).status, "ready")
      await raise(engine.directory, "revoked")
      // The run's own initialization is refused, as Earth Engine refuses revoked credentials.
      await fs.writeFile(path.join(engine.directory, "refuse"), "")
      const response = await engine.response(engine.send({ script: "print(1)", cwd: engine.directory }))
      assert.equal(!response.ok && response.error.code, "not-ready")
      assert.equal(!response.ok && response.error.message, REVOKED(path.join(engine.directory, "python")))
      assert.equal(engine.states().at(-1)?.status, "rejected")
    } finally {
      await engine.stop()
    }
  },
)

test("a project written after the Python is configured is seen by the next run", { skip: !python3 }, async () => {
  const engine = await start(async (directory) => ({ python: await stubbedPython(directory) }))
  try {
    const state = await engine.settled()
    assert.equal(state.status, "project-missing")
    const python = (JSON.parse(await fs.readFile(engine.machine, "utf-8")) as { gee: { python: string } }).gee.python
    await fs.writeFile(engine.machine, JSON.stringify({ gee: { python, project: "majestic" } }))
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

test(
  "a run hands GeoAgent what the script printed, and nothing printed before it began",
  { skip: !python3 },
  async () => {
    const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
    try {
      assert.equal((await engine.settled()).status, "ready")
      const script =
        'import os\nprint("中文", os.getcwd())\nprint(ee.Number(1).getInfo())\nimport sys\nprint("warned", file=sys.stderr)'
      const id = engine.send({ script, cwd: engine.directory })
      const done = result(await engine.response(id))
      assert.equal(done.outcome, "finished")
      const cwd = await fs.realpath(engine.directory)
      assert.equal(done.output, `中文 ${cwd}\n1\nwarned\n`)
      assert.doesNotMatch(done.output, /Earth Engine|__GEOCODE_GEE__/)
      assert.deepEqual(engine.progress(id), [{ begun: true }])
    } finally {
      await engine.stop()
    }
  },
)

test("a failing script ends with its traceback, from its own lines", { skip: !python3 }, async () => {
  const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
  try {
    assert.equal((await engine.settled()).status, "ready")
    const done = result(
      await engine.response(engine.send({ script: 'print("before")\nvalue = 1 / 0\n', cwd: engine.directory })),
    )
    assert.equal(done.outcome, "failed")
    assert.match(
      done.output,
      /^before\nTraceback \(most recent call last\):\n {2}File "<script>", line 2, in <module>\n {4}value = 1 \/ 0\n/,
    )
    assert.match(done.output, /ZeroDivisionError/)
    assert.doesNotMatch(done.output, /<stdin>/)

    const exited = result(
      await engine.response(engine.send({ script: "import sys\nsys.exit(3)", cwd: engine.directory })),
    )
    assert.equal(exited.outcome, "failed")
    const syntax = result(await engine.response(engine.send({ script: "print(", cwd: engine.directory })))
    assert.equal(syntax.outcome, "failed")
    assert.match(syntax.output, /SyntaxError/)
  } finally {
    await engine.stop()
  }
})

test("a script file runs from its own folder's imports, and a missing one is refused", { skip: !python3 }, async () => {
  const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
  try {
    assert.equal((await engine.settled()).status, "ready")
    const folder = path.join(engine.directory, "脚本")
    await fs.mkdir(folder)
    await fs.writeFile(path.join(folder, "helper.py"), "VALUE = 42\n")
    await fs.writeFile(
      path.join(folder, "main.py"),
      "import sys\nfrom helper import VALUE\nprint(VALUE, sys.argv[0] == __file__)\n",
    )
    const done = result(
      await engine.response(engine.send({ file: path.join(folder, "main.py"), cwd: engine.directory })),
    )
    assert.equal(done.outcome, "finished")
    assert.equal(done.output, "42 True\n")

    const missing = await engine.response(engine.send({ file: path.join(folder, "none.py"), cwd: engine.directory }))
    assert.equal(!missing.ok && missing.error.code, "invalid-params")
    const neither = await engine.response(engine.send({ cwd: engine.directory }))
    assert.equal(!neither.ok && neither.error.code, "invalid-params")
  } finally {
    await engine.stop()
  }
})

test(
  "a file in the session's folder named like a module the run needs does not replace it, and the script runs as __main__",
  { skip: !python3 },
  async () => {
    const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
    try {
      assert.equal((await engine.settled()).status, "ready")
      for (const name of ["json.py", "requests.py", "ee.py"]) {
        await fs.writeFile(path.join(engine.directory, name), 'raise RuntimeError("shadowed")\n')
      }
      await fs.writeFile(path.join(engine.directory, "helper.py"), "VALUE = 42\n")
      // A script imports from the session's folder, as Python lets code it is given; what it defines can be pickled.
      const script =
        "import pickle\nfrom helper import VALUE\nclass Area:\n    pass\nprint(VALUE, type(pickle.loads(pickle.dumps(Area()))).__name__)"
      const done = result(await engine.response(engine.send({ script, cwd: engine.directory })))
      assert.equal(done.outcome, "finished", done.output)
      assert.equal(done.output, "42 Area\n")
    } finally {
      await engine.stop()
    }
  },
)

test(
  "a request waiting for Earth Engine is reported, without breaking a line the script left open",
  { skip: !python3 },
  async () => {
    const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
    try {
      assert.equal((await engine.settled()).status, "ready")
      // Guards against a line left open on stdout, as a progress message is, silencing the reports: the run would be
      // stopped as idle while Earth Engine computes.
      const seconds = Python.BEAT_SECONDS * 2 + 1
      const script = `print("computing...", end="", flush=True)\nee.wait(${seconds})\nprint(" done")`
      const id = engine.send({ script, cwd: engine.directory })
      const done = result(await engine.response(id, (seconds + 15) * 1000))
      assert.equal(done.outcome, "finished")
      assert.equal(done.output, "computing... done\n")
      const waits = engine.progress(id).filter((data) => typeof data === "object" && data !== null && "waiting" in data)
      assert.ok(waits.length >= 1, JSON.stringify(engine.progress(id)))
    } finally {
      await engine.stop()
    }
  },
)

test("an initialization Earth Engine refuses fails the run with its error", { skip: !python3 }, async () => {
  const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
  try {
    assert.equal((await engine.settled()).status, "ready")
    await fs.writeFile(path.join(engine.directory, "refuse"), "")
    const response = await engine.response(engine.send({ script: "print(1)", cwd: engine.directory }))
    assert.equal(!response.ok && response.error.code, "initialize-failed")
    assert.match(!response.ok ? response.error.message : "", /required permission to use project majestic/)
  } finally {
    await engine.stop()
  }
})

test("a cancelled run answers at once and ends its process", { skip: !python3 }, async () => {
  const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
  try {
    assert.equal((await engine.settled()).status, "ready")
    const marker = path.join(engine.directory, "pid")
    const id = engine.send({
      script: `import os\nopen(${JSON.stringify(marker)}, "w").write(str(os.getpid()))\nee.wait(60)`,
      cwd: engine.directory,
    })
    await until(
      () =>
        fs.stat(marker).then(
          () => true,
          () => false,
        ),
      10000,
      "the script to start",
    )
    const pid = Number(await fs.readFile(marker, "utf-8"))
    engine.deliver({ type: "cancel", id })
    const response = await engine.response(id, 10000)
    assert.equal(!response.ok && response.error.code, "cancelled")
    assert.equal(response.cancelled, true)
    await until(
      () => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      },
      10000,
      "the process to end",
    )
  } finally {
    await engine.stop()
  }
})
