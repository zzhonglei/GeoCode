"""The community's tagging conventions, as _data.json holds them (geoengine/script/osm-data.ts writes it): the iD
editor's presets, for the tags a word names and what a feature is, its deprecated tags, and when a closed way is an
area."""

import json
import os
import re

_data = None
# Presets by the keys of their tags: a feature is matched only against those its own keys can satisfy.
_by_key = None
# Every key a match depends on, so features differing in no other key share one match.
_scored = None
_matched = {}
# By a preset's id, the unsearchable preset of the same name whose tags it adds: the older tagging of the same thing, as
# amenity=university for education=university.
_older = None


def data():
    global _data, _by_key, _scored, _older
    if _data is None:
        with open(os.path.join(os.path.dirname(__file__), "_data.json"), encoding="utf-8") as source:
            _data = json.load(source)
        _by_key = {}
        _scored = set()
        named = {}
        for preset in _data["presets"]:
            for key in preset["tags"]:
                _by_key.setdefault(key, []).append(preset)
            _scored.update(preset["tags"], preset.get("addTags") or {})
            named.setdefault(preset["name"], []).append(preset)
        _older = {}
        for preset in _data["presets"]:
            added = preset.get("addTags") or {}
            for other in named[preset["name"]]:
                kept = other.get("searchable") is False and other["tags"] != preset["tags"]
                if kept and all(added.get(key) == value for key, value in other["tags"].items()):
                    _older[preset["id"]] = other
    return _data


def is_area(tags):
    """Whether a closed way with these tags is an area rather than a ring of line, as osm-polygon-features rules."""
    if tags.get("area") == "no":
        return False
    for rule in data()["polygons"]:
        value = tags.get(rule["key"])
        if value is None or value == "no":
            continue
        if rule["polygon"] == "all":
            return True
        if rule["polygon"] == "whitelist" and value in rule["values"]:
            return True
        if rule["polygon"] == "blacklist" and value not in rule["values"]:
            return True
    return False


def _holds(tags, key, value):
    if key.endswith(":*"):
        return any(name.startswith(key[:-1]) for name in tags)
    return key in tags and (value == "*" or tags[key] == value)


def _score(preset, tags):
    """iD's own matching: each of the preset's tags present, wildcards counting half, and its addTags counting too."""
    weight = preset.get("matchScore", 1)
    score = 0.0
    for key, value in preset["tags"].items():
        if not _holds(tags, key, value):
            return -1
        score += weight / 2 if value == "*" else weight
    for key, value in (preset.get("addTags") or {}).items():
        if key not in preset["tags"] and tags.get(key) == value:
            score += weight
    return score * 0.999 if preset.get("searchable") is False else score


def match(tags, kind):
    """The preset a feature is, for its kind ("point", "line" or "area"), or None."""
    data()
    relevant = tuple(sorted((key, value) for key, value in tags.items() if key in _scored or ":" in key))
    found = _matched.get((relevant, kind), False)
    if found is not False:
        return found
    geometry = ("point", "vertex") if kind == "point" else (kind,)
    best, best_score = None, 0.0
    seen = set()
    for key in tags:
        for preset in _by_key.get(key, []) + _by_key.get(key.split(":", 1)[0] + ":*", []):
            if id(preset) in seen or not any(shape in preset["geometry"] for shape in geometry):
                continue
            seen.add(id(preset))
            score = _score(preset, tags)
            if score > best_score:
                best, best_score = preset, score
    _matched[(relevant, kind)] = best
    return best


def category(preset, tags):
    """A feature's category as the tags its preset is matched by, with the feature's own value for a wildcard, written
    as a tag filter is, so that a look or a download can be asked for it as it stands: the older tags of the same thing
    when the feature carries them, as many features carry only those, and several tags each in brackets."""
    older = _older.get(preset["id"])
    if older is not None and all(_holds(tags, key, value) for key, value in older["tags"].items()):
        preset = older
    conditions = [
        "%s=%s" % (key, tags.get(key, value) if value == "*" else value)
        for key, value in preset["tags"].items()
        if not key.endswith(":*")
    ]
    return conditions[0] if len(conditions) == 1 else "".join("[%s]" % condition for condition in conditions)


# Letters of any script, so that a word with an accent, as "café", is not cut into a shorter one.
WORD = re.compile(r"[^\W_]+")


def _words(text):
    return WORD.findall(text.lower())


def _singular(word):
    return word[:-1] if len(word) > 3 and word.endswith("s") and not word.endswith("ss") else word


def search(term, limit):
    """The searchable presets an English word or phrase names, best first: by name before other terms, a name starting
    with it before one with it further on."""
    wanted = [_singular(word) for word in _words(term)]
    if not wanted:
        return []
    phrase = " ".join(wanted)
    found = []
    for preset in data()["presets"]:
        if preset.get("searchable") is False or any(key.endswith(":*") for key in preset["tags"]):
            continue
        name = " ".join(_singular(word) for word in _words(preset["name"]))
        terms = [" ".join(_singular(word) for word in _words(term)) for term in preset["terms"]]
        whole = re.compile(r"\b%s\b" % re.escape(phrase))
        if name == phrase:
            rank = 0
        elif name.startswith(phrase + " "):
            rank = 1
        elif whole.search(name):
            rank = 2
        elif phrase in terms:
            rank = 3
        elif any(whole.search(term) for term in terms):
            rank = 4
        elif phrase in name:
            rank = 5
        else:
            continue
        # Among equals, the more general preset first: fewer tags to match, and iD's own weight.
        found.append((rank, len(preset["tags"]), -preset.get("matchScore", 1), len(preset["name"]), preset))
    found.sort(key=lambda entry: entry[:4])
    return [entry[4] for entry in found[:limit]]


def deprecated(tags):
    """The deprecated tags that iD replaces by these, each as a dict of tags."""
    return [
        entry["old"]
        for entry in data()["deprecated"]
        if entry.get("replace") and all(tags.get(key) == value for key, value in entry["replace"].items())
    ]


def keys(tags):
    """The keys the preset these tags name says are worth recording, as a feature of it carries them; none when no
    preset has exactly these tags."""
    for preset in data()["presets"]:
        if preset["tags"] == tags:
            return preset["keys"]
    return []
