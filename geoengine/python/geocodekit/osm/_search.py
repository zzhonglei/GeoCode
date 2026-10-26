"""Finding OSM objects by name (docs/OSM.md, section 4). Several services are asked at once, each only for the OSM
objects it finds; then every candidate is described alike, ranked, and the best few kept. A service that does not
answer leaves the others' candidates, and the answer says it may be incomplete."""

import difflib
import math
import re
import threading
import unicodedata

from geocodekit.osm import _elements, _filters, _http, _presets
from geocodekit.osm._elements import Invalid

SHOWN = 10
# What each service is asked for, and what Nominatim describes in one request at most.
ASKED = 10
DESCRIBED = 50
SECONDS = 25
# How long an instance has to answer a search's small queries, and how many are asked.
PATIENCE = 15
TRIES = 2
TRANSIT_RAILWAY = ("station", "halt", "tram_stop", "subway_entrance", "platform")
TRANSIT_RELATIONS = ("route", "route_master", "public_transport")
# The parts of an address, most local first, that say which city a place is in.
CITY = ("city", "town", "village", "municipality", "county", "state_district", "state", "province", "region")
NAME_KEYS = re.compile(r"^(name|alt_name|official_name|short_name|old_name|loc_name|int_name)(:.+)?$")
# The letter of each OSM type as the services give it: spelt out, or as the letter itself.
OSM_TYPES = {"node": "N", "way": "W", "relation": "R", "N": "N", "W": "W", "R": "R"}


def _language(text):
    """Which language Wikidata is searched in, by the script of the name: its labels and aliases are by language."""
    for character in text:
        name = unicodedata.name(character, "")
        if name.startswith(("HIRAGANA", "KATAKANA")):
            return "ja"
        if name.startswith("HANGUL"):
            return "ko"
        if name.startswith("CJK"):
            return "zh"
    return "en"


def _plain(text):
    """A name compared without case, full-width forms, spaces or punctuation."""
    text = unicodedata.normalize("NFKC", text).casefold()
    return "".join(character for character in text if unicodedata.category(character)[0] not in "PZ")


def _similarity(wanted, names):
    best = 0.0
    for name in names:
        found = _plain(name)
        if not found or not wanted:
            continue
        if found == wanted:
            return 1.0
        if wanted in found:
            best = max(best, 0.5 + 0.5 * len(wanted) / len(found))
        elif found in wanted:
            best = max(best, 0.5 * len(found) / len(wanted))
        else:
            best = max(best, 0.5 * difflib.SequenceMatcher(None, wanted, found).ratio())
    return best


def _transit(tags):
    """A stop or route named after the place: they outnumber it in a search by its name."""
    return bool(
        tags.get("public_transport")
        or tags.get("highway") == "bus_stop"
        or tags.get("railway") in TRANSIT_RAILWAY
        or tags.get("type") in TRANSIT_RELATIONS
    )


def _bounds(context):
    """The box of the place the context names, as south, west, north and east, or None when nothing is found; and
    whether Nominatim answered at all."""
    parts = [part.strip() for part in context.split(",")]
    if all(_elements.REF.match(part) for part in parts):
        refs = ",".join(_elements.name(_elements.parse(part)) for part in parts)
        hits = _http.get("nominatim", "lookup", {"osm_ids": refs, "format": "jsonv2"})
    else:
        hits = _http.get("nominatim", "search", {"q": context, "format": "jsonv2", "limit": 1})
    if not hits:
        return None, hits is not None
    # Nominatim's box is south, north, west and east.
    boxes = [[float(value) for value in hit["boundingbox"]] for hit in hits]
    bounds = (
        min(box[0] for box in boxes),
        min(box[2] for box in boxes),
        max(box[1] for box in boxes),
        max(box[3] for box in boxes),
    )
    return bounds, True


class Candidates:
    """What the services found, by OSM ref, and whether one of them gave no answer."""

    def __init__(self):
        self.found = {}
        self.tags = {}
        # Wikidata's items for the name, with the names it matched each by: a candidate tagged with one of them, by
        # whichever service found it, was found by Wikidata too.
        self.items = {}
        self.incomplete = False
        self.lock = threading.Lock()

    def add(self, ref, source, importance=None, tags=None, center=None, box=None):
        with self.lock:
            entry = self.found.setdefault(ref, {"sources": set(), "importance": 0.0})
            entry["sources"].add(source)
            if importance:
                entry["importance"] = max(entry["importance"], float(importance))
            if tags is not None:
                self.tags[ref] = {"tags": tags, "center": center, "box": box}

    def failed(self):
        with self.lock:
            self.incomplete = True


def _nominatim(name, bounds, found):
    params = {"q": name, "format": "jsonv2", "limit": ASKED}
    if bounds:
        south, west, north, east = bounds
        params.update({"viewbox": "%f,%f,%f,%f" % (west, north, east, south), "bounded": 1})
    hits = _http.get("nominatim", "search", params)
    if hits is None:
        return found.failed()
    for hit in hits:
        if hit.get("osm_type") in OSM_TYPES:
            found.add("%s%d" % (OSM_TYPES[hit["osm_type"]], hit["osm_id"]), "nominatim", hit.get("importance"))


def _photon(name, bounds, found):
    params = {"q": name, "limit": ASKED}
    if bounds:
        south, west, north, east = bounds
        params["bbox"] = "%f,%f,%f,%f" % (west, south, east, north)
    answer = _http.get("photon", "api/", params)
    if answer is None:
        return found.failed()
    for feature in answer.get("features", []):
        properties = feature.get("properties", {})
        if properties.get("osm_type") in OSM_TYPES:
            found.add("%s%d" % (OSM_TYPES[properties["osm_type"]], properties["osm_id"]), "photon")


def _element_found(found, element, source):
    # Overpass gives a box but no centre with tags alone: the box's middle stands for it.
    box = element.get("bounds")
    if "lat" in element:
        center = {"lat": element["lat"], "lon": element["lon"]}
    elif box:
        center = {"lat": (box["minlat"] + box["maxlat"]) / 2, "lon": (box["minlon"] + box["maxlon"]) / 2}
    else:
        center = None
    found.add(_elements.ref(element), source, tags=element.get("tags") or {}, center=center, box=box)


def _overpass(query):
    """The answer to a query the search can do without, or None: from one of two instances, each given a moment, so
    a search waits little when Overpass is busy."""
    try:
        return _http.overpass(query, PATIENCE, TRIES)
    except (_http.Unanswered, _http.TooLarge):
        return None


def _wikidata(name, found):
    """Wikidata's items for the name, by their labels and aliases, as the OSM objects tagged with them."""
    answer = _http.get(
        "wikidata",
        "w/api.php",
        {
            "action": "wbsearchentities",
            "search": name,
            "language": _language(name),
            "uselang": "en",
            "type": "item",
            "limit": ASKED,
            "format": "json",
        },
    )
    if answer is None:
        return found.failed()
    # The name each item was matched by: a label or alias in another script than OSM's, as simplified Chinese for a
    # place OSM names in traditional, which the comparison of names could not see is the same.
    matched = {
        hit["id"]: [(hit.get("match") or {}).get("text")]
        for hit in answer.get("search", [])
        if re.match(r"^Q\d+$", hit.get("id", ""))
    }
    if not matched:
        return
    with found.lock:
        found.items.update(matched)
    union = "".join('nwr["wikidata"="%s"];' % item for item in matched)
    tagged = _overpass("[out:json][timeout:%d];(%s);out tags bb;" % (SECONDS, union))
    if tagged is None:
        return found.failed()
    for element in tagged["elements"]:
        _element_found(found, element, "wikidata")


def _box(bounds):
    return "(%.7f,%.7f,%.7f,%.7f)" % tuple(bounds)


def _named(name, bounds, found):
    """Objects whose name holds the name, in the context's box: no service matches a name word for word as this.
    Each type has its own cap, relations first: the stops named after a place would spend a shared one."""
    pattern = re.sub(r"([\\.^$|?*+()\[\]{}])", r"\\\1", name)
    # Case folded only for Latin letters: Chinese has no case, and folding costs the server.
    fold = ",i" if re.search(r"[A-Za-z]", name) else ""
    statements = "".join(
        '%s["name"~%s%s]%s;out tags bb %d;' % (kind, _filters.quoted(pattern), fold, _box(bounds), ASKED)
        for kind in ("rel", "way", "node")
    )
    answer = _overpass("[out:json][timeout:%d];%s" % (SECONDS, statements))
    if answer is None:
        return found.failed()
    for element in answer["elements"]:
        _element_found(found, element, "overpass")


def _described(refs):
    """What Nominatim says of each object: its names, main tag, box, centre and address; and whether it answered for
    them all, as an object no other service described is left out."""
    described = {}
    complete = True
    for start in range(0, len(refs), DESCRIBED):
        chunk = refs[start : start + DESCRIBED]
        answer = _http.get(
            "nominatim",
            "lookup",
            {
                "osm_ids": ",".join(chunk),
                "format": "jsonv2",
                "addressdetails": 1,
                "namedetails": 1,
                "extratags": 1,
                "accept-language": "en",
            },
        )
        if answer is None:
            complete = False
        for hit in answer or []:
            if hit.get("osm_type") in OSM_TYPES:
                described["%s%d" % (OSM_TYPES[hit["osm_type"]], hit["osm_id"])] = hit
    return described, complete


def _descriptions(items):
    """Wikidata's one-line English description of each item."""
    found = {}
    for start in range(0, len(items), DESCRIBED):
        answer = _http.get(
            "wikidata",
            "w/api.php",
            {
                "action": "wbgetentities",
                "ids": "|".join(items[start : start + DESCRIBED]),
                "props": "descriptions",
                "languages": "en",
                "format": "json",
            },
        )
        for item, entity in ((answer or {}).get("entities") or {}).items():
            text = ((entity.get("descriptions") or {}).get("en") or {}).get("value")
            if text:
                found[item] = text
    return found


def _location(address):
    """Where an object is, as Nominatim's address has it: its city, its state and its country. The city is the address's
    own, which in mainland China is the district (Hongshan District, not Wuhan)."""
    if not address:
        return None
    city = next((address[part] for part in CITY if address.get(part)), None)
    parts = [city, address.get("state"), address.get("country")]
    # A place with no city below its state names the state once.
    return ", ".join(part for at, part in enumerate(parts) if part and part not in parts[:at]) or None


def _kind(ref, tags):
    if ref.startswith("N"):
        return "point"
    if ref.startswith("R") and tags.get("type") in ("multipolygon", "boundary"):
        return "area"
    return "area" if _presets.is_area(tags) else "line"


def _size(box):
    """How large an object is across and along, in kilometres, from its box."""
    if not box:
        return None
    south, west, north, east = box
    if north == south and east == west:
        return None
    middle = math.radians((south + north) / 2)
    return [round((east - west) * 111.32 * math.cos(middle), 2), round((north - south) * 111.32, 2)]


def _describe(ref, entry, overpass, nominatim, items):
    """A candidate as the answer gives it, from OSM's own tags when Overpass gave them, else from Nominatim."""
    hit = nominatim.get(ref) or {}
    names = dict(hit.get("namedetails") or {})
    if overpass:
        tags = overpass["tags"]
        center = overpass["center"]
        box = overpass["box"]
        box = (box["minlat"], box["minlon"], box["maxlat"], box["maxlon"]) if box else None
    elif hit:
        tags = dict(hit.get("extratags") or {}, **names)
        if hit.get("category") and hit.get("type"):
            tags.setdefault(hit["category"], hit["type"])
        center = {"lat": float(hit["lat"]), "lon": float(hit["lon"])}
        south, north, west, east = (float(value) for value in hit["boundingbox"])
        box = (south, west, north, east)
    else:
        return None
    for key, value in tags.items():
        if NAME_KEYS.match(key):
            names.setdefault(key, value)
    kind = _kind(ref, tags)
    preset = _presets.match(tags, kind)
    sources = set(entry["sources"])
    matched = []
    if tags.get("wikidata") in items:
        sources.add("wikidata")
        matched = [name for name in items[tags["wikidata"]] if name]
    return {
        "id": ref,
        "kind": kind,
        "size": _size(box),
        "preset": preset["name"] if preset else None,
        "category": _presets.category(preset, tags) if preset else None,
        "name": names.get("name"),
        "name_en": names.get("name:en"),
        "location": _location(hit.get("address")),
        "center": [round(center["lat"], 6), round(center["lon"], 6)] if center else None,
        # Ranked after the place it is named after, and shown fainter.
        "transit": _transit(tags),
        "wikidata": tags.get("wikidata"),
        "names": [value for key, value in names.items() if NAME_KEYS.match(key)] + matched,
        "tags": tags,
        "sources": len(sources),
        "importance": entry["importance"],
    }


def _score(candidate, wanted):
    """The name first; then how many services found it, which also covers a name written in other characters than
    the one asked, as traditional and simplified Chinese; then how notable it is and whether it is an area."""
    score = 6 * _similarity(wanted, candidate["names"])
    score += 1.5 * (candidate["sources"] - 1) + 3 * candidate["importance"]
    score += {"area": 1.5, "line": 0.5}.get(candidate["kind"], 0.0)
    if candidate["wikidata"]:
        score += 1
    if _transit(candidate["tags"]):
        score -= 4
    if candidate["kind"] == "point" and candidate["tags"].get("place") in ("locality", "neighbourhood"):
        score -= 1.5
    return score


def _inside(candidate, bounds):
    if bounds is None or candidate["center"] is None:
        return True
    south, west, north, east = bounds
    margin_lat, margin_lon = (north - south) * 0.1, (east - west) * 0.1
    latitude, longitude = candidate["center"]
    return south - margin_lat <= latitude <= north + margin_lat and west - margin_lon <= longitude <= east + margin_lon


def _by_category(alternative, bounds, found):
    """The named objects of a category in the context's box, for when no name matched."""
    statement = 'nwr%s["name"]%s;' % (_filters.clause(alternative), _box(bounds))
    answer = _overpass("[out:json][timeout:%d];%sout tags bb %d;" % (SECONDS, statement, DESCRIBED))
    if answer is None:
        return found.failed()
    for element in answer["elements"]:
        _element_found(found, element, "category")


def search(request):
    name = (request.get("name") or "").strip()
    if not name:
        raise Invalid("name is empty")
    alternative = _filters.parse(request["category"]) if request.get("category") else None
    context = (request.get("context") or "").strip()
    bounds, answered = _bounds(context) if context else (None, True)
    found = Candidates()
    # A place that could not be looked up leaves the search wider, and said to be incomplete, not narrowed to nothing.
    if not answered:
        found.failed()
    lookups = [
        threading.Thread(target=_nominatim, args=(name, bounds, found)),
        threading.Thread(target=_photon, args=(name, bounds, found)),
        threading.Thread(target=_wikidata, args=(name, found)),
    ]
    if bounds:
        lookups.append(threading.Thread(target=_named, args=(name, bounds, found)))
    for lookup in lookups:
        lookup.start()
    for lookup in lookups:
        lookup.join()
    candidates = _ranked(name, found, alternative, bounds)
    incomplete = found.incomplete
    fallback = False
    if not candidates and alternative is not None and bounds is not None:
        listed = Candidates()
        _by_category(alternative, bounds, listed)
        candidates = _ranked(name, listed, None, bounds)
        incomplete = incomplete or listed.incomplete
        fallback = True
    return {
        "name": name,
        "context": context or None,
        "context_found": bounds is not None if context and answered else None,
        "category": request.get("category"),
        "fallback": fallback,
        "candidates": candidates[:SHOWN],
        "total": len(candidates),
        "incomplete": incomplete,
    }


def _ranked(name, found, alternative, bounds):
    refs = list(found.found)
    nominatim, complete = _described(refs)
    if not complete:
        found.failed()
    candidates = [
        candidate
        for candidate in (_describe(ref, found.found[ref], found.tags.get(ref), nominatim, found.items) for ref in refs)
        if candidate is not None and _inside(candidate, bounds)
    ]
    if alternative is not None:
        candidates = [candidate for candidate in candidates if _filters.meets(alternative, candidate["tags"])]
    wanted = _plain(name)
    candidates.sort(key=lambda candidate: -_score(candidate, wanted))
    shown = candidates[:SHOWN]
    descriptions = _descriptions(sorted({candidate["wikidata"] for candidate in shown if candidate["wikidata"]}))
    for candidate in candidates:
        candidate["description"] = descriptions.get(candidate["wikidata"])
        for key in ("names", "tags", "sources", "importance", "wikidata"):
            del candidate[key]
    return candidates
