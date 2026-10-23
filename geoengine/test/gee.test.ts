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
 * Earth Engine's own but Google Cloud's default ones; the "export-" flags say how an export goes (see the stub's
 * `export`).
 */
type Flag =
  | "signed-out"
  | "adc"
  | "revoked"
  | "offline-refresh"
  | "export-refused"
  | "export-fails"
  | "export-running"
  | "export-slow"

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
  "google/auth/__init__.py": `import flags
from google.auth import exceptions


def default():
    if flags.raised("adc"):
        return "application default credentials", "adc-project"
    raise exceptions.DefaultCredentialsError("no application default credentials")
`,
  "google/auth/exceptions.py": `class TransportError(Exception):
    pass


class DefaultCredentialsError(Exception):
    pass


class RefreshError(Exception):
    retryable = False
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
        self.refresh_token = arguments.get("refresh_token")

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
  "ee/ee_exception.py": `class EEException(Exception):
    pass
`,
  "ee/oauth.py": `import http.server
import os
import urllib.parse

import flags


def get_credentials_arguments():
    if flags.raised("signed-out") or flags.raised("adc"):
        raise IOError("no credentials file")
    return {"refresh_token": "token"}


def _obtain_and_write_token(code, verifier, scopes, redirect_uri):
    """Records what the credentials would be fetched with, in place of the network, and signs the user in."""
    with open(os.path.join(flags.FOLDER, "token"), "w") as record:
        record.write("%s %s" % (code, redirect_uri))
    os.remove(os.path.join(flags.FOLDER, "signed-out"))


class Flow:
    """earthengine-api's localhost sign-in, shaped as its own is where GeoCode relies on it."""

    def __init__(self, auth_mode="notebook", scopes=None):
        port = int(auth_mode.split(":", 1)[1])

        class Handler(http.server.BaseHTTPRequestHandler):
            code = None

            def do_GET(self):
                Handler.code = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)["code"][0]
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"signed in")

            def log_message(self, *_):
                pass

        class Server:
            def __init__(self):
                self.server = http.server.HTTPServer(("localhost", port), Handler)
                self.url = "http://localhost:%s" % self.server.server_address[1]

            def fetch_code(self):
                self.server.handle_request()
                self.server.server_close()
                return Handler.code

        self.server = Server()
        self.auth_url = "https://accounts.google.com/o/oauth2/auth?redirect_uri=" + self.server.url

    def save_code(self, code=None):
        redirect_uri = None
        if self.server and not code:
            redirect_uri = self.server.url
            code = self.server.fetch_code()
        _obtain_and_write_token(code, "verifier", None, redirect_uri)
`,
  "ee/data.py": `import json
import os

import flags
from ee.ee_exception import EEException


def get_persistent_credentials():
    """As earthengine-api's: its own credentials, else Google Cloud's default ones."""
    from ee import oauth

    try:
        oauth.get_credentials_arguments()
    except IOError:
        import google.auth

        return google.auth.default()[0]
    return "credentials"


def _store():
    """The user's assets and exports, as the test writes them to assets.json."""
    path = os.path.join(flags.FOLDER, "assets.json")
    if not os.path.exists(path):
        return {"assets": [], "operations": []}
    with open(path, encoding="utf-8") as source:
        return json.load(source)


def listAssets(params):
    return {"assets": [asset for asset in _store()["assets"] if asset["name"].rsplit("/", 1)[0] == params["parent"]]}


def getAsset(name):
    for asset in _store()["assets"]:
        if asset["name"] == name:
            return asset
    raise EEException("Asset '%s' not found." % name)


def listOperations():
    return _store()["operations"]


def _write(store):
    with open(os.path.join(flags.FOLDER, "assets.json"), "w", encoding="utf-8") as target:
        json.dump(store, target, ensure_ascii=False)


def _saved(store, operation):
    store["assets"] = [asset for asset in store["assets"] if asset["name"] != operation["path"]]
    asset = {"type": operation["kind"], "name": operation["path"], "updateTime": operation["metadata"]["createTime"]}
    store["assets"].append(dict(asset, properties=operation["properties"]))


def createAsset(value, path):
    store = _store()
    if any(asset["name"] == path for asset in store["assets"]):
        raise EEException("Cannot overwrite asset '%s'." % path)
    store["assets"].append({"type": value["type"], "name": path, "updateTime": "2026-10-08T00:00:00Z"})
    _write(store)


def deleteAsset(path):
    store = _store()
    store["assets"] = [asset for asset in store["assets"] if asset["name"] != path]
    _write(store)


def export(element, description, path, kind):
    """Starts an export, which as the flags say is refused at once, fails, stays running, finishes on the first look
    at it, or finishes as it starts."""
    if flags.raised("export-refused"):
        raise EEException("Image.load: Image asset 'projects/majestic/assets/none' not found.")
    store = _store()
    number = len(store["operations"])
    state = "FAILED" if flags.raised("export-fails") else "RUNNING" if flags.raised("export-running") or flags.raised("export-slow") else "SUCCEEDED"
    created = "2026-10-08T10:%02d:00Z" % number
    operation = {
        "name": "projects/majestic/operations/OP%d" % number,
        "metadata": {"description": description, "state": state, "createTime": created, "updateTime": created, "progress": 0.5},
        "done": state in ("FAILED", "SUCCEEDED"),
        "path": path,
        "kind": kind,
        "properties": element.properties,
        "finishes": flags.raised("export-slow"),
    }
    if state == "FAILED":
        operation["error"] = {"message": "User memory limit exceeded."}
    if state == "SUCCEEDED":
        _saved(store, operation)
    store["operations"].append(operation)
    _write(store)
    return "OP%d" % number, operation["name"]


def getOperation(name):
    store = _store()
    operation = next(operation for operation in store["operations"] if operation["name"] == name)
    found = json.loads(json.dumps(operation))
    if operation["finishes"]:
        operation.update(done=True, finishes=False)
        operation["metadata"]["state"] = "SUCCEEDED"
        _saved(store, operation)
        _write(store)
    return found


def cancelOperation(name):
    store = _store()
    for operation in store["operations"]:
        if operation["name"] == name:
            operation["metadata"]["state"] = "CANCELLED"
            operation["done"] = True
    _write(store)
`,
  "ee/serializer.py": `import json


def toJSON(element):
    """A computation as Earth Engine serializes one: an asset's path stands for reading that asset."""
    if element.graph.startswith("projects/"):
        load = {"functionName": "Image.load", "arguments": {"id": {"constantValue": element.graph}}}
        return json.dumps({"result": "0", "values": {"0": {"functionInvocationValue": load}}})
    return json.dumps({"result": "0", "values": {"0": {"constantValue": element.graph}}})
`,
  "ee/batch.py": `from ee import data


class Task:
    def __init__(self, element, description, path, kind):
        self.arguments = (element, description, path, kind)

    def start(self):
        self.id, self.operation_name = data.export(*self.arguments)


class Export:
    class image:
        @staticmethod
        def toAsset(image, description, assetId, overwrite=False, **grid):
            assert overwrite
            return Task(image, description, assetId, "IMAGE")

    class table:
        @staticmethod
        def toAsset(collection, description, assetId, overwrite=False):
            assert overwrite
            return Task(collection, description, assetId, "TABLE")
`,
  "ee/__init__.py": `import os

import requests
from googleapiclient import errors

from ee import batch, data, oauth, serializer
from ee.ee_exception import EEException

__version__ = "1.7.19"


class Element:
    """A computation, by a text standing for its graph, with the properties set on it."""

    def __init__(self, graph, properties=None):
        self.graph = graph
        self.properties = properties or {}

    def set(self, properties):
        return type(self)(self.graph, dict(self.properties, **properties))

    def geometry(self):
        return Geometry("geometry of " + self.graph)


class Image(Element):
    pass


class ImageCollection(Element):
    pass


class FeatureCollection(Element):
    pass


class Feature(Element):
    pass


class Geometry(Element):
    pass


def refuse(status, reasons, message):
    try:
        raise errors.HttpError(status, reasons, message)
    except errors.HttpError:
        raise EEException(message)


def Initialize(credentials=None, project=None):
    print("*** Earth Engine *** Share your feedback")
    # As earthengine-api does, given none.
    if credentials is None:
        import google.auth

        credentials = google.auth.default()[0]
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

/**
 * The real Python 3 standing in for the base environment's, with the stubs first on its path, behaving as the flags
 * say. Isolated as GeoEngine runs it, it ignores PYTHONPATH, so the stubs are put on its path by a line before the
 * program it reads from standard input, as every GEE program is given.
 */
const stubbedPython = async (directory: string, raised: readonly Flag[] = []) => {
  const stubs = path.join(directory, "stubs")
  for (const [name, text] of Object.entries(STUBS)) {
    await fs.mkdir(path.dirname(path.join(stubs, name)), { recursive: true })
    await fs.writeFile(path.join(stubs, name), text)
  }
  await fs.mkdir(path.join(stubs, "flags"), { recursive: true })
  for (const flag of raised) await fs.writeFile(path.join(stubs, "flags", flag), "")
  const file = path.join(directory, "python")
  const body = [
    "#!/bin/sh",
    `{ echo 'import sys; sys.path.insert(0, ${JSON.stringify(stubs)})'; cat; } | '${python3}' "$@"`,
  ]
  await fs.writeFile(file, body.join("\n") + "\n")
  await fs.chmod(file, 0o755)
  return file
}

/**
 * GeoCode's Python environment as GEE finds it, with the stubbed Python for its base: ready at once, or, given `later`,
 * being installed until it settles.
 */
const environment = (base: string, later?: Promise<void>): Engine.Capability =>
  Effect.gen(function* () {
    const status = yield* Status.Service
    const ready = { status: "ready", version: "3.13.17", python: base, base }
    const writer = yield* status.register<unknown>(
      "python",
      later ? { status: "preparing", step: "installing" } : ready,
    )
    const token = yield* writer.claim()
    if (later) yield* Effect.forkScoped(Effect.promise(() => later).pipe(Effect.andThen(writer.commit(token, ready))))
    return { domain: "python", methods: {} }
  })

/** Raises a flag of the stubbed Python made in `directory` while it is in use. */
const raise = (directory: string, flag: Flag) => fs.writeFile(path.join(directory, "stubs", "flags", flag), "")

const lower = (directory: string, flag: Flag) => fs.rm(path.join(directory, "stubs", "flags", flag), { force: true })

type Response = Extract<Protocol.Outbound, { type: "response" }>
type Progress = Extract<Protocol.Outbound, { type: "progress" }>

const until = async (predicate: () => boolean | Promise<boolean>, ms: number, what: string) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 20) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * An engine with GEE configured as `gee` says, in machine.json, and with the stubbed Python behaving as `flags` say.
 * GeoCode's Python environment is ready at once, or once `later` settles.
 */
const start = async (gee?: unknown, flags: readonly Flag[] = [], later?: Promise<void>) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-gee-"))
  const machine = path.join(directory, "machine.json")
  if (gee !== undefined) await fs.writeFile(machine, JSON.stringify({ gee }))
  const python = await stubbedPython(directory, flags)
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
  const fiber = Effect.runFork(
    Effect.scoped(Engine.run(transport, [environment(python, later), Gee.capability])).pipe(Effect.provide(layer)),
  )
  const states = () =>
    sent.flatMap((message) =>
      message.type === "status" && message.domain === "gee" ? [message.value as Gee.State] : [],
    )
  const settled = async (ms = 10000) => {
    await until(() => (states().at(-1)?.status ?? "checking") !== "checking", ms, "GEE to settle")
    return states().at(-1)!
  }
  let nextId = 0
  /** A run in a task with nothing saved yet, unless the test names one. */
  const send = (params: Record<string, unknown>, method = "gee.run") => {
    nextId += 1
    const sent =
      method === "gee.run" ? { task: { name: "test-20261008", new: false, started: true }, ...params } : params
    deliver({ type: "request", id: nextId, method, params: sent })
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
  return {
    directory,
    machine,
    python,
    sent,
    states,
    settled,
    send,
    response,
    progress,
    deliver: (m: unknown) => deliver(m),
    stop,
  }
}

const result = (response: Response) => {
  assert.ok(response.ok, JSON.stringify(response))
  return response.result as { outcome: string; output: string; truncated: boolean; durationMs: number; exit?: string }
}

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
      { project: "offline", status: "unreachable" },
      // Guards against the network failing at the sign-in's refresh reading as refused credentials.
      { flags: ["offline-refresh"], project: "majestic", status: "unreachable" },
      // Guards against Earth Engine failing on its side reading as a refusal of the project.
      { project: "overloaded", status: "unreachable" },
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

test(
  "a run hands GeoAgent what the script printed, and nothing printed before it began",
  { skip: !python3 },
  async () => {
    const engine = await start("majestic")
    try {
      const ready = await engine.settled()
      assert.ok(ready.status === "ready")
      const script = 'import os\nprint("中文", os.getcwd())\nprint(ee.Number(1).getInfo())'
      const id = engine.send({ script, cwd: engine.directory })
      const done = result(await engine.response(id))
      assert.equal(done.outcome, "finished")
      const cwd = await fs.realpath(engine.directory)
      assert.equal(done.output, `中文 ${cwd}\n1\n`)
      assert.doesNotMatch(done.output, /Earth Engine|__GEOCODE_GEE__/)
      // Guards against the tool row's log losing or adding to what the answer has.
      const [begun, ...printed] = engine.progress(id) as [unknown, ...{ output: string }[]]
      assert.deepEqual(begun, { begun: true })
      assert.ok(printed.every((data) => Object.keys(data).join() === "output"))
      assert.equal(printed.map((data) => data.output).join(""), done.output)
    } finally {
      await engine.stop()
    }
  },
)

test("a failing script ends with its traceback, from its own lines", { skip: !python3 }, async () => {
  const engine = await start("majestic")
  try {
    assert.equal((await engine.settled()).status, "ready")
    const done = result(
      await engine.response(engine.send({ script: "divisor = 0\nvalue = 1 / divisor\n", cwd: engine.directory })),
    )
    assert.equal(done.outcome, "failed")
    assert.match(
      done.output,
      /^Traceback \(most recent call last\):\n {2}File "<script>", line 2, in <module>\n {4}value = 1 \/ divisor\n/,
    )
    assert.match(done.output, /ZeroDivisionError/)
    assert.doesNotMatch(done.output, /<stdin>/)
  } finally {
    await engine.stop()
  }
})

test(
  "a file in the session's folder named like a module the run needs does not replace it, and the script runs as __main__",
  { skip: !python3 },
  async () => {
    const engine = await start("majestic")
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
    const engine = await start("majestic")
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

test("a run stopped during a download leaves no unfinished file", { skip: !python3 }, async () => {
  const engine = await start("majestic")
  try {
    assert.equal((await engine.settled()).status, "ready")
    // Guards against the hidden file of a stopped download staying in the user's folder.
    const unfinished = path.join(engine.directory, ".area.tif.1.part")
    // Guards against removing a file of the user's that a line of output names.
    const kept = path.join(engine.directory, "thesis.tif")
    await fs.writeFile(kept, "mine")
    const script = [
      "import time",
      "from geocode import _run",
      `_run.partial(${JSON.stringify(unfinished)})`,
      `open(${JSON.stringify(unfinished)}, "w").write("half")`,
      `_run.partial(${JSON.stringify(kept)})`,
      'print("downloading", flush=True)',
      "time.sleep(60)",
    ].join("\n")
    const id = engine.send({ script, cwd: engine.directory })
    await until(() => JSON.stringify(engine.progress(id)).includes("downloading"), 20000, "the download to start")
    engine.deliver({ type: "cancel", id })
    const response = await engine.response(id)
    assert.equal(!response.ok && response.error.code, "cancelled")
    await assert.rejects(fs.access(unfinished))
    await fs.access(kept)
  } finally {
    await engine.stop()
  }
})

const machineGee = async (machine: string) => JSON.parse(await fs.readFile(machine, "utf-8")).gee

/** Writes the user's assets the stubbed earthengine-api lists, in the project "majestic", with no exports yet. */
const holding = (directory: string, assets: readonly object[]) =>
  fs.writeFile(path.join(directory, "stubs", "flags", "assets.json"), JSON.stringify({ assets, operations: [] }))

const ROOT = "projects/majestic/assets/GeoCode"
const folder = (name: string, updateTime: string) => ({ type: "FOLDER", name, id: name, updateTime })

test("a run reads its task in GeoCode's folder, for the answer to start with", { skip: !python3 }, async () => {
  const engine = await start("majestic")
  try {
    assert.equal((await engine.settled()).status, "ready")
    const task = `${ROOT}/taipei-ndvi-20261008`
    await holding(engine.directory, [
      folder(ROOT, "2026-09-01T00:00:00Z"),
      folder(task, "2026-10-08T01:00:00Z"),
      { type: "IMAGE", name: `${task}/composite`, updateTime: "2026-10-08T06:00:00Z" },
      { type: "TABLE", name: `${task}/area`, updateTime: "2026-10-08T02:00:00Z" },
    ])
    const done = result(
      await engine.response(
        engine.send({
          script: "print(1)",
          cwd: engine.directory,
          task: { name: "taipei-ndvi-20261008", new: false, started: false },
        }),
      ),
    )
    assert.equal(done.outcome, "finished")
    assert.equal(done.output, "1\n")
    const space = (done as unknown as { space: { assets: { name: string }[] } }).space
    assert.deepEqual(
      space.assets.map((asset) => asset.name),
      ["composite", "area"],
    )

    // A task to continue that saved nothing and that this conversation did not start: a mistyped name, likely.
    const marker = path.join(engine.directory, "ran")
    const typo = await engine.response(
      engine.send({
        script: `open(${JSON.stringify(marker)}, "w").write("ran")`,
        cwd: engine.directory,
        task: { name: "taipei-ndvi-20261080", new: false, started: false },
      }),
    )
    assert.equal(!typo.ok && typo.error.code, "task-missing")
    assert.equal(
      await fs.stat(marker).then(
        () => true,
        () => false,
      ),
      false,
    )

    // Guards against a run that only reads leaving anything in the user's Earth Engine.
    await holding(engine.directory, [])
    assert.equal(
      result(await engine.response(engine.send({ script: "print(2)", cwd: engine.directory }))).outcome,
      "finished",
    )
    const left = JSON.parse(await fs.readFile(path.join(engine.directory, "stubs", "flags", "assets.json"), "utf-8"))
    assert.deepEqual(left.assets, [])
  } finally {
    await engine.stop()
  }
})

test("the header stays within the line GeoEngine reads", { skip: !python3 }, async () => {
  const engine = await start("majestic")
  try {
    assert.equal((await engine.settled()).status, "ready")
    // A hundred assets with descriptions far longer than anyone writes.
    const root = `${ROOT}/taipei-ndvi-20261008`
    const long = (index: number) => ({
      type: "IMAGE",
      name: `${root}/asset_${index}`,
      updateTime: `2026-10-08T00:00:${String(index % 60).padStart(2, "0")}Z`,
      properties: { title: "标".repeat(100), description: "说".repeat(1000) },
    })
    await holding(engine.directory, [
      folder(ROOT, "2026-09-01T00:00:00Z"),
      folder(root, "2026-10-08T00:00:00Z"),
      ...Array.from({ length: 100 }, (_, index) => long(index)),
    ])
    const continuing = { name: "taipei-ndvi-20261008", new: false, started: false }
    const full = result(
      await engine.response(engine.send({ script: "print(1)", cwd: engine.directory, task: continuing })),
    )
    // Guards against a header longer than GeoEngine reads a line, which would lose the whole of it.
    const space = (full as unknown as { space: { assets: unknown[]; more: number } }).space
    assert.ok(space.more > 0, `${space.assets.length} listed, ${space.more} more`)
    assert.equal(space.assets.length + space.more, 100)
  } finally {
    await engine.stop()
  }
})

test("a new task whose name is taken is refused before the script runs", { skip: !python3 }, async () => {
  const engine = await start("majestic")
  try {
    assert.equal((await engine.settled()).status, "ready")
    const task = `${ROOT}/taipei-ndvi-20261008`
    await holding(engine.directory, [
      folder(ROOT, "2026-09-01T00:00:00Z"),
      folder(task, "2026-10-08T01:00:00Z"),
      { type: "IMAGE", name: `${task}/composite`, updateTime: "2026-10-08T06:00:00Z" },
      { type: "TABLE", name: `${task}/area`, updateTime: "2026-10-08T02:00:00Z" },
    ])
    const marker = path.join(engine.directory, "ran")
    const script = `open(${JSON.stringify(marker)}, "w").write("ran")`
    const taken = await engine.response(
      engine.send({ script, cwd: engine.directory, task: { name: "taipei-ndvi-20261008", new: true, started: false } }),
    )
    assert.equal(!taken.ok && taken.error.code, "task-taken")
    assert.equal(
      await fs.stat(marker).then(
        () => true,
        () => false,
      ),
      false,
    )
  } finally {
    await engine.stop()
  }
})

// Guards against two runs of one task, from parallel calls or two conversations, racing to save the same assets.
test("a task runs one call at a time, while other tasks run beside it", { skip: !python3 }, async () => {
  const engine = await start("majestic")
  try {
    assert.equal((await engine.settled()).status, "ready")
    await holding(engine.directory, [])
    const release = path.join(engine.directory, "release")
    const held = `import os, time\nwhile not os.path.exists(${JSON.stringify(release)}):\n    time.sleep(0.05)\nprint("done")`
    const task = (name: string) => ({ name, new: false, started: true })
    const first = engine.send({ script: held, cwd: engine.directory, task: task("a-20261009") })
    await until(() => engine.progress(first).length > 0, 10000, "the first run to begin")

    const busy = await engine.response(
      engine.send({ script: "print(1)", cwd: engine.directory, task: task("a-20261009") }),
    )
    assert.equal(!busy.ok && busy.error.code, "task-busy")
    const beside = result(
      await engine.response(engine.send({ script: "print(2)", cwd: engine.directory, task: task("b-20261009") })),
    )
    assert.equal(beside.output, "2\n")

    await fs.writeFile(release, "")
    assert.equal(result(await engine.response(first)).output, "done\n")
    const again = result(
      await engine.response(engine.send({ script: "print(3)", cwd: engine.directory, task: task("a-20261009") })),
    )
    assert.equal(again.output, "3\n")
  } finally {
    await engine.stop()
  }
})

type Stored = {
  assets: { name: string; type: string; properties?: Record<string, string> }[]
  operations: { metadata: { description: string; state: string } }[]
}
const stored = async (directory: string) =>
  JSON.parse(await fs.readFile(path.join(directory, "stubs", "flags", "assets.json"), "utf-8")) as Stored

/** The asset each export was for, in order, by the "task:asset:fingerprint" its description names. */
const exported = (held: Stored) => held.operations.map((operation) => operation.metadata.description.split(":")[1])

/**
 * A script saving to the task, with the stub's graphs standing for computations; GeoCode's wait does not sleep, and an
 * image is saved as it is, the stub having no grids.
 */
const saving = (...lines: string[]) =>
  [
    "import geocode as gc",
    "import geocode._outputs",
    "geocode._outputs.POLL_SECONDS = 0",
    "geocode._outputs.measured = lambda image, grid: (image, grid)",
    ...lines,
  ].join("\n")

const TASK = { name: "t-20261008", new: true, started: false }

test(
  "gc.save makes the task's folders, and reuses or replaces an asset by its content",
  { skip: !python3 },
  async () => {
    const engine = await start("majestic")
    try {
      assert.equal((await engine.settled()).status, "ready")
      await holding(engine.directory, [])
      const save = (graph: string, scale: string) =>
        `saved = gc.save(ee.Image("${graph}"), "ndvi", title="台北 NDVI", description="夏季中值", scale=${scale})`
      const script = saving(
        save("ndvi", "10"),
        "print(type(saved).__name__, saved.graph)",
        // The same grid written another way is the same content.
        save("ndvi", "10.0"),
        save("ndvi masked", "10"),
        'gc.save(ee.FeatureCollection("area"), "area", title="范围", description="研究区")',
      )
      const done = result(await engine.response(engine.send({ script, cwd: engine.directory, task: TASK })))
      // What gc.save returns is the saved asset, read back.
      assert.match(done.output, new RegExp(`^Image ${ROOT}/t-20261008/ndvi$`, "m"))
      const after = await stored(engine.directory)
      assert.deepEqual(
        after.assets.map((asset) => [asset.name, asset.type]),
        [
          [ROOT, "FOLDER"],
          [`${ROOT}/t-20261008`, "FOLDER"],
          [`${ROOT}/t-20261008/ndvi`, "IMAGE"],
          [`${ROOT}/t-20261008/area`, "TABLE"],
        ],
      )
      // Exported once, not again for the same grid written another way, again for other content.
      assert.deepEqual(exported(after), ["ndvi", "ndvi", "area"])
    } finally {
      await engine.stop()
    }
  },
)

// Guards against a save built on another of the task's assets being read as unchanged after that asset was replaced:
// the computation names it by the same path.
test(
  "a save that reads one of GeoCode's assets is done again once that asset is replaced",
  { skip: !python3 },
  async () => {
    const engine = await start("majestic")
    try {
      assert.equal((await engine.settled()).status, "ready")
      await holding(engine.directory, [])
      const save = (data: string, name: string) => `gc.save(${data}, "${name}", title="t", description="d", scale=10)`
      const script = saving(
        `composite = ${save('ee.Image("composite")', "composite")}`,
        save("composite", "copy"),
        save("composite", "copy"),
        save('ee.Image("composite, cloudless")', "composite"),
        save('gc.load("composite")', "copy"),
      )
      result(await engine.response(engine.send({ script, cwd: engine.directory, task: TASK })))
      // The copy is reused while the composite it reads is unchanged, and exported again once that is replaced.
      assert.deepEqual(exported(await stored(engine.directory)), ["composite", "copy", "composite", "copy"])
    } finally {
      await engine.stop()
    }
  },
)

test("a failed save leaves no folder it made, and reports the failure", { skip: !python3 }, async () => {
  const engine = await start("majestic")
  try {
    assert.equal((await engine.settled()).status, "ready")
    await holding(engine.directory, [])
    const script = saving('gc.save(ee.Image("ndvi"), "ndvi", title="t", description="d", scale=10)')
    for (const flag of ["export-fails", "export-refused"] as const) {
      await raise(engine.directory, flag)
      const done = result(await engine.response(engine.send({ script, cwd: engine.directory, task: TASK })))
      await lower(engine.directory, flag)
      assert.equal(done.outcome, "failed")
      // GeoCode's own lines, by the package's file names, as an installed package's would be.
      assert.match(done.output, /File "geocode\/_assets\.py", line \d+, in save\n {4}\S/)
      assert.deepEqual((await stored(engine.directory)).assets, [])
    }
  } finally {
    await engine.stop()
  }
})

test("an export under way is waited for, joined, or replaced", { skip: !python3 }, async () => {
  const engine = await start("majestic")
  try {
    assert.equal((await engine.settled()).status, "ready")
    await holding(engine.directory, [])
    await raise(engine.directory, "export-slow")
    const save = (graph: string) => `gc.save(ee.Image("${graph}"), "ndvi", title="t", description="d", scale=10)`
    const id = engine.send({ script: saving(save("ndvi")), cwd: engine.directory, task: TASK })
    assert.equal(result(await engine.response(id)).outcome, "finished")
    await lower(engine.directory, "export-slow")

    // A run stopped while it waits leaves its export running on the server.
    const continuing = { name: "t-20261008", new: false, started: false }
    const stopped = async (graph: string) => {
      await raise(engine.directory, "export-running")
      const id = engine.send({ script: saving(save(graph)), cwd: engine.directory, task: continuing })
      // Waiting on the export, not on the save's first status, which comes before the export is submitted.
      const exporting = () =>
        engine.progress(id).some((data) => (data as { status?: { progress?: number } }).status?.progress !== undefined)
      await until(exporting, 10000, "the export")
      engine.deliver({ type: "cancel", id })
      const response = await engine.response(id)
      assert.equal(!response.ok && response.error.code, "cancelled")
      await lower(engine.directory, "export-running")
    }
    await stopped("ndvi masked")
    // The export left running finishes on the next look at it.
    const file = path.join(engine.directory, "stubs", "flags", "assets.json")
    const left = JSON.parse(await fs.readFile(file, "utf-8"))
    left.operations.find((operation: Stored["operations"][number]) => operation.metadata.state === "RUNNING").finishes =
      true
    await fs.writeFile(file, JSON.stringify(left))
    result(
      await engine.response(
        engine.send({ script: saving(save("ndvi masked")), cwd: engine.directory, task: continuing }),
      ),
    )

    await stopped("ndvi clipped")
    // Guards against reading the saved asset while another version of it is still being exported over it.
    result(
      await engine.response(
        engine.send({ script: saving(save("ndvi masked")), cwd: engine.directory, task: continuing }),
      ),
    )
    // Joined rather than exported again, then the other version cancelled: three exports in all.
    assert.deepEqual(
      (await stored(engine.directory)).operations.map((operation) => operation.metadata.state),
      ["SUCCEEDED", "SUCCEEDED", "CANCELLED"],
    )
  } finally {
    await engine.stop()
  }
})

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
