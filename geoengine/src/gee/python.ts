export * as Python from "./python.ts"

/** Prefixes every structured line: earthengine-api and the script also write to stdout, so only these are parsed. */
export const MARKER = "__GEOCODE_GEE__"

/** Seconds between the reports a run makes while a request waits for Earth Engine. */
export const BEAT_SECONDS = 5

/**
 * The longest one request is reported for, in seconds: Earth Engine ends an interactive computation after about five
 * minutes, so a request still waiting long after that is stuck, and the run's idle limit is left to end it.
 */
export const LONGEST_REQUEST_SECONDS = 10 * 60

/** Run as the user's own Python runs a script: UTF-8 everywhere, and every line written as it is printed. */
export const ENVIRONMENT = { PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" }

/**
 * What the Python reads from standard input, given as `-`: on the command line the program would pass through whatever
 * starts that Python, and Windows's command interpreter rewrites it there. The request, as JSON text in a string, comes
 * first as `REQUEST`; the escapes JSON.stringify writes are all Python's too.
 */
export function program(script: string, request: unknown) {
  return `REQUEST = ${JSON.stringify(JSON.stringify(request))}\n${script}`
}

/** The payloads of the marked lines in the output, in order. */
export function marked(output: string): unknown[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const payload = markedLine(line)
    return payload === undefined ? [] : [payload]
  })
}

/** The payload of one marked line; undefined for any other line. */
export function markedLine(line: string): unknown {
  if (!line.startsWith(MARKER)) return
  try {
    return JSON.parse(line.slice(MARKER.length))
  } catch {
    return
  }
}

// Embedded, since the engine is bundled into one file. String.raw keeps Python's backslashes, so the Python must not
// contain a backtick or "${" of its own.

/**
 * The first lines of both scripts. A program read from standard input has the current folder first on the import path,
 * where a file named like a module the script needs, such as json.py in the session's folder, would be imported instead.
 */
const SAFE_PATH = String.raw`
import sys

sys.path[:] = [entry for entry in sys.path if entry not in ("", ".")]
`

/**
 * Checks, in order, what a run depends on: the packages it is given, then whether the user is signed in, both without
 * the network; then, given a project, whether Google accepts the credentials and Earth Engine answers a minimal
 * computation. The first failure ends the check. Python 2 and the oldest Python 3 still read it, so they fail as a
 * report.
 */
export const CHECK =
  SAFE_PATH +
  String.raw`
import json
import os
import traceback

request = json.loads(REQUEST)
report = {"python": sys.version.split()[0]}


def finish():
    sys.stdout.write("${MARKER}" + json.dumps(report) + "\n")
    sys.stdout.flush()
    sys.exit(0)


def describe(error):
    return "%s: %s" % (type(error).__name__, error)


def fail(step, error, said=None, **facts):
    """Ends the check on the step that failed, with what Google said in its own words when it answered."""
    report["failed"] = step
    report["error"] = describe(error)
    report["traceback"] = traceback.format_exc()
    if said:
        report["said"] = said
    report.update(facts)
    finish()


import importlib
import importlib.util

# Each package on its own, so every missing one is named at once. Found but failing to import means installed but
# broken, which installing it again rarely fixes; a folder an uninstall left behind is found with no origin.
missing = []
broken = []
report["versions"] = {}
for package in request["packages"]:
    spec = importlib.util.find_spec(package["module"])
    if spec is None or spec.origin is None:
        missing.append(package["name"])
        continue
    try:
        module = importlib.import_module(package["module"])
        report["versions"][package["name"]] = str(getattr(module, "__version__", ""))
    except Exception as error:
        broken.append({"package": package["name"], "error": describe(error)})
if broken or missing:
    report.update(failed="broken" if broken else "missing", missing=missing, broken=broken)
    finish()

import socket
import ssl
import urllib.error

import ee
import google.auth.exceptions
import google.auth.transport.requests
import google.oauth2.credentials
import googleapiclient.errors
import requests
from ee import oauth
from google.auth import _cloud_sdk


def stored():
    """The arguments of earthengine-api's own credentials, when they hold a refresh token."""
    try:
        arguments = oauth.get_credentials_arguments()
    except Exception:
        return None
    return arguments if arguments.get("refresh_token") else None


def signed_in():
    """By files alone, where earthengine-api looks: its own credentials, then Google Cloud's default credentials."""
    if stored():
        return True
    named = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if named and os.path.exists(named):
        return True
    try:
        return os.path.exists(_cloud_sdk.get_application_default_credentials_path())
    except Exception:
        return False


if not signed_in():
    report["failed"] = "signed-out"
    finish()

if request.get("project") is None:
    finish()

NETWORK = (
    requests.exceptions.ConnectionError,
    requests.exceptions.Timeout,
    google.auth.exceptions.TransportError,
    urllib.error.URLError,
    socket.gaierror,
    socket.timeout,
    ConnectionError,
    TimeoutError,
    ssl.SSLError,
)


def chain(error):
    while error is not None:
        yield error
        error = error.__cause__ or error.__context__


def refreshing(error):
    """A refused refresh, by Google's own words, and whether trying again may get through."""
    for link in chain(error):
        if isinstance(link, google.auth.exceptions.RefreshError):
            said = link.args[0] if link.args else str(link)
            return {"said": str(said), "retryable": bool(getattr(link, "retryable", False))}


def unreachable(error):
    refused = refreshing(error)
    return any(isinstance(link, NETWORK) for link in chain(error)) or bool(refused and refused["retryable"])


def refusal(error):
    """What Earth Engine's answer says of a refusal: its errors carry the server's answer as their context."""
    for link in chain(error):
        if isinstance(link, googleapiclient.errors.HttpError):
            details = link.error_details if isinstance(link.error_details, list) else []
            reasons = [detail.get("reason") for detail in details if isinstance(detail, dict)]
            return {
                "status": getattr(getattr(link, "resp", None), "status", None),
                "reasons": [reason for reason in reasons if isinstance(reason, str)],
                "said": str(getattr(link, "reason", "") or error),
            }


def classify(error):
    refused = refusal(error)
    if refused is not None:
        fail("rejected", error, said=refused.pop("said"), **refused)
    if unreachable(error):
        fail("unreachable", error)
    sign_in = refreshing(error)
    if sign_in is not None:
        fail("credentials", error, said=sign_in["said"])


# Refreshed here, not left to earthengine-api, which words a refused refresh as if there were no credentials at all.
try:
    arguments = stored()
    if arguments:
        google.oauth2.credentials.Credentials(None, **arguments).refresh(google.auth.transport.requests.Request())
    credentials = ee.data.get_persistent_credentials()
except Exception as error:
    classify(error)
    fail("credentials", error)

try:
    ee.Initialize(credentials, project=request["project"])
    ee.Number(1).getInfo()
except Exception as error:
    classify(error)
    fail("earthengine", error)

finish()
`

/**
 * Initializes Earth Engine with the configured project, then runs GeoAgent's script, inline or from a file, with `ee`
 * at hand. While a request waits for Earth Engine it reports so every few seconds, so a long computation is not taken
 * for a silent script: earthengine-api sends every request through requests' sessions, where the wait is watched.
 */
export const RUN =
  SAFE_PATH +
  String.raw`
import itertools
import json
import linecache
import os
import threading
import time
import traceback
import types

request = json.loads(REQUEST)
# Reentrant: a finalizer or signal handler may print while a write holds it.
lock = threading.RLock()


class Lines:
    """One of the script's output streams, which remembers whether it left a line open, so no report lands inside one."""

    def __init__(self, stream):
        self.stream = stream
        self.open = False

    def write(self, text):
        with lock:
            count = self.stream.write(text)
            if text:
                self.open = not text.endswith("\n")
        return count

    def writelines(self, lines):
        for line in lines:
            self.write(line)

    def __getattr__(self, name):
        return getattr(self.stream, name)


stdout = Lines(sys.stdout)
stderr = Lines(sys.stderr)
sys.stdout = stdout
sys.stderr = stderr


def emit(payload, stream=stdout):
    """A report on the stream, ending first the line the script left open there."""
    with lock:
        if stream.open:
            stream.stream.write("\n")
            stream.open = False
        stream.stream.write("${MARKER}" + json.dumps(payload) + "\n")
        stream.stream.flush()


def heartbeat(payload):
    """A report on a stream with no line open, which it leaves as it was; none while both have one."""
    with lock:
        for stream in (stdout, stderr):
            if not stream.open:
                return emit(payload, stream)


pending = {}
pending_lock = threading.Lock()
tickets = itertools.count()

import requests

send = requests.Session.send


def watched(*arguments, **options):
    ticket = next(tickets)
    with pending_lock:
        pending[ticket] = time.monotonic()
    try:
        return send(*arguments, **options)
    finally:
        with pending_lock:
            pending.pop(ticket, None)


requests.Session.send = watched


def beat():
    while True:
        time.sleep(${BEAT_SECONDS})
        now = time.monotonic()
        with pending_lock:
            waiting = [start for start in pending.values() if now - start < ${LONGEST_REQUEST_SECONDS}]
        if waiting:
            heartbeat({"type": "waiting", "seconds": round(now - min(waiting))})


threading.Thread(target=beat, daemon=True).start()

try:
    import ee

    ee.Initialize(project=request["project"])
except Exception as error:
    emit({"type": "initialize-failed", "error": "%s: %s" % (type(error).__name__, error)})
    sys.exit(1)

# On both streams: each is read on its own, and what either carries from here on is the script's.
emit({"type": "begin"}, stdout)
emit({"type": "begin"}, stderr)

# A module of its own, registered as __main__, as Python runs a script: pickling what it defines needs that. This one
# stays registered too, or its globals could be cleared under the heartbeat.
sys.modules["__geocode_run__"] = sys.modules["__main__"]
main = types.ModuleType("__main__")
main.__dict__["ee"] = ee
sys.modules["__main__"] = main
try:
    if "file" in request:
        name = request["file"]
        main.__file__ = name
        sys.argv = [name]
        # As Python runs a file: its own folder comes first on the import path.
        sys.path.insert(0, os.path.dirname(name))
        with open(name, "rb") as source:
            code = compile(source.read(), name, "exec")
    else:
        name = "<script>"
        sys.argv = [""]
        # As Python runs code it is given: the current folder comes first.
        sys.path.insert(0, "")
        # So a traceback quotes the script's lines, as it does a file's.
        linecache.cache[name] = (len(request["script"]), None, request["script"].splitlines(True), name)
        code = compile(request["script"], name, "exec")
    exec(code, main.__dict__)
except SystemExit as stop:
    emit({"type": "end", "ok": stop.code is None or stop.code == 0})
    raise
except BaseException:
    kind, value, trace = sys.exc_info()
    # From the script's own frame: this one means nothing to its author.
    traceback.print_exception(kind, value, trace.tb_next)
    sys.stderr.flush()
    emit({"type": "end", "ok": False})
    sys.exit(1)

emit({"type": "end", "ok": True})
`
