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
 * Earth Engine's own but Google Cloud's default ones; "no-geopandas" leaves the package out; "unlistable" refuses to
 * list assets; the "export-" flags say how an export goes (see the stub's `export`).
 */
type Flag =
  | "signed-out"
  | "adc"
  | "revoked"
  | "offline-refresh"
  | "no-geopandas"
  | "broken-geedim"
  | "unlistable"
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
    return "credentials"


def _store():
    """The user's assets and exports, as the test writes them to assets.json."""
    path = os.path.join(flags.FOLDER, "assets.json")
    if not os.path.exists(path):
        return {"assets": [], "operations": []}
    with open(path, encoding="utf-8") as source:
        return json.load(source)


def listAssets(params):
    if flags.raised("unlistable"):
        raise EEException("Caller does not have required permission to list assets")
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

const lower = (directory: string, flag: Flag) => fs.rm(path.join(directory, "stubs", "flags", flag), { force: true })

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
  `The user must sign in with their Google account. They can do it themselves in GeoCode's settings, under Geo environment, Google Earth Engine. Or ask them to get it ready; once they say so, run \`${command}\` with a timeout of 10 minutes. It opens their browser and ends when they finish there.`
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

const machineGee = async (machine: string) => JSON.parse(await fs.readFile(machine, "utf-8")).gee

/** Writes the user's assets the stubbed earthengine-api lists, in the project "majestic", with no exports yet. */
const holding = (directory: string, assets: readonly object[]) =>
  fs.writeFile(path.join(directory, "stubs", "flags", "assets.json"), JSON.stringify({ assets, operations: [] }))

const ROOT = "projects/majestic/assets/GeoCode"
const folder = (name: string, updateTime: string) => ({ type: "FOLDER", name, id: name, updateTime })

test("a run reads its task in GeoCode's folder, for the answer to start with", { skip: !python3 }, async () => {
  const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
  try {
    assert.equal((await engine.settled()).status, "ready")
    const task = `${ROOT}/taipei-ndvi-20261008`
    await holding(engine.directory, [
      folder(ROOT, "2026-09-01T00:00:00Z"),
      folder(task, "2026-10-08T01:00:00Z"),
      {
        type: "IMAGE",
        name: `${task}/composite`,
        updateTime: "2026-10-08T06:00:00Z",
        bands: [{ id: "B4" }, { id: "B8" }],
        properties: { title: "台北夏季合成", description: " Sentinel-2 中值合成 ", saved: "2026-10-08T05:59:00Z" },
      },
      { type: "TABLE", name: `${task}/area`, updateTime: "2026-10-08T02:00:00Z" },
      // Not a task: GeoCode's tasks are folders.
      { type: "IMAGE", name: `${ROOT}/stray`, updateTime: "2026-10-08T09:00:00Z" },
      folder(`${ROOT}/a-20260901`, "2026-09-01T00:00:00Z"),
      folder(`${ROOT}/b-20260902`, "2026-09-02T00:00:00Z"),
      { type: "TABLE", name: `${ROOT}/b-20260902/x`, updateTime: "2026-10-01T00:00:00Z" },
      folder(`${ROOT}/c-20260903`, "2026-09-03T00:00:00Z"),
      folder(`${ROOT}/d-20260904`, "2026-09-04T00:00:00Z"),
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
    assert.deepEqual((done as unknown as { space: unknown }).space, {
      assets: [
        {
          name: "composite",
          type: "IMAGE",
          saved: "2026-10-08T05:59:00Z",
          bands: ["B4", "B8"],
          title: "台北夏季合成",
          description: "Sentinel-2 中值合成",
        },
        { name: "area", type: "TABLE", saved: "2026-10-08T02:00:00Z" },
      ],
      more: 0,
      others: [
        { name: "b-20260902", assets: 1, updated: "2026-10-01T00:00:00Z" },
        { name: "d-20260904", assets: 0, updated: "2026-09-04T00:00:00Z" },
        { name: "c-20260903", assets: 0, updated: "2026-09-03T00:00:00Z" },
      ],
      tasks: 4,
    })

    // A task to continue that saved nothing and that this conversation did not start: a mistyped name, likely.
    const marker = path.join(engine.directory, "ran")
    const typo = await engine.response(
      engine.send({
        script: `open(${JSON.stringify(marker)}, "w").write("ran")`,
        cwd: engine.directory,
        task: { name: "taipei-ndvi-20261080", new: false, started: false },
      }),
    )
    assert.deepEqual(!typo.ok && { code: typo.error.code, message: typo.error.message }, {
      code: "task-missing",
      message:
        "There is no task taipei-ndvi-20261080: it has saved nothing in GeoCode's folder, and this conversation did not start it; the latest tasks are taipei-ndvi-20261008, b-20260902, d-20260904",
    })
    assert.equal(
      await fs.stat(marker).then(
        () => true,
        () => false,
      ),
      false,
    )

    // A task with no folder yet, in a project without GeoCode's folder: nothing is made by reading.
    await holding(engine.directory, [])
    const fresh = result(await engine.response(engine.send({ script: "print(2)", cwd: engine.directory })))
    assert.deepEqual((fresh as unknown as { space: unknown }).space, {
      assets: [],
      more: 0,
      others: [],
      tasks: 0,
    })
  } finally {
    await engine.stop()
  }
})

test("the header stays within the line GeoEngine reads", { skip: !python3 }, async () => {
  const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
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
    const space = (full as unknown as { space: { assets: { description: string }[]; more: number } }).space
    assert.ok(space.assets.length > 10 && space.more > 0, `${space.assets.length} listed, ${space.more} more`)
    assert.equal(space.assets.length + space.more, 100)
    assert.equal(space.assets[0]!.description.length, 500)
    assert.ok(Buffer.byteLength(JSON.stringify(space), "utf-8") <= 48 * 1024)
  } finally {
    await engine.stop()
  }
})

test("a new task whose name is taken is refused before the script runs", { skip: !python3 }, async () => {
  const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
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
    assert.equal(taken.ok, false)
    assert.deepEqual(!taken.ok && { code: taken.error.code, message: taken.error.message }, {
      code: "task-taken",
      message: "The task taipei-ndvi-20261008 already exists, with 2 assets: area, composite",
    })
    assert.equal(
      await fs.stat(marker).then(
        () => true,
        () => false,
      ),
      false,
    )

    // Guards against a task of many assets making the refusal too long to be read, and the run taken for a crash.
    await holding(engine.directory, [
      folder(ROOT, "2026-09-01T00:00:00Z"),
      folder(task, "2026-10-08T01:00:00Z"),
      ...Array.from({ length: 25 }, (_, index) => ({
        type: "IMAGE",
        name: `${task}/a${String(index).padStart(2, "0")}`,
        updateTime: "2026-10-08T06:00:00Z",
      })),
    ])
    const many = await engine.response(
      engine.send({ script, cwd: engine.directory, task: { name: "taipei-ndvi-20261008", new: true, started: false } }),
    )
    const listed = Array.from({ length: 20 }, (_, index) => `a${String(index).padStart(2, "0")}`).join(", ")
    assert.equal(
      !many.ok && many.error.message,
      `The task taipei-ndvi-20261008 already exists, with 25 assets: ${listed} and 5 more`,
    )

    const named = await engine.response(
      engine.send({ script, cwd: engine.directory, task: { name: "taipei ndvi", new: true, started: false } }),
    )
    assert.equal(!named.ok && named.error.code, "invalid-params")
  } finally {
    await engine.stop()
  }
})

test("a run whose task cannot be read fails before the script runs", { skip: !python3 }, async () => {
  const engine = await start(async (directory) => ({
    python: await stubbedPython(directory, ["unlistable"]),
    project: "majestic",
  }))
  try {
    assert.equal((await engine.settled()).status, "ready")
    await holding(engine.directory, [folder(ROOT, "2026-09-01T00:00:00Z")])
    const response = await engine.response(engine.send({ script: "print(1)", cwd: engine.directory }))
    assert.deepEqual(!response.ok && { code: response.error.code, message: response.error.message }, {
      code: "space-failed",
      message: "EEException: Caller does not have required permission to list assets",
    })
  } finally {
    await engine.stop()
  }
})

// Guards against two runs of one task, from parallel calls or two conversations, racing to save the same assets.
test("a task runs one call at a time, while other tasks run beside it", { skip: !python3 }, async () => {
  const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
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
    assert.deepEqual(!busy.ok && { code: busy.error.code, message: busy.error.message }, {
      code: "task-busy",
      message: "The task a-20261009 is already running in another call",
    })
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

test("the script imports GeoCode's module, which reads the task's assets by name", { skip: !python3 }, async () => {
  const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
  try {
    assert.equal((await engine.settled()).status, "ready")
    const task = `${ROOT}/taipei-ndvi-20261008`
    await holding(engine.directory, [
      folder(ROOT, "2026-09-01T00:00:00Z"),
      folder(task, "2026-10-08T01:00:00Z"),
      { type: "IMAGE", name: `${task}/composite`, updateTime: "2026-10-08T06:00:00Z" },
    ])
    const script = [
      "import geocode as gc",
      "for name in ['ndvi', 'other-20261001/x', 'a/b/c']:",
      "    try:",
      "        gc.load(name)",
      "    except Exception as error:",
      "        print(type(error).__name__, error)",
    ].join("\n")
    const done = result(
      await engine.response(
        engine.send({
          script,
          cwd: engine.directory,
          task: { name: "taipei-ndvi-20261008", new: false, started: false },
        }),
      ),
    )
    assert.equal(
      done.output,
      [
        "LookupError Task taipei-ndvi-20261008 has no asset ndvi. Its assets: composite.",
        "LookupError There is no task other-20261001 in GeoCode's folder.",
        `ValueError gc.load takes "asset" of this task, "task/asset" of another, or a full path starting with "projects/", not 'a/b/c'.`,
        "",
      ].join("\n"),
    )
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
  "gc.save makes the task's folders, writes what the asset is, and reuses or replaces it by its content",
  { skip: !python3 },
  async () => {
    const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
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
      assert.equal(
        done.output,
        [
          "Exporting ndvi (export ID OP0); waiting for it.",
          "Saved ndvi after 0 s.",
          `Image ${ROOT}/t-20261008/ndvi`,
          "ndvi is unchanged since it was saved; reading the saved asset.",
          "Warning: ndvi was saved before with other content; it is being replaced.",
          "Exporting ndvi (export ID OP1); waiting for it.",
          "Saved ndvi after 0 s.",
          "Exporting area (export ID OP2); waiting for it.",
          "Saved area after 0 s.",
          "",
        ].join("\n"),
      )
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
      const ndvi = after.assets[2]!.properties!
      assert.deepEqual(
        { title: ndvi.title, description: ndvi.description, task: ndvi.task },
        { title: "台北 NDVI", description: "夏季中值", task: "t-20261008" },
      )
      assert.match(ndvi.saved!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      // A running export is known by its description alone: the task, the asset and its fingerprint.
      const labels = after.operations.map((operation) => operation.metadata.description)
      assert.deepEqual(
        labels.map((label) => label.replace(/:[0-9a-f]{8}$/, "")),
        ["t-20261008:ndvi", "t-20261008:ndvi", "t-20261008:area"],
      )
      assert.equal(labels[1]!.slice(-8), ndvi.fingerprint!.slice(0, 8))
      assert.notEqual(labels[0], labels[1])
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
    const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
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
      const done = result(await engine.response(engine.send({ script, cwd: engine.directory, task: TASK })))
      assert.equal(
        done.output,
        [
          "Exporting composite (export ID OP0); waiting for it.",
          "Saved composite after 0 s.",
          "Exporting copy (export ID OP1); waiting for it.",
          "Saved copy after 0 s.",
          "copy is unchanged since it was saved; reading the saved asset.",
          "Warning: composite was saved before with other content; it is being replaced.",
          "Exporting composite (export ID OP2); waiting for it.",
          "Saved composite after 0 s.",
          "Warning: copy was saved before with other content; it is being replaced.",
          "Exporting copy (export ID OP3); waiting for it.",
          "Saved copy after 0 s.",
          "",
        ].join("\n"),
      )
    } finally {
      await engine.stop()
    }
  },
)

test("a failed save leaves no folder it made, and reports the failure", { skip: !python3 }, async () => {
  const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
  try {
    assert.equal((await engine.settled()).status, "ready")
    await holding(engine.directory, [])
    const script = saving('gc.save(ee.Image("ndvi"), "ndvi", title="t", description="d", scale=10)')
    for (const [flag, error] of [
      ["export-fails", "RuntimeError: Exporting ndvi failed: User memory limit exceeded."],
      ["export-refused", "EEException: Image.load: Image asset 'projects/majestic/assets/none' not found."],
    ] as const) {
      await raise(engine.directory, flag)
      const done = result(await engine.response(engine.send({ script, cwd: engine.directory, task: TASK })))
      await lower(engine.directory, flag)
      assert.equal(done.outcome, "failed")
      assert.match(done.output, new RegExp(`${error.replace(/[.()]/g, "\\$&")}\n$`))
      // GeoCode's own lines, by the package's file names, as an installed package's would be.
      assert.match(done.output, /File "geocode\/_assets\.py", line \d+, in save\n {4}\S/)
      assert.deepEqual((await stored(engine.directory)).assets, [])
    }
  } finally {
    await engine.stop()
  }
})

test(
  "an export under way is waited for with its progress on the tool row, joined, or replaced",
  { skip: !python3 },
  async () => {
    const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
    try {
      assert.equal((await engine.settled()).status, "ready")
      await holding(engine.directory, [])
      await raise(engine.directory, "export-slow")
      const save = (graph: string) => `gc.save(ee.Image("${graph}"), "ndvi", title="t", description="d", scale=10)`
      const id = engine.send({ script: saving(save("ndvi")), cwd: engine.directory, task: TASK })
      const done = result(await engine.response(id))
      assert.equal(done.output, "Exporting ndvi (export ID OP0); waiting for it.\nSaved ndvi after 0 s.\n")
      assert.deepEqual(engine.progress(id), [
        { begun: true },
        { export: { asset: "ndvi", state: "RUNNING", progress: 0.5 } },
      ])
      await lower(engine.directory, "export-slow")

      // A run stopped while it waits leaves its export running on the server.
      const continuing = { name: "t-20261008", new: false, started: false }
      const stopped = async (graph: string) => {
        await raise(engine.directory, "export-running")
        const id = engine.send({ script: saving(save(graph)), cwd: engine.directory, task: continuing })
        const exporting = () =>
          engine.progress(id).some((data) => typeof data === "object" && data !== null && "export" in data)
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
      left.operations.find(
        (operation: Stored["operations"][number]) => operation.metadata.state === "RUNNING",
      ).finishes = true
      await fs.writeFile(file, JSON.stringify(left))
      const joined = result(
        await engine.response(
          engine.send({ script: saving(save("ndvi masked")), cwd: engine.directory, task: continuing }),
        ),
      )
      assert.equal(
        joined.output,
        "ndvi is already being exported with the same content; waiting for it.\nSaved ndvi after 0 s.\n",
      )

      await stopped("ndvi clipped")
      // Guards against reading the saved asset while another version of it is still being exported over it.
      const reused = result(
        await engine.response(
          engine.send({ script: saving(save("ndvi masked")), cwd: engine.directory, task: continuing }),
        ),
      )
      assert.equal(
        reused.output,
        "Cancelled an export of ndvi still running with other content.\nndvi is unchanged since it was saved; reading the saved asset.\n",
      )
      assert.deepEqual(
        (await stored(engine.directory)).operations.map((operation) => operation.metadata.state),
        ["SUCCEEDED", "SUCCEEDED", "CANCELLED"],
      )
    } finally {
      await engine.stop()
    }
  },
)

test("a download's share done reaches the tool row, not the answer", { skip: !python3 }, async () => {
  const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
  try {
    assert.equal((await engine.settled()).status, "ready")
    await holding(engine.directory, [])
    const script = 'import geocode._run\ngeocode._run.report({"type": "download", "file": "ndvi.tif", "progress": 0.5})'
    const id = engine.send({ script, cwd: engine.directory, task: TASK })
    assert.equal(result(await engine.response(id)).output, "")
    assert.deepEqual(engine.progress(id), [{ begun: true }, { download: { file: "ndvi.tif", progress: 0.5 } }])
  } finally {
    await engine.stop()
  }
})

// Guards against the settings page losing the project when it chooses a Python, or the Python when it names a project.
test("the settings write the Python or the project, keeping the other, and refuse what is not one", async () => {
  const engine = await start(async () => ({ project: "majestic" }))
  try {
    // A project before any Python is no configuration yet, though the settings show it.
    assert.deepEqual(await engine.settled(), { status: "unconfigured", project: "majestic" })
    // Guards against GeoAgent asking again for a project the user has already named in the settings.
    const refused = await engine.response(engine.send({ script: "print(1)", cwd: engine.directory }))
    const hint = !refused.ok ? refused.error.message : ""
    assert.match(hint, /The project is already set to majestic; keep it when adding the Python\./)
    assert.doesNotMatch(hint, /never guess it/)

    // Guards against a virtual environment chosen by its folder being configured as the Python it was made from.
    const base = path.join(engine.directory, "base", "python3.12")
    await fs.mkdir(path.dirname(base), { recursive: true })
    await fs.writeFile(base, "")
    const venv = path.join(engine.directory, "project", ".venv", "bin", "python")
    await fs.mkdir(path.dirname(venv), { recursive: true })
    await fs.symlink(base, venv)
    const chosen = await engine.response(
      engine.send({ environment: path.join(engine.directory, "project") }, "gee.configure"),
    )
    // The Python found is answered, for a page to tell a choice of the folder already configured from a new one.
    assert.deepEqual(chosen.ok && chosen.result, { python: venv })
    assert.deepEqual(await machineGee(engine.machine), { project: "majestic", python: venv })
    const empty = await engine.response(
      engine.send({ environment: path.join(engine.directory, "base") }, "gee.configure"),
    )
    assert.equal(!empty.ok && empty.error.code, "invalid-params")

    const python = path.join(engine.directory, "missing", "python")
    assert.ok((await engine.response(engine.send({ python }, "gee.configure"))).ok)
    assert.deepEqual(await machineGee(engine.machine), { project: "majestic", python })
    assert.ok((await engine.response(engine.send({ project: "other-project" }, "gee.configure"))).ok)
    assert.deepEqual(await machineGee(engine.machine), { project: "other-project", python })
    // Guards against a project ID the request to Earth Engine cannot carry, as one with a full-width comma typed into it.
    const refusedProjects = [{ project: "has space" }, { project: "" }, { project: "majestic-v4、5" }]
    for (const params of [{ python: "bin/python" }, ...refusedProjects, { other: 1 }]) {
      const response = await engine.response(engine.send(params, "gee.configure"))
      assert.equal(!response.ok && response.error.code, "invalid-params", JSON.stringify(params))
    }
    assert.deepEqual(await machineGee(engine.machine), { project: "other-project", python })
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
  const page = await fetch(`${back}/?${query}`).then((answer) => answer.text())
  return { response: await engine.response(id), page, back: back ?? "" }
}

test("signing in through the browser checks again, and finds the user signed in", { skip: !python3 }, async () => {
  const engine = await start(async (directory) => ({
    python: await stubbedPython(directory, ["signed-out"]),
    project: "majestic",
  }))
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
test("access denied in the browser ends the sign-in at once, saying so there too", { skip: !python3 }, async () => {
  const engine = await start(async (directory) => ({ python: await stubbedPython(directory, ["signed-out"]) }))
  try {
    assert.equal((await engine.settled()).status, "signed-out")
    const { response, page } = await signIn(engine, "error=access_denied")
    assert.equal(!response.ok && response.error.code, "denied")
    assert.match(!response.ok ? response.error.message : "", /access_denied/)
    assert.match(page, /did not complete \(access_denied\)/)
    assert.equal(engine.states().at(-1)?.status, "signed-out")
  } finally {
    await engine.stop()
  }
})

test(
  "a sign-in is cancelled, or ended by another one, without waiting for the browser",
  { skip: !python3 },
  async () => {
    const engine = await start(async (directory) => ({ python: await stubbedPython(directory, ["signed-out"]) }))
    try {
      await engine.settled()
      const first = engine.send({}, "gee.signIn")
      await until(() => engine.progress(first).length > 0, 10000, "the first sign-in")
      const second = engine.send({}, "gee.signIn")
      const replaced = await engine.response(first, 10000)
      assert.equal(!replaced.ok && replaced.error.code, "replaced")
      await until(() => engine.progress(second).length > 0, 10000, "the second sign-in")
      engine.deliver({ type: "cancel", id: second })
      const cancelled = await engine.response(second, 10000)
      assert.equal(!cancelled.ok && cancelled.error.code, "cancelled")
    } finally {
      await engine.stop()
    }
  },
)

test("signing in without a configured Python is refused", async () => {
  const engine = await start()
  try {
    await engine.settled()
    const response = await engine.response(engine.send({}, "gee.signIn"))
    assert.equal(!response.ok && response.error.code, "invalid-params")
  } finally {
    await engine.stop()
  }
})
