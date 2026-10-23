import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Fiber, Layer } from "effect"
import { Config } from "../../src/config.ts"
import { Engine } from "../../src/engine.ts"
import { Gee } from "../../src/gee/index.ts"
import type { Protocol } from "../../src/protocol.ts"
import { Runtime } from "../../src/runtime.ts"
import { Status } from "../../src/status.ts"
import type { Transport } from "../../src/transport.ts"
import { until } from "./common.ts"

const posix = process.platform !== "win32"

/** A Python 3 to run the real scripts with, or none, which skips the tests that need one. */
export const python3 = (() => {
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
export type Flag =
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
 * GeoCode's Python environment as GEE finds it, with the stubbed Python for its base unless the test gives a real one:
 * ready at once, or, given `later`, being installed until it settles.
 */
const environment = (base: string, later?: Promise<void>, version = "3.13.17"): Engine.Capability =>
  Effect.gen(function* () {
    const status = yield* Status.Service
    const ready = { status: "ready", version, python: base, base }
    const writer = yield* status.register<unknown>(
      "python",
      later ? { status: "preparing", step: "installing" } : ready,
    )
    const token = yield* writer.claim()
    if (later) yield* Effect.forkScoped(Effect.promise(() => later).pipe(Effect.andThen(writer.commit(token, ready))))
    return { domain: "python", methods: {} }
  })

/** Raises a flag of the stubbed Python made in `directory` while it is in use. */
export const raise = (directory: string, flag: Flag) => fs.writeFile(path.join(directory, "stubs", "flags", flag), "")

export const lower = (directory: string, flag: Flag) =>
  fs.rm(path.join(directory, "stubs", "flags", flag), { force: true })

type Response = Extract<Protocol.Outbound, { type: "response" }>
type Progress = Extract<Protocol.Outbound, { type: "progress" }>

/** A base environment GeoCode installed, run in place of the stubbed Python. */
interface Base {
  readonly python: string
  readonly version: string
}

/**
 * An engine with GEE configured as `gee` says, in machine.json, and with the stubbed Python behaving as `flags` say,
 * or the real `base`. GeoCode's Python environment is ready at once, or once `later` settles.
 */
export const start = async (gee?: unknown, flags: readonly Flag[] = [], later?: Promise<void>, base?: Base) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-gee-"))
  const machine = path.join(directory, "machine.json")
  if (gee !== undefined) await fs.writeFile(machine, JSON.stringify({ gee }))
  const python = base?.python ?? (await stubbedPython(directory, flags))
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
    Effect.scoped(Engine.run(transport, [environment(python, later, base?.version), Gee.capability])).pipe(
      Effect.provide(layer),
    ),
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

export const result = (response: Response) => {
  assert.ok(response.ok, JSON.stringify(response))
  return response.result as { outcome: string; output: string; truncated: boolean; durationMs: number; exit?: string }
}
