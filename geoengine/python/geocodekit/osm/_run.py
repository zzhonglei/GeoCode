"""What GeoEngine runs for an OSM tool: one call, its request JSON text, answered with lines
on standard output that start with the marker the request names. A request written wrong, one no service would
answer, one that made no progress for too long, an answer too large to take and a folder no file can be written in
end with a failure saying so; anything else unexpected ends with Python's traceback."""

import json
import sys
import threading

from geocodekit import _tool
from geocodekit.osm import _http, _output
from geocodekit.osm._elements import Invalid

_lock = threading.Lock()


def _action(name):
    # Imported once chosen: a search loads no geometry library.
    if name == "search":
        from geocodekit.osm._search import search

        return search
    if name == "probe":
        from geocodekit.osm._probe import probe

        return probe
    from geocodekit.osm import _download

    return {"objects": _download.objects, "features": _download.features}[name]


def main(text):
    request = json.loads(text)
    marker = request["marker"]

    def emit(payload):
        with _lock:
            sys.stdout.write(marker + json.dumps(payload, ensure_ascii=False) + "\n")
            sys.stdout.flush()

    _tool.name = request["tool"]
    _tool.report = emit
    _http.start(request)
    try:
        result = _action(request["action"])(request)
    except Invalid as error:
        return emit({"type": "failure", "code": "invalid", "message": str(error)})
    except _http.Refused as error:
        return emit({"type": "failure", "code": "refused", "message": str(error)})
    except _http.Unanswered as error:
        return emit({"type": "failure", "code": "unanswered", "message": str(error)})
    except _http.Stalled as error:
        return emit({"type": "failure", "code": "stalled", "message": str(error), "seconds": _http.stall})
    except _http.TooLarge as error:
        return emit({"type": "failure", "code": "too-large", "message": str(error)})
    except _output.Unwritable as error:
        return emit({"type": "failure", "code": "unwritable", "message": str(error)})
    emit({"type": "result", "result": result})
