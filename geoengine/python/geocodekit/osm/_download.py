"""The two downloads (docs/OSM.md, section 7): OSM objects by id, and the features meeting tag filters in an area. A
download too large for one request is split into parts by counting first, a part that still fails is split again, and
one too large for the public services altogether is refused before anything is downloaded."""

from geocodekit.osm import _area, _elements, _filters, _geometry, _http, _output, _presets, _records, _steps

# How many features one request asks for at most, and a download at most; deeper than DEPTH, a part is not split.
PART = 50000
LIMIT = 1000000
DEPTH = 6
SECONDS = 180
# Counting is light: an instance silent for longer than this is too busy to download from anyway.
COUNT_SECONDS = 60
IDS = 25


class TooMany(Exception):
    def __init__(self, count):
        super().__init__(count)
        self.count = count


def _query(area, alternatives, cell, output, seconds):
    return "[out:json][timeout:%d];%s;%s" % (seconds, area.select(alternatives, cell), output)


def _quarters(box):
    south, west, north, east = box
    middle, centre = (south + north) / 2, (west + east) / 2
    return [(south, west, middle, centre), (south, centre, middle, east), (middle, west, north, centre),
            (middle, centre, north, east)]


def _count(area, alternatives, cell):
    answer = _http.overpass(_query(area, alternatives, cell, "out count;", COUNT_SECONDS), COUNT_SECONDS)
    if answer.get("remark"):
        return None
    return int(answer["elements"][0]["tags"]["total"])


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
    # The whole area is too much for one request, or could not be counted: its quarters are counted next.
    boxes = [(quarter, 1) for quarter in _quarters(area.bounds)]
    while boxes:
        box, depth = boxes.pop()
        count = _count(area, alternatives, box)
        if count == 0:
            continue
        if count is not None and count <= PART or depth == DEPTH:
            parts.append(box)
            uncounted = uncounted or count is None
            summed += count or 0
            # As the whole area's count would have been, once the parts counted so far are too many.
            if total is None and summed > LIMIT:
                raise TooMany(summed)
        else:
            boxes.extend((quarter, depth + 1) for quarter in _quarters(box))
    return (total if total is not None else None if uncounted else summed), parts


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
        else:
            texts.append(gap["said"])
    return texts


def _fetch(area, alternatives, box, depth, found, gaps, stamps):
    try:
        answer = _http.overpass(_query(area, alternatives, box, "out geom;", SECONDS), SECONDS)
        remark = answer.get("remark")
    except _http.TooLarge as error:
        answer, remark = None, str(error)
    if remark and depth < DEPTH:
        whole = box or area.bounds
        for quarter in _quarters(whole):
            _fetch(area, alternatives, quarter, depth + 1, found, gaps, stamps)
        return
    if remark:
        gaps.append({"part": [round(value, 5) for value in box or area.bounds], "said": remark})
    if answer is not None:
        stamps.append(answer["osm3s"]["timestamp_osm_base"])
        for element in answer["elements"]:
            found[(element["type"], element["id"])] = element


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
    refs = [_elements.parse(text) for text in request["ids"]]
    if not refs:
        raise _elements.Invalid("ids lists no OSM object")
    if len(refs) > IDS:
        raise _elements.Invalid(
            "%d ids is more than %d; for every such feature in an area, download them by area and tags instead"
            % (len(refs), IDS)
        )
    _output.ready(request["output"])
    _steps.step("download")
    answer = _http.overpass("[out:json][timeout:%d];%s;out geom;" % (SECONDS, _elements.select(refs)), SECONDS)
    found = {(element["type"], element["id"]) for element in answer["elements"]}
    # An id missing from an answer the server says it stopped early is not known to be missing from OSM.
    absent = [] if answer.get("remark") else [
        "%s%d" % (_elements.LETTERS[kind], number) for kind, number in refs if (kind, number) not in found
    ]
    _steps.step("assemble")
    features, unassembled = _features(answer["elements"], None)
    gaps = [{"absent": absent}] if absent else []
    if unassembled:
        gaps.append({"unassembled": unassembled})
    if answer.get("remark"):
        gaps.append({"said": answer["remark"]})
    if not features:
        return {
            "empty": True,
            "missing": _missing(gaps),
            "gaps": gaps,
            "timestamp": answer["osm3s"]["timestamp_osm_base"],
        }
    what = "the OSM objects %s" % ", ".join(request["ids"])
    stamps = [answer["osm3s"]["timestamp_osm_base"]]
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
    found, gaps, stamps = {}, [], []
    _steps.step("download")
    for index, box in enumerate(parts):
        if len(parts) > 1:
            _steps.part(index + 1, len(parts))
        _fetch(area, alternatives, box, 0, found, gaps, stamps)
    _steps.step("assemble")
    features, unassembled = _features(found.values(), area.exact)
    if unassembled:
        gaps.append({"unassembled": unassembled})
    if not features:
        return {"empty": True, "missing": _missing(gaps), "gaps": gaps, "timestamp": min(stamps) if stamps else None}
    named = _filters.keys(alternatives)
    # The kind the filters name, not what each feature also is: a building that is a restaurant is downloaded as one.
    worth = [key for alternative in alternatives for key in _presets.keys(_filters.exact(alternative) or {})]
    what = "%s in %s" % (", ".join(_filters.text(alternative) for alternative in alternatives), _area.shown(area.text))
    return _save(request["output"], features, named, worth, request.get("fields"), geometry, what, stamps, gaps)
