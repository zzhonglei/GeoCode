"""The attributes a downloaded feature carries: osm_id, name and category always; then the
keys the filters named, the keys worth recording of the kind they name, the keys the features' own presets say are
worth recording where enough of them carry one, and the keys asked for. Every other key is dropped and counted, unless
all tags were asked for: they are then kept in one column besides."""

import json
import math
from collections import Counter

from geocodekit.osm import _presets

ALL = "*"
CORE = ["osm_id", "name", "category"]
TAGS_COLUMN = "osm_tags"
# The share of the features that must carry a key their presets list for it to be a column: one restaurant among a
# campus's buildings does not give every building a cuisine.
SHARE = 0.05


class Feature:
    def __init__(self, ref, kind, geometry, tags):
        self.ref = ref
        self.kind = kind
        self.geometry = geometry
        self.tags = tags
        self.preset = _presets.match(tags, kind)


def _common(features):
    """The keys the features' presets list, their own tags first, that enough of the features carry, the most carried
    first."""
    carried = Counter()
    for feature in features:
        if feature.preset is not None:
            # Its tags and those added with them say what it is: a university is education=university and
            # amenity=university.
            own = list(feature.preset["tags"]) + list(feature.preset.get("addTags") or {})
            listed = [key for key in own if not key.endswith(":*")] + feature.preset["keys"]
            carried.update(key for key in dict.fromkeys(listed) if key in feature.tags)
    least = max(1, math.ceil(SHARE * len(features)))
    return [key for key, count in carried.most_common() if count >= least]


def columns(features, named, worth, asked, extra):
    """The columns of the features' attributes, after the core ones and `extra`, and the keys dropped, each with how
    many features carry it. `worth` is the keys worth recording of the kind the filters name. A key differing from a
    column's name in case only is dropped too: GeoPackage, as SQLite, does not tell such names apart."""
    everything = ALL in (asked or [])
    wanted = list(named) + [key for key in asked or [] if key != ALL] + list(worth) + _common(features)
    present = Counter(key for feature in features for key in feature.tags)
    taken = {name.lower() for name in CORE + extra + ([TAGS_COLUMN] if everything else [])}
    chosen = []
    for key in wanted:
        if key in present and key.lower() not in taken:
            chosen.append(key)
            taken.add(key.lower())
    dropped = [] if everything else sorted(
        ((key, count) for key, count in present.items() if key not in chosen and key != "name"),
        key=lambda entry: (-entry[1], entry[0]),
    )
    return chosen + ([TAGS_COLUMN] if everything else []), dropped


def category(feature, named):
    """What a feature is: its preset's category, else the first key the filters named that it carries."""
    if feature.preset is not None:
        found = _presets.category(feature.preset, feature.tags)
        if found:
            return found
    for key in named:
        if key in feature.tags:
            return "%s=%s" % (key, feature.tags[key])
    return None


def record(feature, chosen, named):
    values = {"osm_id": feature.ref, "name": feature.tags.get("name"), "category": category(feature, named)}
    for key in chosen:
        values[key] = json.dumps(feature.tags, ensure_ascii=False) if key == TAGS_COLUMN else feature.tags.get(key)
    return values
