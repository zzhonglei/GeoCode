export * as Python from "./python.ts"

/** Prefixes every structured line: earthengine-api and the script also write to stdout, so only these are parsed. */
export const MARKER = "__GEOCODE_GEE__"

/**
 * Seconds between the reports a run makes while a request waits for Earth Engine: often enough that the tool row says
 * so within a moment of a wait beginning.
 */
export const BEAT_SECONDS = 1

/**
 * The longest one request is reported for, in seconds: Earth Engine ends an interactive computation after about five
 * minutes, so a request still waiting long after that is stuck, and the run's idle limit is left to end it.
 */
export const LONGEST_REQUEST_SECONDS = 10 * 60

/** Characters kept of a failed script's whole traceback, the end: its report stays one line GeoEngine reads whole. */
const TRACEBACK_CHARS = 16 * 1024

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
// contain a backtick or "${" of its own. Run isolated, a program read from standard input
// does not have the current folder on its import path, where a file such as json.py would shadow a module it needs.

/**
 * The credentials, from earthengine-api's own file alone: Google Cloud's default ones, which
 * earthengine-api would fall back to, may be another account's or lack Earth Engine's scope. Raises without the file.
 */
export const CREDENTIALS = String.raw`
def credentials():
    import google.oauth2.credentials
    from ee import oauth

    return google.oauth2.credentials.Credentials(None, **oauth.get_credentials_arguments())
`

/**
 * Whether an error means Google cannot be reached for now: the network failing anywhere in what led to it, or a refused
 * refresh that Google says may get through when tried again. GEE's check and the quota query read errors the same way.
 */
export const UNREACHABLE = String.raw`
import socket
import ssl
import urllib.error

import google.auth.exceptions
import requests

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
`

/**
 * Checks, in order, what a run depends on: whether the user is signed in, without the network; then, given a project,
 * whether Google accepts the credentials and Earth Engine answers a minimal computation. The first failure ends it.
 */
export const CHECK = String.raw`
import json
import sys
import traceback

request = json.loads(REQUEST)
report = {}


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


import ee
import google.auth.transport.requests
import googleapiclient.errors

${CREDENTIALS}
${UNREACHABLE}

# Signed in when earthengine-api's own file holds a refresh token.
try:
    stored = credentials()
except Exception:
    stored = None
if stored is None or not stored.refresh_token:
    report["failed"] = "signed-out"
    finish()

if request.get("project") is None:
    finish()


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
    stored.refresh(google.auth.transport.requests.Request())
except Exception as error:
    classify(error)
    fail("credentials", error)

try:
    ee.Initialize(stored, project=request["project"])
    ee.Number(1).getInfo()
except Exception as error:
    classify(error)
    fail("earthengine", error)

finish()
`

/**
 * Initializes Earth Engine with the configured project and reads the run's task in GeoCode's folder, then runs
 * GeoAgent's script, inline or from a file, with `ee` at hand and geocodekit.gee set up for it. While a request waits
 * for Earth Engine it reports so, so a long computation is not taken for a silent script:
 * earthengine-api sends every request through requests' sessions, where the wait is watched.
 */
export const RUN = String.raw`
import itertools
import json
import linecache
import os
import sys
import threading
import time
import traceback
import types

request = json.loads(REQUEST)
# Reentrant: a finalizer or signal handler may print while a write holds it.
lock = threading.RLock()
# Where Python and the packages are, before the script adds to the path: a frame there is a library's.
LIBRARIES = {os.path.normcase(os.path.realpath(entry)) for entry in [sys.prefix, sys.base_prefix] + sys.path if entry}


def own(filename):
    """Whether a frame is of the script's own code: the script, or a module of the user's it imports."""
    if filename.startswith("<"):
        # This program's own, and Python's frozen modules, are not.
        return filename == "<script>"
    where = os.path.normcase(os.path.realpath(filename))
    return not any(where == root or where.startswith(root + os.sep) for root in LIBRARIES)


def shown(error):
    """An error as GeoAgent is given it: only the frames of the script's own code, and of the errors it came from only
    those that went through that code. The frames inside the libraries mean nothing to the script's author, and
    earthengine-api raises a request's error while handling the HTTP error, all inside it."""

    def pruned(part, last):
        if part is None:
            return None
        part.stack = traceback.StackSummary.from_list([frame for frame in part.stack if own(frame.filename)])
        part.__cause__ = pruned(part.__cause__, False)
        part.__context__ = pruned(part.__context__, False)
        return part if last or part.stack else None

    return "".join(pruned(traceback.TracebackException.from_exception(error), True).format())


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
        # Not escaped to ASCII, which would make a report of Chinese text six times as long.
        stream.stream.write("${MARKER}" + json.dumps(payload, ensure_ascii=False) + "\n")
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
            heartbeat({"type": "waiting", "seconds": round(now - min(waiting), 1)})


threading.Thread(target=beat, daemon=True).start()

${CREDENTIALS}

try:
    import ee

    ee.Initialize(credentials(), project=request["project"])
except Exception as error:
    emit({"type": "initialize-failed", "error": "%s: %s" % (type(error).__name__, error)})
    sys.exit(1)

# GeoCode's package, installed in the base environment: told that geerun runs the script and where its statuses go,
# before geocodekit.gee, which refuses to load otherwise, is set to the run's task. What that reads of GeoCode's folder
# starts the answer.
try:
    import geocodekit._tool

    geocodekit._tool.name = "geerun"
    geocodekit._tool.report = emit
    import geocodekit.gee._run

    task = request["task"]
    space = geocodekit.gee._run.start(request["project"], request["folder"], task["name"], task["new"], task["started"])
except Exception as error:
    emit({"type": "space-failed", "error": "%s: %s" % (type(error).__name__, error)})
    sys.exit(1)
if "taken" in space:
    emit({"type": "task-taken", "assets": space["taken"], "more": space["more"]})
    sys.exit(1)
if "missing" in space:
    emit({"type": "task-missing", "latest": space["missing"]})
    sys.exit(1)
emit({"type": "space", "space": space})

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
except BaseException as error:
    sys.stderr.write(shown(error))
    sys.stderr.flush()
    # The whole of it, from the script's own frame, for GeoCode's log: a fault of GeoCode's package shows only there.
    whole = "".join(traceback.format_exception(type(error), error, error.__traceback__.tb_next))
    emit({"type": "traceback", "text": whole[-${TRACEBACK_CHARS}:]}, stderr)
    emit({"type": "end", "ok": False})
    sys.exit(1)

emit({"type": "end", "ok": True})
`

/**
 * Signs the user in with earthengine-api's own browser sign-in, on any free port where its default may be taken. The
 * address to open is reported first; the browser comes back to this Python, which saves the credentials where
 * earthengine-api keeps them. Coming back without a code, as when the user denies access, ends the sign-in with its
 * reason and a page saying so, where earthengine-api's own would fail reading a code from standard input and leave the
 * browser without a page; a stray request, as for the page's icon, is answered and the wait goes on.
 */
export const SIGN_IN = String.raw`
import json
import socket
import sys
import traceback
import urllib.parse


def emit(payload):
    sys.stdout.write("${MARKER}" + json.dumps(payload) + "\n")
    sys.stdout.flush()


def fail(error):
    emit({"type": "failed", "error": "%s: %s" % (type(error).__name__, error), "traceback": traceback.format_exc()})
    sys.exit(1)


answer = {}

# All of earthengine-api's flow GeoCode relies on, so a version shaped otherwise fails with what it lacks.
try:
    from ee import oauth

    flow = oauth.Flow("localhost:0")
    server = flow.server.server

    class Answer(server.RequestHandlerClass):
        """earthengine-api's page when the browser brings a code; a page saying the sign-in ended when it brings an error."""

        # A connection sending nothing, as a browser's preconnection, would hold the server, which answers one at a time.
        timeout = 5

        def do_GET(self):
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if "code" in query:
                # Kept first: the browser may be gone before its page is written.
                answer["code"] = query["code"][0]
                super().do_GET()
                return
            if "error" not in query:
                self.send_response(404)
                self.end_headers()
                return
            answer["error"] = query["error"][0]
            self.send_response(200)
            self.send_header("Content-type", "text/plain; charset=utf-8")
            self.end_headers()
            message = "Google Earth Engine sign-in did not complete (%s). You can close this window.\n" % answer["error"]
            self.wfile.write(message.encode("utf-8"))

    server.RequestHandlerClass = Answer

    def fetch_code():
        while not answer:
            server.handle_request()
        server.server_close()
        if "error" in answer:
            emit({"type": "denied", "error": answer["error"]})
            sys.exit(1)
        return answer["code"]

    flow.server.fetch_code = fetch_code
    url = flow.auth_url
except Exception as error:
    fail(error)

emit({"type": "url", "url": url})
# The code is exchanged for credentials with urllib, which would wait for ever on a connection that stalls.
socket.setdefaulttimeout(60)
try:
    flow.save_code()
except Exception as error:
    fail(error)
emit({"type": "signed-in"})
`
