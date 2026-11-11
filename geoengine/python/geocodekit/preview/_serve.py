"""The reader GeoEngine keeps running for one dataset. It reads a request from each line of its standard input and
answers each with a line of JSON, followed by as many bytes as the line's `bytes` says. It holds the file open only
while it reads from it: an open file cannot be replaced on Windows, and GeoAgent may be about to."""

import json
import os
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

from osgeo import gdal

from geocodekit.preview import _describe, _raster, _source

THREADS = 4
# How often a reader at work says that it is: reading a large layer into memory takes longer in silence than
# GeoEngine leaves a reader that neither is asked nor says anything.
BEAT = 15


class Reader:
    def __init__(self, path, layer):
        self._path, self._layer = path, layer
        self._lock = threading.Lock()
        # What was last described: the description, the files it was read from and their stamp.
        self._known = None
        # What is worked out once for the data under that stamp: a vector layer's geometry, a raster's look.
        self._held = None
        self._loading = threading.Lock()

    def _redescribe(self):
        described, files = _describe.describe(self._path, self._layer)
        described["stamp"] = _source.stamp(files)
        self._known = (described, files)
        return described

    def describe(self):
        with self._lock:
            return self._redescribe()

    def _current(self, stamp):
        """The description, when the data is still what the request was made for."""
        with self._lock:
            # A reader started for a preview already open has described nothing yet.
            if self._known is None:
                self._redescribe()
            described, files = self._known
            if _source.stamp(files) != described["stamp"]:
                self._known = self._held = None
                raise _source.Unshown("changed")
        if stamp != described["stamp"]:
            raise _source.Unshown("changed")
        if "unplaced" in described:
            raise _source.Unshown(described["unplaced"])
        return described

    def _once(self, stamp, make, cancelled):
        """What `make` gives, made once for the data under `stamp`; requests that need it meanwhile wait for it. Why
        the data cannot be shown is kept as well: every tile asked of a layer too large would else read it again."""
        with self._loading:
            if cancelled():
                raise _source.Cancelled()
            held = self._held
            if held is None or held[0] != stamp:
                try:
                    held = (stamp, make(), None)
                except _source.Unshown as refusal:
                    held = (stamp, None, refusal)
                with self._lock:
                    if self._known is not None and self._known[0]["stamp"] == stamp:
                        self._held = held
            if held[2] is not None:
                raise _source.Unshown(held[2].code, str(held[2]))
            return held[1]

    def _vector(self, described, cancelled):
        # Imported here, as _cut is: a raster's reader never loads shapely and pyproj.
        from geocodekit.preview import _vector

        # Not ended by the request that happened to start it: the tiles asked for with it wait on the same load.
        return self._once(
            described["stamp"], lambda: _vector.load(self._path, described["layer"], lambda: False), cancelled
        )

    def tile(self, request, cancelled):
        described = self._current(request["stamp"])
        z, x, y = request["z"], request["x"], request["y"]
        if described["kind"] == "raster":
            dataset = _source.opened(self._path, gdal.OF_RASTER, described["table"])
            if dataset is None:
                raise _source.Unshown("unopenable", gdal.GetLastErrorMsg())
            look = self._once(described["stamp"], lambda: _raster.Look(dataset), cancelled)
            return _raster.tile(dataset, look, z, x, y, cancelled)
        from geocodekit.preview import _cut

        return _cut.tile(self._vector(described, cancelled), z, x, y, cancelled)

    def identify(self, request, cancelled):
        described = self._current(request["stamp"])
        if described["kind"] != "vector":
            return None
        from geocodekit.preview import _cut, _vector

        fid = _cut.nearest(self._vector(described, cancelled), request["x"], request["y"], request["tolerance"])
        if fid is None:
            return None
        found = _vector.attributes(self._path, described["layer"], fid)
        return None if found is None else {"fid": fid, "attributes": found}


def main():
    # The answers go out where standard output was, and standard output from here on is standard error: whatever a
    # library prints must not land between the answers.
    answers = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    _source.configure()

    opening = json.loads(sys.stdin.buffer.readline())
    reader = Reader(opening["path"], opening.get("layer"))
    writing = threading.Lock()
    asked = set()
    unwanted = set()

    def write(header, data=b""):
        if data:
            header["bytes"] = len(data)
        with writing:
            # Refused rather than written: a NaN in the line would be no JSON, and the reader would be ended for it.
            answers.write(json.dumps(header, allow_nan=False).encode() + b"\n" + data)
            answers.flush()

    def answer(request):
        number = request["id"]

        def cancelled():
            return number in unwanted

        try:
            if cancelled():
                raise _source.Cancelled()
            if request["do"] == "describe":
                write({"id": number, "result": reader.describe()})
            elif request["do"] == "tile":
                data = reader.tile(request, cancelled)
                write({"id": number, "result": {"empty": data is None}}, data or b"")
            elif request["do"] == "identify":
                write({"id": number, "result": {"found": reader.identify(request, cancelled)}})
            else:
                write({"id": number, "error": {"code": "failed", "message": "no such request: %s" % request["do"]}})
        except _source.Cancelled:
            write({"id": number, "cancelled": True})
        except _source.Unshown as error:
            write({"id": number, "error": {"code": error.code, "message": str(error)}})
        except Exception as error:
            traceback.print_exc()
            write({"id": number, "error": {"code": "failed", "message": "%s: %s" % (type(error).__name__, error)}})
        finally:
            asked.discard(number)
            unwanted.discard(number)

    def beat():
        while True:
            time.sleep(BEAT)
            if asked:
                # An answer to no request: GeoEngine asks none by this number.
                write({"id": 0})

    threading.Thread(target=beat, daemon=True).start()
    pool = ThreadPoolExecutor(THREADS)
    for line in sys.stdin.buffer:
        request = json.loads(line)
        if "cancel" in request:
            # Only a request still to be answered: the number of one already answered would stay here for good.
            if request["cancel"] in asked:
                unwanted.add(request["cancel"])
            continue
        asked.add(request["id"])
        pool.submit(answer, request)
    # GeoEngine has closed the input or is gone; what is still being read is wanted by no one.
    os._exit(0)
