"""Requests to the public services the OSM tools use (docs/OSM.md, section 3), as their usage policies ask: naming
GeoCode, Nominatim at most once a second, and Overpass over its instances in turn, the official ones first. Proxies
are the environment's to set: urllib follows its proxy variables."""

import http.client
import itertools
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from datetime import datetime, timedelta, timezone

from geocodekit import _tool

# Set by the run from its request: who is asking, where each service is, and how long a call may go without progress
# before it stops (docs/OSM.md, section 7).
agent = "GeoCode"
services = {}
stall = 0

# An instance whose data is older than this answers from a stale copy, without saying so.
STALE = timedelta(days=7)
# What one answer may hold once decompressed, counted as it arrives: the instances send no length.
ANSWER_BYTES = 512 * 1024 * 1024
OTHER_BYTES = 16 * 1024 * 1024
# Instances that said they were busy are asked again after a pause, which doubles up to its cap: a busy one is often
# free minutes later, and asking it more often would only add to its load.
ROUND_PAUSE = 5
ROUND_PAUSE_MAX = 30
# How often the bytes received so far are told, at most, in seconds.
RECEIVED_EVERY = 0.5
OTHER_SECONDS = 30
NOMINATIM_GAP = 1.0
# How often a run says it is waiting, while a request is: GeoEngine ends a run silent for long.
BEAT_SECONDS = 10

_sticky = 0
_nominatim_lock = threading.Lock()
_nominatim_at = 0.0
_pending = set()
_pending_lock = threading.Lock()
_tickets = itertools.count()
# When the call last made progress, and the bytes of Overpass's answers: those taken, and the one still arriving.
_progressed = 0.0
_received = 0
_arriving = 0
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
    """Takes who is asking and where the services are from the run's request; and, from the calls before this one,
    how long Nominatim must still wait and which Overpass instance answered last, so a call does not wait out an
    instance those found failing."""
    global agent, services, stall, _nominatim_at, _sticky, _progressed
    agent = request["agent"]
    services = request["services"]
    stall = request["stall"]
    _nominatim_at = time.monotonic() + request["wait"]
    _sticky = request["overpass"] % len(services["overpass"])
    _progressed = time.monotonic()
    threading.Thread(target=_beat, daemon=True).start()


def _beat():
    while True:
        time.sleep(BEAT_SECONDS)
        with _pending_lock:
            waiting = bool(_pending)
        if waiting and _tool.report:
            # How long since the call last made progress, as only this process knows it: an answer it turned down
            # arrived, but is none.
            _tool.report({"type": "waiting", "quiet": round(time.monotonic() - _progressed)})


def progressed():
    """Notes that the call made progress, as a download moving on to its next step or part."""
    global _progressed
    _progressed = time.monotonic()


def _arrived(size):
    global _arriving
    _arriving += size
    progressed()
    _tell_received()


def _settled(taken, before, broken=False):
    """Keeps the bytes of an answer taken. One turned down was no progress, so the clock goes back to before it; one
    broken off as it arrived was, though its bytes are not kept."""
    global _received, _arriving, _progressed
    if taken:
        _received += _arriving
    elif not broken:
        _progressed = before
    if _arriving:
        _arriving = 0
        _tell_received(force=True)


def _tell_received(force=False):
    global _told
    now = time.monotonic()
    if _tool.report and (force or now - _told >= RECEIVED_EVERY):
        _told = now
        _tool.report({"type": "received", "bytes": _received + _arriving})


def _open(url, body, seconds):
    headers = {"User-Agent": agent, "Accept-Encoding": "gzip"}
    if body is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    return urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers), timeout=seconds)


def _read(response, limit, deadline, counted):
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
            break
        if counted:
            # As sent, before it is inflated: what the tool row says has been received.
            _arrived(len(chunk))
        if inflate:
            chunk = inflate.decompress(chunk)
        size += len(chunk)
        if size > limit:
            raise TooLarge("the answer is larger than %d MB" % (limit >> 20))
        parts.append(chunk)
    if inflate:
        parts.append(inflate.flush())
    return b"".join(parts)


def _fetch(url, body, seconds, limit, deadline=None, counted=False):
    ticket = next(_tickets)
    with _pending_lock:
        _pending.add(ticket)
    try:
        with _open(url, body, seconds) as response:
            return _read(response, limit, deadline, counted)
    finally:
        with _pending_lock:
            _pending.discard(ticket)


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


def _passed(endpoint, why):
    """Notes in the run's log why an instance was passed over; GeoAgent is told only the outcome."""
    sys.stderr.write("OSM: passed over %s: %s\n" % (urllib.parse.urlsplit(endpoint).netloc, why))


def _busy(endpoint, why):
    _passed(endpoint, why)
    if _tool.report:
        _tool.report({"type": "busy"})


def overpass(query, seconds, patience=None, tries=None):
    """Overpass's answer to a query, from the first instance with current data, starting from the one that answered
    last. A query written wrong is refused by the first; anything else wrong with an instance passes to the next, and
    those that said they were busy are asked again after a pause. An instance is waited for `patience` seconds when
    given, as for a small query a healthy one answers at once, else for the query's own time limit and a margin.
    Given `tries`, only that many instances are asked, for a query whose answer can be done without; otherwise the
    call goes on until it has made no progress for `stall` seconds."""
    global _sticky
    endpoints = services["overpass"]
    body = urllib.parse.urlencode({"data": query}).encode("utf-8")
    watched = tries is None
    asked = 0
    order = [(_sticky + step) % len(endpoints) for step in range(len(endpoints))]
    pause = ROUND_PAUSE
    again = False
    while order:
        if again:
            time.sleep(min(pause, max(0.0, _progressed + stall - time.monotonic())) if watched else pause)
            pause = min(pause * 2, ROUND_PAUSE_MAX)
        again = True
        busy = []
        for index in order:
            if tries is not None and asked == tries:
                raise Unanswered("no Overpass instance answered")
            asked += 1
            wait = patience or seconds + 30
            if watched:
                left = _progressed + stall - time.monotonic()
                if left <= 0:
                    raise Stalled("no progress for %d seconds" % stall)
                wait = min(wait, left)
            deadline = time.monotonic() + patience if patience else None
            before = _progressed
            try:
                text = _fetch(endpoints[index], body, wait, ANSWER_BYTES, deadline, watched)
            except urllib.error.HTTPError as error:
                if error.code == 400:
                    raise Refused(_said(error.read()))
                # Busy is 429 and 5xx; an instance that answers otherwise, as one that moved, is not asked again.
                if error.code != 429 and error.code < 500:
                    _passed(endpoints[index], "HTTP %d" % error.code)
                    continue
                busy.append(index)
                _busy(endpoints[index], "HTTP %d" % error.code)
                continue
            except TooLarge:
                # Real data that arrived, though too much of it: the caller asks for less.
                _settled(True, before)
                raise
            except (OSError, http.client.HTTPException) as error:
                # An answer broken off as it arrived was progress: its silence was timed from its request.
                _settled(False, before, broken=_arriving > 0)
                _passed(endpoints[index], "%s: %s" % (type(error).__name__, error))
                continue
            try:
                answer = json.loads(text)
            except ValueError:
                _settled(False, before)
                _passed(endpoints[index], "not JSON")
                continue
            base = (answer.get("osm3s") or {}).get("timestamp_osm_base") if isinstance(answer, dict) else None
            if not isinstance(answer, dict) or _stale(base):
                _settled(False, before)
                _passed(endpoints[index], "data as of %s" % base)
                continue
            _settled(True, before)
            if index != _sticky and _tool.report:
                _tool.report({"type": "overpass", "index": index})
            _sticky = index
            return answer
        # Asked again only if it said it was busy: one that kept the request waiting would cost as long again, and one
        # with old data has it still.
        order = busy
    raise Unanswered("no Overpass instance answered")


def get(service, path, params):
    """A JSON answer of Nominatim, Photon or Wikidata; None when there is none, as when it cannot be reached."""
    global _nominatim_at
    url = "%s%s?%s" % (services[service], path, urllib.parse.urlencode(params))
    if service == "nominatim":
        with _nominatim_lock:
            time.sleep(max(0.0, _nominatim_at - time.monotonic()))
            _nominatim_at = time.monotonic() + NOMINATIM_GAP
            # So the next call waits too: GeoEngine runs one search at a time and passes the wait on.
            if _tool.report:
                _tool.report({"type": "nominatim"})
            return _answer(url)
    return _answer(url)


def _answer(url):
    try:
        return json.loads(_fetch(url, None, OTHER_SECONDS, OTHER_BYTES, time.monotonic() + OTHER_SECONDS))
    except (OSError, ValueError, TooLarge, http.client.HTTPException):
        return None
