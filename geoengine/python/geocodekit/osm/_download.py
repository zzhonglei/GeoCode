"""The two downloads: OSM objects by id, and the features meeting tag filters in an area. A
download too large for one request is split into parts by counting first, a part that still fails is split again, and
one too large for the public services altogether is refused before anything is downloaded. The parts are counted and
downloaded on every Overpass instance found free at once, one part each at a time."""

import threading
from collections import deque
from datetime import datetime, timezone

from geocodekit.osm import _area, _elements, _filters, _geometry, _http, _lookup, _output, _presets, _records, _steps

# How many features one request asks for at most, and a download at most; deeper than DEPTH, a part is not split.
PART = 50000
LIMIT = 1000000
DEPTH = 6
SECONDS = _http.DOWNLOAD_SECONDS
# Counting is light: an instance silent for longer than this is too busy to download from anyway.
COUNT_SECONDS = 60
# As many as the kernel's osmgetobjects accepts (kernel/packages/core/src/geocode/osmget.ts).
IDS = 25
# The order Overpass gives elements in, which features keep however their parts arrived.
ORDER = {"node": 0, "way": 1, "relation": 2}


class TooMany(Exception):
    def __init__(self, count):
        super().__init__(count)
        self.count = count


def _query(area, alternatives, cell, output, seconds):
    return "[out:json][timeout:%d];%s;%s" % (seconds, area.select(alternatives, cell), output)


def _quarters(box):
    south, west, north, east = box
    middle, centre = (south + north) / 2, (west + east) / 2
    return [
        (south, west, middle, centre),
        (south, centre, middle, east),
        (middle, west, north, centre),
        (middle, centre, north, east),
    ]


def _count(area, alternatives, cell):
    answer = _http.overpass(_query(area, alternatives, cell, "out count;", COUNT_SECONDS), COUNT_SECONDS)
    if answer.get("remark"):
        return None
    return int(answer["elements"][0]["tags"]["total"])


def _shared(tasks, work):
    """Does `work` on each task, and on the tasks it gives back, on as many threads as there are Overpass instances:
    each query goes to whichever instance is free, one query each at a time. The first error stops the rest from
    starting and is raised."""
    queue = deque(tasks)
    running = 0
    failure = None
    turn = threading.Condition()

    def worker():
        nonlocal running, failure
        while True:
            with turn:
                while not queue and running and failure is None:
                    turn.wait()
                if failure is not None or not queue:
                    return
                task = queue.popleft()
                running += 1
            try:
                more = work(task)
            except Exception as error:
                with turn:
                    failure = failure or error
                    running -= 1
                    turn.notify_all()
                return
            with turn:
                queue.extend(more)
                running -= 1
                turn.notify_all()

    for _ in range(len(_http.services["overpass"])):
        threading.Thread(target=worker, daemon=True).start()
    with turn:
        while (queue or running) and failure is None:
            turn.wait()
        if failure is not None:
            raise failure


def plan(area, alternatives):
    """How many features there are, None when a count did not answer, and the parts to download, each a box of the
    area or None for all of it."""
    total = _count(area, alternatives, None)
    if total is not None and total > LIMIT:
        raise TooMany(total)
    if total is not None and total <= PART:
        return total, [None]
    parts = []
    # When the whole area could not be counted, the parts' own counts: at least how many there are, and all of them
    # once every part was counted. A feature crossing a part's edge is counted in each.
    summed = 0
    uncounted = False
    lock = threading.Lock()

    def counted(task):
        nonlocal summed, uncounted
        box, depth = task
        count = _count(area, alternatives, box)
        if count == 0:
            return []
        if count is not None and count <= PART or depth == DEPTH:
            with lock:
                parts.append(box)
                uncounted = uncounted or count is None
                summed += count or 0
                # As the whole area's count would have been, once the parts counted so far are too many.
                if total is None and summed > LIMIT:
                    raise TooMany(summed)
            return []
        return [(quarter, depth + 1) for quarter in _quarters(box)]

    # The whole area is too much for one request, or could not be counted: its quarters are counted next.
    _shared([(quarter, 1) for quarter in _quarters(area.bounds)], counted)
    return (total if total is not None else None if uncounted else summed), sorted(parts)


def _missing(gaps):
    """What is missing, in English, for the answer and the file's description."""
    texts = []
    for gap in gaps:
        if "part" in gap:
            texts.append("the part %s: %s" % (",".join("%.5f" % value for value in gap["part"]), gap["said"]))
        elif "absent" in gap:
            texts.append("OSM has no %s" % ", ".join(gap["absent"]))
        elif "unassembled" in gap:
            texts.append("no geometry could be assembled for %s" % ", ".join(gap["unassembled"]))
        elif "undownloaded" in gap:
            why = (
                "OpenStreetMap's public servers made no progress for %d minutes" % round(gap["seconds"] / 60)
                if gap["code"] == "stalled"
                else "OpenStreetMap's public servers could not be reached, or did not answer"
            )
            texts.append("%s could not be downloaded: %s" % (", ".join(gap["undownloaded"]), why))
        else:
            texts.append(gap["said"])
    return texts


def _download(area, alternatives, parts):
    """The elements of the parts, each once and in Overpass's order, what is missing and the times of their data. A part
    the server stopped early is split again; the tool row is told how many parts are done as each is."""
    found, gaps, stamps = {}, [], []
    lock = threading.Lock()
    # Each part's downloads not yet done, its quarters among them once it is split.
    left = [1] * len(parts)
    done = 0

    def fetched(task):
        nonlocal done
        index, box, depth = task
        try:
            answer = _http.overpass(_query(area, alternatives, box, "out geom;", SECONDS), SECONDS)
            remark = answer.get("remark")
        except _http.TooLarge as error:
            answer, remark = None, str(error)
        more = []
        if remark and depth < DEPTH:
            more = [(index, quarter, depth + 1) for quarter in _quarters(box or area.bounds)]
        with lock:
            if not more and remark:
                gaps.append({"part": [round(value, 5) for value in box or area.bounds], "said": remark})
            if not more and answer is not None:
                stamps.append(answer["osm3s"]["timestamp_osm_base"])
                for element in answer["elements"]:
                    found[(element["type"], element["id"])] = element
            left[index] += len(more) - 1
            if left[index] == 0:
                done += 1
                if done < len(parts):
                    _steps.part(done + 1, len(parts))
        return more

    if len(parts) > 1:
        _steps.part(1, len(parts))
    _shared([(index, box, 0) for index, box in enumerate(parts)], fetched)
    gaps.sort(key=lambda gap: gap["part"])
    elements = [found[key] for key in sorted(found, key=lambda key: (ORDER[key[0]], key[1]))]
    return elements, gaps, stamps


def _features(elements, exact):
    """The elements' features, inside the area's polygon when it has one, and the ids of those with no geometry."""
    inside = None
    if exact is not None:
        from shapely.prepared import prep

        inside = prep(exact)
    features, unassembled = [], []
    for element in elements:
        kind, geometry = _geometry.of(element)
        if kind is None:
            unassembled.append(_elements.ref(element))
            continue
        if inside is not None and not inside.intersects(geometry):
            continue
        features.append(_records.Feature(_elements.ref(element), kind, geometry, element.get("tags") or {}))
    return features, unassembled


def _save(path, features, named, worth, asked, geometry, what, stamps, gaps):
    """Writes the features and says what was written."""
    missing = _missing(gaps)
    extra = ["original_geometry"] if geometry == "point" else []
    chosen, dropped = _records.columns(features, named, worth, asked, extra)
    layers = {}
    for feature in features:
        values = _records.record(feature, chosen, named)
        if geometry == "point":
            values["original_geometry"] = feature.kind
            layers.setdefault("points", []).append((values, _geometry.representative(feature.kind, feature.geometry)))
        else:
            layers.setdefault(_geometry.FAMILIES[feature.kind], []).append((values, feature.geometry))
    timestamp = min(stamps)
    _steps.step("write")
    description = _output.describe(what, timestamp, missing)
    saved, counts = _output.write(path, layers, _records.CORE + extra + chosen, description)
    return {
        "path": saved,
        "layers": counts,
        "timestamp": timestamp,
        "fields": _records.CORE + extra + chosen,
        "dropped": dropped,
        "missing": missing,
        "gaps": gaps,
    }


def objects(request):
    # Each object once, however often it is named.
    refs = list(dict.fromkeys(_elements.parse(text) for text in request["ids"]))
    if not refs:
        raise _elements.Invalid("ids lists no OSM object")
    if len(refs) > IDS:
        raise _elements.Invalid(
            "%d ids is more than %d; for every such feature in an area, download them by area and tags instead"
            % (len(refs), IDS)
        )
    _output.ready(request["output"])
    _steps.step("download")
    # No Overpass instance is free: Nominatim gives what it has, and only the rest waits for one (section 7).
    looked_up = not _http.answering()
    looked = _lookup.objects(refs) if looked_up else {}
    rest = [ref for ref in refs if ref not in looked]
    elements, remark, stamps, unasked = [], None, [], None
    if rest:
        try:
            answer = _http.overpass("[out:json][timeout:%d];%s;out geom;" % (SECONDS, _elements.select(rest)), SECONDS)
            elements, remark = answer["elements"], answer.get("remark")
            stamps.append(answer["osm3s"]["timestamp_osm_base"])
        except (_http.Stalled, _http.Unanswered) as error:
            # Overpass could not be asked, as when every instance kept turning the query away: Nominatim gives what
            # it has, unless it was asked already.
            if not looked_up:
                looked = _lookup.objects(rest)
            if not looked:
                raise
            missed = [_elements.name(ref) for ref in rest if ref not in looked]
            # A call that stopped for no progress says for how long, as the answer and the tool row tell it.
            unasked = (
                {"undownloaded": missed, "code": "stalled", "seconds": _http.stall}
                if isinstance(error, _http.Stalled)
                else {"undownloaded": missed, "code": "unanswered"}
            )
    if looked:
        # Nominatim's data follows OSM's within minutes: when it does not say how old it is, it is as of now.
        stamps.append(_lookup.timestamp() or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    found = {(element["type"], element["id"]) for element in elements}
    # An id missing from an answer the server says it stopped early is not known to be missing from OSM.
    absent = [] if remark or unasked else [_elements.name(ref) for ref in rest if ref not in found]
    _steps.step("assemble")
    features, unassembled = _features(elements, None)
    for ref in refs:
        if ref in looked:
            kind, geometry, tags = looked[ref]
            features.append(_records.Feature(_elements.name(ref), kind, geometry, tags))
    gaps = [{"absent": absent}] if absent else []
    if unassembled:
        gaps.append({"unassembled": unassembled})
    if unasked and unasked["undownloaded"]:
        gaps.append(unasked)
    if remark:
        gaps.append({"said": remark})
    if not features:
        return {"empty": True, "missing": _missing(gaps), "gaps": gaps, "timestamp": min(stamps)}
    what = "the OSM objects %s" % ", ".join(_elements.name(ref) for ref in refs)
    return _save(request["output"], features, [], [], request.get("fields"), "original", what, stamps, gaps)


def features(request):
    alternatives = _filters.parse_all(request["tags"])
    geometry = request.get("geometry", "original")
    _output.ready(request["output"])
    _steps.step("area")
    area = _area.parse(request["area"])
    _steps.step("count")
    try:
        total, parts = plan(area, alternatives)
    except TooMany as many:
        return {"refused": many.count, "limit": LIMIT}
    _steps.counted(total, len(parts))
    _steps.step("download")
    elements, gaps, stamps = _download(area, alternatives, parts)
    _steps.step("assemble")
    features, unassembled = _features(elements, area.exact)
    if unassembled:
        gaps.append({"unassembled": unassembled})
    if not features:
        return {"empty": True, "missing": _missing(gaps), "gaps": gaps, "timestamp": min(stamps) if stamps else None}
    named = _filters.keys(alternatives)
    # The kind the filters name, not what each feature also is: a building that is a restaurant is downloaded as one.
    worth = [key for alternative in alternatives for key in _presets.keys(_filters.exact(alternative) or {})]
    what = "%s in %s" % (", ".join(_filters.text(alternative) for alternative in alternatives), _area.shown(area.text))
    return _save(request["output"], features, named, worth, request.get("fields"), geometry, what, stamps, gaps)
