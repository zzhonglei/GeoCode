"""Requests to the public services the OSM tools use (docs/OSM.md, section 3), as their usage policies ask: naming
GeoCode, Nominatim at most once a second however many of the app's calls ask it, and a look's or a download's query
given to an Overpass instance a probe found free, one query at a time each. Proxies are the environment's to set:
urllib follows its proxy variables."""

import http.client
import itertools
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from datetime import datetime, timedelta, timezone

from geocodekit import _tool

if os.name == "nt":
    import msvcrt
else:
    import fcntl

# Set by the run from its request: who is asking, where each service is, the folder of the app's lock files, how long
# a call may go without progress before it stops (docs/OSM.md, section 7), how long an instance that said it was busy
# is not asked again, and how long a probe is waited for.
agent = "GeoCode"
services = {}
locks = ""
stall = 0
pause = 0
probe_seconds = 0

# An instance whose data is older than this answers from a stale copy, without saying so.
STALE = timedelta(days=7)
# What one answer may hold once decompressed, counted as it arrives: the instances send no length.
ANSWER_BYTES = 512 * 1024 * 1024
OTHER_BYTES = 16 * 1024 * 1024
# A query is waited for this much past its own time limit: a busy server may hold it before it runs.
MARGIN = 30
# The time limit a download's queries declare, the longest of any call's.
DOWNLOAD_SECONDS = 180
# The least an instance can answer, with the time of its data. It declares a download's time limit: an instance takes
# a query or turns it away by the time it declares.
PROBE = "[out:json][timeout:%d];node(1);out ids;" % DOWNLOAD_SECONDS
# What a request that got no answer in time raises: socket.timeout is not yet TimeoutError before Python 3.10.
TIMEOUTS = (TimeoutError, socket.timeout)
# How a request fails, but for an HTTP status: no connection, no answer in time, or an answer broken off or corrupt.
FAILURES = (OSError, http.client.HTTPException, zlib.error)
# The bytes an answer holds once it is arriving: while an instance works on a query it sends nothing, or only the
# head of its answer, and then the rest at once (docs/OSM.md, section 9).
ARRIVING_BYTES = 64 * 1024
# How often the bytes received so far are told, at most, in seconds.
RECEIVED_EVERY = 0.5
OTHER_SECONDS = 30
NOMINATIM_GAP = 1.0
# The lock file, among the app's, holding when any of its calls last asked Nominatim.
NOMINATIM_FILE = "osm-nominatim"
# How often a run says it is waiting, while a request is: GeoEngine ends a run silent for long.
BEAT_SECONDS = 10

# The instances as this call knows them: free, in the order their probes answered, the one that last answered a query
# first; being asked a query; being probed; not to be asked until a time; and not to be asked again.
_instances = threading.Condition()
_free = []
_asking = set()
_probing = set()
_paused = {}
_dropped = set()
_sticky = 0
# Whether every instance the call may ask was last found busy, no query having been asked since; and what the row was
# last told the call waits on.
_all_busy = False
_state_told = None

_nominatim_lock = threading.Lock()
_nominatim_at = 0.0
_pending = set()
_pending_lock = threading.Lock()
_tickets = itertools.count()
# When the call last made progress other than by an answer still arriving; each answer arriving, by its ticket, with
# its bytes so far and when the last of them came; and the bytes of the answers taken.
_progress_lock = threading.Lock()
_steady = 0.0
_arriving = {}
_received = 0
_told = 0.0


class Refused(Exception):
    """A query Overpass would not run, as one written wrong, with its own words."""


class TooLarge(Exception):
    """An answer past what one may hold: only asking for less can help."""


class Unanswered(Exception):
    """No instance gave a current answer."""


class Stalled(Exception):
    """The call made no progress for as long as it may."""


def start(request):
    """Takes who is asking, where the services and lock files are and how long to wait from the run's request; and,
    from the calls before this one, which Overpass instance answered last, where a search starts, and for how long
    each instance found busy is still not to be asked."""
    global agent, services, locks, stall, pause, probe_seconds, _sticky, _steady
    agent = request["agent"]
    services = request["services"]
    locks = request["locks"]
    stall = request["stall"]
    pause = request["pause"]
    probe_seconds = request["probe"]
    _sticky = request["overpass"] % len(services["overpass"])
    _steady = time.monotonic()
    for index, left in enumerate(request["paused"]):
        if left > 0:
            _paused[index] = _steady + left
    threading.Thread(target=_beat, daemon=True).start()


def _beat():
    while True:
        time.sleep(BEAT_SECONDS)
        with _pending_lock:
            waiting = bool(_pending)
        if waiting and _tool.report:
            # How long since the call last made progress, as only this process knows it: an answer it turned down
            # arrived, but is none.
            _tool.report({"type": "waiting", "quiet": round(time.monotonic() - _progressed())})


def _progressed():
    """When the call last made progress: an answer arriving makes it as its bytes come."""
    with _progress_lock:
        return max([_steady] + [when for _size, when in _arriving.values()])


def progressed():
    """Notes that the call made progress, as a download moving on to its next step or part."""
    global _steady
    with _progress_lock:
        _steady = time.monotonic()


def _arrived(ticket, size):
    with _progress_lock:
        entry = _arriving.setdefault(ticket, [0, 0.0])
        began = entry[0] < ARRIVING_BYTES <= entry[0] + size
        entry[0] += size
        entry[1] = time.monotonic()
    # As the answer begins to arrive, the row is told its bytes along with it.
    _tell_received(force=began)
    _tell_state()


def _settled(ticket, kept, progress):
    """Ends an answer's arriving: its bytes are kept when it was taken, and its arriving stays progress unless it was
    turned down. One broken off as it arrived was progress, though its bytes are not kept. The instance's release,
    which follows, tells the row what the call then waits on."""
    global _received, _steady
    with _progress_lock:
        size, when = _arriving.pop(ticket, (0, 0.0))
        if kept:
            _received += size
        if progress:
            _steady = max(_steady, when)
    if size:
        _tell_received(force=True)


def _tell_received(force=False):
    global _told
    with _progress_lock:
        now = time.monotonic()
        if not _tool.report or not force and now - _told < RECEIVED_EVERY:
            return
        _told = now
        # Told under the lock, so that a thread's count is never told after a newer one.
        _tool.report({"type": "received", "bytes": _received + sum(size for size, _when in _arriving.values())})


def _tell_state():
    """Tells the row what the call waits on, when that changes: whether a query is out, whether an answer to one has
    begun to arrive, and whether every instance it may ask is busy (docs/OSM.md, section 9). Told under the lock, so
    that a thread's state is never told after a newer one."""
    global _state_told
    with _instances:
        with _progress_lock:
            arriving = any(size >= ARRIVING_BYTES for size, _when in _arriving.values())
        state = {"asking": bool(_asking), "arriving": arriving, "busy": _all_busy}
        if state != _state_told:
            _state_told = state
            if _tool.report:
                _tool.report(dict(type="server", **state))


def _open(url, body, seconds):
    headers = {"User-Agent": agent, "Accept-Encoding": "gzip"}
    if body is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    return urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers), timeout=seconds)


def _read(response, limit, deadline, ticket):
    inflate = zlib.decompressobj(16 + zlib.MAX_WBITS) if response.headers.get("Content-Encoding") == "gzip" else None
    parts = []
    size = 0
    while True:
        # Socket timeouts count silence only: a server trickling its answer would otherwise never be given up on.
        if deadline is not None and time.monotonic() > deadline:
            raise TimeoutError("the answer took too long")
        # What has arrived, up to a block: read() would wait for the whole block, so an answer arriving slowly, or
        # broken off, would be seen only at its end.
        chunk = response.read1(1 << 16 if deadline is not None else 1 << 20)
        if not chunk:
            if inflate and not inflate.eof:
                raise http.client.IncompleteRead(b"")
            break
        if ticket is not None:
            # As sent, before it is inflated: what the tool row says has been received.
            _arrived(ticket, len(chunk))
        if inflate:
            chunk = inflate.decompress(chunk)
        size += len(chunk)
        if size > limit:
            raise TooLarge("the answer is larger than %d MB" % (limit >> 20))
        parts.append(chunk)
    if inflate:
        parts.append(inflate.flush())
    return b"".join(parts)


def _fetch(url, body, seconds, limit, deadline=None, ticket=None):
    """An answer's bytes; given a ticket, they are counted as they arrive, as progress and on the tool row."""
    waiting = next(_tickets)
    with _pending_lock:
        _pending.add(waiting)
    try:
        with _open(url, body, seconds) as response:
            return _read(response, limit, deadline, ticket)
    finally:
        with _pending_lock:
            _pending.discard(waiting)


def _said(page):
    """What Overpass's error page says, without its markup."""
    text = re.sub(r"<[^>]+>", "", page.decode("utf-8", "replace"))
    lines = [line.strip() for line in text.splitlines() if "rror" in line]
    return "\n".join(lines) or text.strip()[:500]


def _stale(base):
    try:
        then = datetime.strptime(base, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return False
    return datetime.now(timezone.utc) - then > STALE


def _current(text):
    """Overpass's answer in a page, or why it is none: not JSON, not an answer with elements and the time of its data,
    or from data older than STALE."""
    try:
        answer = json.loads(text)
    except ValueError:
        return None, "not JSON"
    meta = answer.get("osm3s") if isinstance(answer, dict) else None
    base = meta.get("timestamp_osm_base") if isinstance(meta, dict) else None
    if not isinstance(base, str) or not isinstance(answer.get("elements"), list):
        return None, "not an answer"
    if _stale(base):
        return None, "data as of %s" % base
    return answer, None


def _busy_status(code):
    """Busy is 429 and 5xx; an instance that answers otherwise, as one that moved, is not asked again."""
    return code == 429 or code >= 500


def _silent(error):
    """Whether a request failed for an answer that did not come in time."""
    return isinstance(error, TIMEOUTS) or isinstance(getattr(error, "reason", None), TIMEOUTS)


def _unreachable(error):
    """Whether a request failed before it was answered at all, for want of a connection."""
    return isinstance(error, urllib.error.URLError) and not _silent(error)


def _passed(endpoint, why):
    """Notes in the run's log why an instance was passed over; GeoAgent is told only the outcome."""
    sys.stderr.write("OSM: passed over %s: %s\n" % (urllib.parse.urlsplit(endpoint).netloc, why))


def _answered(index):
    """Notes the instance that answered, which the next search starts from: GeoEngine keeps it between calls."""
    global _sticky
    if index != _sticky and _tool.report:
        _tool.report({"type": "overpass", "index": index})
    _sticky = index


def _body(query):
    return urllib.parse.urlencode({"data": query}).encode("utf-8")


def _put(index, verdict):
    """Notes what an instance was found to be, under the lock: free, busy for a while, or not to be asked again. A
    pause is told to GeoEngine, which keeps it for the calls after this one: the official instance's policy asks for
    30 seconds before a new request, from this computer, whichever call makes it."""
    if verdict == "free":
        _free.insert(0, index)
    elif verdict == "busy":
        _paused[index] = time.monotonic() + pause
        if _tool.report:
            _tool.report({"type": "paused", "index": index, "seconds": pause})
    else:
        _dropped.add(index)
    _instances.notify_all()


def _probe(index):
    endpoint = services["overpass"][index]
    why = None
    try:
        text = _fetch(endpoint, _body(PROBE), probe_seconds, OTHER_BYTES, time.monotonic() + probe_seconds)
        answer, why = _current(text)
        verdict = "free" if answer is not None else "dropped"
    except urllib.error.HTTPError as error:
        why = "HTTP %d" % error.code
        verdict = "busy" if _busy_status(error.code) else "dropped"
    except FAILURES + (TooLarge,) as error:
        why = "%s: %s" % (type(error).__name__, error)
        # One that cannot be reached will not be soon; one that did not answer in time, or broke off, may be.
        verdict = "dropped" if _unreachable(error) else "busy"
    with _instances:
        _probing.discard(index)
        # Free instances go last, after those that answered first.
        if verdict == "free":
            _free.append(index)
            _instances.notify_all()
        else:
            _put(index, verdict)
    if why:
        _passed(endpoint, why)


def _probe_others(now):
    """Probes, all at once, the instances not known to be free and not paused or dropped; under the lock."""
    for index in range(len(services["overpass"])):
        known = index in _free or index in _asking or index in _probing or index in _dropped
        if not known and _paused.get(index, 0) <= now:
            _probing.add(index)
            threading.Thread(target=_probe, args=(index,), daemon=True).start()


def warm():
    """Starts probing the Overpass instances, so a call finds out which is free while it does other things."""
    with _instances:
        _probe_others(time.monotonic())


def answering():
    """Whether an Overpass instance is free, before the call asks any, waiting for the probes until one is or all have
    answered."""
    with _instances:
        _probe_others(time.monotonic())
        while not _free and _probing:
            _instances.wait()
        return bool(_free)


def _lease():
    """An instance free to be asked a query, the one that last answered a query first, else the first whose probe
    answered. While each is asked, probed or paused, those that may be are probed and the call waits, until it has made
    no progress for as long as it may; with none asked or probed, every instance it may ask is busy."""
    global _all_busy
    with _instances:
        while True:
            now = time.monotonic()
            left = _progressed() + stall - now
            if left <= 0 or len(_dropped) == len(services["overpass"]):
                # The call asks Overpass no more, as when a download by id goes on with what Nominatim has: it waits
                # on no busy instance.
                _all_busy = False
                _tell_state()
                if left <= 0:
                    raise Stalled("no progress for %d seconds" % stall)
                raise Unanswered("no Overpass instance answered")
            if _free:
                index = _free.pop(0)
                _asking.add(index)
                _all_busy = False
                break
            _probe_others(now)
            if not _asking and not _probing and not _all_busy:
                _all_busy = True
                _tell_state()
            resumes = [until - now for until in _paused.values() if until > now]
            _instances.wait(min([left] + resumes))
    _tell_state()
    return index


def _release(index, verdict):
    with _instances:
        _asking.discard(index)
        _put(index, verdict)
    _tell_state()


def overpass(query, seconds, tries=None):
    """Overpass's answer to a query. Given `tries`, as for a query whose answer can be done without, at most that many
    instances not paused are asked in turn, from the one that answered last, each waited for `seconds`. Otherwise the
    query goes to an instance a probe found free and is waited for its time limit and a margin; one that fails it, but
    for a query written wrong, passes it to another, until the call has made no progress for `stall` seconds."""
    if tries is not None:
        return _in_turn(query, seconds, tries)
    body = _body(query)
    while True:
        index = _lease()
        endpoint = services["overpass"][index]
        whole = seconds + MARGIN
        wait = max(0.1, min(whole, _progressed() + stall - time.monotonic()))
        ticket = next(_tickets)
        try:
            text = _fetch(endpoint, body, wait, ANSWER_BYTES, None, ticket)
        except urllib.error.HTTPError as error:
            _settled(ticket, False, False)
            if error.code == 400:
                _release(index, "free")
                raise Refused(_said(error.read()))
            _release(index, "busy" if _busy_status(error.code) else "dropped")
            _passed(endpoint, "HTTP %d" % error.code)
            continue
        except TooLarge:
            # Real data that arrived, though too much of it: the caller asks for less.
            _settled(ticket, True, True)
            _release(index, "free")
            raise
        except FAILURES as error:
            # An answer broken off as it arrived was progress: its silence was timed from its request. One that kept
            # the query waiting its whole time would keep it as long again, and one that cannot be reached will not
            # be soon; one waited for less, as the call had less left, or that broke off, may answer later.
            _settled(ticket, False, True)
            waited_out = _silent(error) and wait >= whole
            _release(index, "dropped" if waited_out or _unreachable(error) else "busy")
            _passed(endpoint, "%s: %s" % (type(error).__name__, error))
            continue
        answer, why = _current(text)
        if answer is None:
            _settled(ticket, False, False)
            _release(index, "dropped")
            _passed(endpoint, why)
            continue
        _settled(ticket, True, True)
        _release(index, "free")
        _answered(index)
        return answer


def _in_turn(query, seconds, tries):
    """Asks, in turn from the one that answered last, at most `tries` instances not paused; one that says it is busy is
    paused, as in a look."""
    endpoints = services["overpass"]
    body = _body(query)
    order = [(_sticky + step) % len(endpoints) for step in range(len(endpoints))]
    with _instances:
        now = time.monotonic()
        asked = [index for index in order if _paused.get(index, 0) <= now][:tries]
    for index in asked:
        try:
            text = _fetch(endpoints[index], body, seconds, ANSWER_BYTES, time.monotonic() + seconds)
        except urllib.error.HTTPError as error:
            if error.code == 400:
                raise Refused(_said(error.read()))
            if _busy_status(error.code):
                with _instances:
                    _put(index, "busy")
            _passed(endpoints[index], "HTTP %d" % error.code)
            continue
        except FAILURES as error:
            _passed(endpoints[index], "%s: %s" % (type(error).__name__, error))
            continue
        answer, why = _current(text)
        if answer is None:
            _passed(endpoints[index], why)
            continue
        _answered(index)
        return answer
    raise Unanswered("no Overpass instance answered")


def _lock(handle):
    if os.name == "nt":
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
    else:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)


def _unlock(handle):
    if os.name == "nt":
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _nominatim_turn():
    """Waits until a second has passed since any of the app's calls last asked Nominatim, and notes this request, in
    the lock file they share; a search, a look and a download may run at once. A file that cannot be used leaves only
    this call's own requests apart."""
    global _nominatim_at
    time.sleep(max(0.0, _nominatim_at - time.monotonic()))
    try:
        os.makedirs(locks, exist_ok=True)
        descriptor = os.open(os.path.join(locks, NOMINATIM_FILE), os.O_RDWR | os.O_CREAT, 0o644)
        with os.fdopen(descriptor, "r+b") as handle:
            _lock(handle)
            try:
                handle.seek(0)
                try:
                    last = float(handle.read() or 0)
                except ValueError:
                    last = 0.0
                # Wall time, which every process shares; a clock set back waits a second at most.
                time.sleep(min(NOMINATIM_GAP, max(0.0, last + NOMINATIM_GAP - time.time())))
                handle.seek(0)
                handle.truncate()
                handle.write(repr(time.time()).encode("ascii"))
                handle.flush()
            finally:
                _unlock(handle)
    except OSError as error:
        sys.stderr.write("OSM: Nominatim's lock file is not used: %s\n" % error)
    _nominatim_at = time.monotonic() + NOMINATIM_GAP


def get(service, path, params):
    """A JSON answer of Nominatim, Photon or Wikidata; None when there is none, as when it cannot be reached."""
    url = "%s%s?%s" % (services[service], path, urllib.parse.urlencode(params))
    if service == "nominatim":
        with _nominatim_lock:
            _nominatim_turn()
            return _answer(url)
    return _answer(url)


def _answer(url):
    try:
        return json.loads(_fetch(url, None, OTHER_SECONDS, OTHER_BYTES, time.monotonic() + OTHER_SECONDS))
    except FAILURES + (ValueError, TooLarge):
        return None
