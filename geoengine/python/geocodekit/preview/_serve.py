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

from geocodekit.preview import _describe, _pyramid, _raster, _source

THREADS = 4
# Of those, the threads that read pages of a layer's table alone: tiles waiting for a layer to be read into memory
# would else hold every thread, and the table needs nothing of it.
TABLE_THREADS = 1
# How often a reader at work says that it is: reading a large layer into memory takes longer in silence than
# GeoEngine leaves a reader that neither is asked nor says anything.
BEAT = 15


class Reader:
    def __init__(self, path, layer, pyramids):
        # `pyramids` is the folder that the overviews made for large rasters are kept in.
        self._path, self._layer, self._pyramids = path, layer, pyramids
        self._lock = threading.Lock()
        # What was last described: the description, the files it was read from and their stamp.
        self._known = None
        # What is worked out once for the data under that stamp: a vector layer's geometry, or what a raster's tiles
        # are read through and how they look.
        self._held = None
        self._loading = threading.Lock()

    def _described(self):
        described, files = _describe.describe(self._path, self._layer)
        described["stamp"] = _source.stamp(files)
        return described, files

    def describe(self, cancelled):
        # Read without the lock, which every tile takes: a GeoJSON is read whole to be described, and the tiles of
        # the data as it was described go on meanwhile.
        known = self._described()
        with self._lock:
            self._known = known
            # Why the data could not be read is asked again with its description, as it may have passed: another
            # program had the file for a moment. Not that a layer is too large, which takes long to come to.
            if self._held is not None and self._held[2] is not None and self._held[2].code != "too-large":
                self._held = None
        described = known[0]
        if "unplaced" in described:
            return described
        # Made ready now, as the first tile would have it anyway: the map is not shown before it can be drawn. Why a
        # layer cannot be read is left for its tiles to say: a description refused for it would leave the file's
        # other layers out of reach as well.
        try:
            if described["kind"] == "raster":
                self._raster(described, cancelled)
            elif "forms" in described:
                described = dict(described, forms=self._vector(described, cancelled).forms)
        except _source.Unshown:
            pass
        return described

    def _current(self, stamp, placed=True):
        """The description, when the data is still what the request was made for and, unless `placed` is False, has a
        place on the map."""
        with self._lock:
            # A reader started for a preview already open has described nothing yet.
            if self._known is None:
                self._known = self._described()
            described, files = self._known
            if _source.stamp(files) != described["stamp"]:
                self._known = self._held = None
                raise _source.Unshown("changed")
        if stamp != described["stamp"]:
            raise _source.Unshown("changed")
        if placed and "unplaced" in described:
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
                with self._lock:
                    # Asked for data that has changed since: what may be held of the data as it now is stays, and the
                    # data is not read for what no longer is.
                    if self._known is None or self._known[0]["stamp"] != stamp:
                        raise _source.Unshown("changed")
                    # What was made of the data before it changed goes first: a large layer would be held twice.
                    self._held = None
                held = None
                try:
                    held = (stamp, make(), None)
                except _source.Unshown as refusal:
                    # Kept without its traceback, which holds what was reading the data: the file open, and all that
                    # was read of it.
                    held = (stamp, None, _source.Unshown(refusal.code, str(refusal)))
                except Exception as error:
                    # Kept as well, every request waiting for it would else read the data again, and as a file that
                    # cannot be read: nothing of the data can be shown.
                    traceback.print_exc()
                    held = (stamp, None, _source.Unshown("unopenable", "%s: %s" % (type(error).__name__, error)))
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

    def _opened(self, described, stand_in):
        """The raster, through its stand-in where it has one that is still there."""
        dataset = stand_in and _pyramid.opened(stand_in)
        dataset = dataset or _source.opened(self._path, gdal.OF_RASTER, described["table"])
        if dataset is None:
            raise _source.Unshown("unopenable", gdal.GetLastErrorMsg())
        return dataset

    def _raster(self, described, cancelled):
        """The stand-in a raster's tiles are read through, None for one read as it is, and how the tiles look."""

        def ready():
            stand_in = _pyramid.stand_in(self._path, described["table"], described["stamp"], self._pyramids)
            return stand_in, _raster.Look(self._opened(described, stand_in))

        return self._once(described["stamp"], ready, cancelled)

    def tile(self, request, cancelled):
        described = self._current(request["stamp"])
        z, x, y = request["z"], request["x"], request["y"]
        if described["kind"] == "raster":
            stand_in, look = self._raster(described, cancelled)
            return _raster.tile(self._opened(described, stand_in), look, z, x, y, cancelled, request.get("look"))
        from geocodekit.preview import _cut

        layer = self._vector(described, cancelled)
        # Of one feature alone, the tile is the mark of the feature that is picked.
        return _cut.tile(layer.only(request["fid"]) if "fid" in request else layer, z, x, y, cancelled)

    def identify(self, request, cancelled):
        """The feature under a click, or the one of the number asked for: where it comes in the layer's table, its
        attributes and where it lies."""
        described = self._current(request["stamp"])
        if described["kind"] != "vector":
            return None
        from geocodekit.preview import _cut, _vector

        layer = self._vector(described, cancelled)
        if "fid" in request:
            fid = request["fid"]
        else:
            # Asked without them, a click looks among all three.
            forms = request.get("forms", ("points", "lines", "polygons"))
            fid = _cut.nearest(layer, request["x"], request["y"], request["tolerance"], forms)
        row = None if fid is None else layer.row(fid)
        if row is None:
            return None
        if layer.attributes is not None:
            found = layer.attributes.of(row)
        else:
            found = _vector.attributes(self._path, described["layer"], fid)
        if found is None:
            return None
        return {"fid": fid, "row": row, "attributes": found, "bounds": layer.only(fid).bounds()}

    def statistics(self, request, cancelled):
        """What is measured of a raster's bands, and what it may be drawn with."""
        described = self._current(request["stamp"])
        if described["kind"] != "raster":
            return None
        stand_in, look = self._raster(described, cancelled)
        return look.statistics(self._opened(described, stand_in))

    def pixel(self, request, cancelled):
        """The raster's pixel under a click."""
        described = self._current(request["stamp"])
        if described["kind"] != "raster":
            return None
        stand_in, _ = self._raster(described, cancelled)
        return _raster.pixel(self._opened(described, stand_in), request["x"], request["y"])

    def rows(self, request):
        """The page of the layer's table that holds the row asked for: where the page begins, and the numbers and the
        attributes of its features. A layer with no place on the map has a table all the same."""
        described = self._current(request["stamp"], placed=False)
        from geocodekit.preview import _vector

        offset = request["row"] - request["row"] % _vector.ROWS
        # From memory where the attributes are kept there, and only once they are: a table does not wait for the
        # layer's geometry, which it shows nothing of.
        held = self._held
        layer = held[1] if held is not None and held[0] == described["stamp"] else None
        if layer is not None and layer.attributes is not None:
            numbers = layer.order[offset : offset + _vector.ROWS].tolist()
            values = layer.attributes.rows(offset, _vector.ROWS)
        else:
            numbers, values = _vector.rows(self._path, described["layer"], offset, _vector.ROWS)
        return {"offset": offset, "fids": numbers, "rows": values}


def main():
    # The answers go out where standard output was, and standard output from here on is standard error: whatever a
    # library prints must not land between the answers.
    answers = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    _source.configure()

    opening = json.loads(sys.stdin.buffer.readline())
    reader = Reader(opening["path"], opening.get("layer"), opening["pyramids"])
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
                write({"id": number, "result": reader.describe(cancelled)})
            elif request["do"] == "tile":
                data = reader.tile(request, cancelled)
                write({"id": number, "result": {"empty": data is None}}, data or b"")
            elif request["do"] == "identify":
                write({"id": number, "result": {"found": reader.identify(request, cancelled)}})
            elif request["do"] == "rows":
                write({"id": number, "result": reader.rows(request)})
            elif request["do"] == "pixel":
                write({"id": number, "result": {"pixel": reader.pixel(request, cancelled)}})
            elif request["do"] == "statistics":
                write({"id": number, "result": {"statistics": reader.statistics(request, cancelled)}})
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
            # For the requests still wanted alone: a reader stuck in what no one waits for any more is let go.
            if asked - unwanted:
                # An answer to no request: GeoEngine asks none by this number.
                write({"id": 0})

    threading.Thread(target=beat, daemon=True).start()
    pool = ThreadPoolExecutor(THREADS)
    table = ThreadPoolExecutor(TABLE_THREADS)
    for line in sys.stdin.buffer:
        request = json.loads(line)
        if "cancel" in request:
            # Only a request still to be answered: the number of one already answered would stay here for good.
            if request["cancel"] in asked:
                unwanted.add(request["cancel"])
            continue
        asked.add(request["id"])
        (table if request["do"] == "rows" else pool).submit(answer, request)
    # GeoEngine has closed the input or is gone; what is still being read is wanted by no one.
    os._exit(0)
