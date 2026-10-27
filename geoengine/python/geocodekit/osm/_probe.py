"""Looking at what an area holds before downloading (docs/OSM.md, section 6): the tags an English word names and how
many of each, how many features tag filters meet, or which values some keys take."""

from collections import Counter

from geocodekit.osm import _area, _filters, _http, _presets
from geocodekit.osm._elements import Invalid

SECONDS = 120
PRESETS = 6
KEYS = 5
VALUES = 30
# Features whose tags a look at keys reads at most; past it, the values shown are of a sample.
SAMPLE = 100000


def _alternative(tags):
    return tuple((key, None, None) if value == "*" else (key, "=", value) for key, value in tags.items())


def _counted(area, alternatives):
    """How many features meet each alternative, then all of them together, by element type. A server that stopped
    early answers only the counts it got to, in order."""
    statements = "".join("%s;out count;" % area.select([alternative]) for alternative in alternatives)
    if len(alternatives) > 1:
        statements += "%s;out count;" % area.select(alternatives)
    answer = _http.overpass("[out:json][timeout:%d];%s" % (SECONDS, statements), SECONDS)
    counts = [
        {kind: int(element["tags"][kind]) for kind in ("nodes", "ways", "relations", "total")}
        for element in answer["elements"]
    ]
    return counts, answer


def _rows(term):
    """The tags to count for a word: each preset's own, the tags its new features get besides, and the deprecated
    tags that mean the same."""
    rows = []
    seen = set()
    for preset in _presets.search(term, PRESETS):
        own = dict(preset["tags"])
        found = [(own, "preset")]
        extra = {key: value for key, value in (preset.get("addTags") or {}).items() if key not in own}
        found.extend(({key: value}, "added") for key, value in extra.items())
        found.extend((old, "deprecated") for old in _presets.deprecated(dict(own, **extra)))
        for tags, why in found:
            alternative = _alternative(tags)
            written = _filters.text(alternative)
            if written in seen:
                continue
            seen.add(written)
            rows.append({"filter": written, "alternative": alternative, "preset": preset["name"], "why": why})
    return rows


def probe(request):
    asked = [name for name in ("term", "tags", "keys") if request.get(name)]
    if len(asked) != 1:
        raise Invalid("give exactly one of term, tags and keys")
    area = _area.parse(request["area"])
    # Those the server stopped before counting are named apart: not counted is not that none are there.
    if asked == ["term"]:
        rows = _rows(request["term"])
        if not rows:
            return {"area": area.text, "term": request["term"], "rows": [], "uncounted": []}
        counts, answer = _counted(area, [row["alternative"] for row in rows])
        uncounted = [row["filter"] for row in rows[len(counts) :]]
        rows = rows[: len(counts)]
        for row, count in zip(rows, counts):
            del row["alternative"]
            row.update(count)
        return {
            "area": area.text,
            "term": request["term"],
            "rows": rows,
            "uncounted": uncounted,
            "remark": answer.get("remark"),
        }
    if asked == ["tags"]:
        alternatives = _filters.parse_all(request["tags"])
        counts, answer = _counted(area, alternatives)
        rows = [dict(count, filter=_filters.text(alternative)) for alternative, count in zip(alternatives, counts)]
        uncounted = [_filters.text(alternative) for alternative in alternatives[len(counts) :]]
        together = counts[len(alternatives)] if len(counts) > len(alternatives) else None
        return {
            "area": area.text,
            "rows": rows,
            "uncounted": uncounted,
            "together": together,
            "remark": answer.get("remark"),
        }
    keys = request["keys"]
    if len(keys) > KEYS:
        raise Invalid("%d keys is more than %d; look at them in turns" % (len(keys), KEYS))
    alternatives = [((key, None, None),) for key in keys]
    query = "[out:json][timeout:%d];%s;out tags %d;" % (SECONDS, area.select(alternatives), SAMPLE)
    answer = _http.overpass(query, SECONDS)
    elements = answer["elements"]
    found = []
    for key in keys:
        values = Counter(element["tags"][key] for element in elements if key in (element.get("tags") or {}))
        shown = values.most_common(VALUES)
        found.append({
            "key": key,
            "features": sum(values.values()),
            "values": shown,
            "others": len(values) - len(shown),
            "others_features": sum(values.values()) - sum(count for _value, count in shown),
        })
    return {"area": area.text, "keys": found, "sampled": len(elements) >= SAMPLE, "remark": answer.get("remark")}
