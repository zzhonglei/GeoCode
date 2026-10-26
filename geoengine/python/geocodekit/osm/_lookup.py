"""OSM objects by id as Nominatim gives them (docs/OSM.md, sections 5 and 7): their geometry and tags, without asking
Overpass. Nominatim lacks some objects, many of those without names among them, and gives some relations as a point
alone; those are left to Overpass."""

from datetime import datetime, timezone

from geocodekit.osm import _elements, _geometry, _http

# Ids Nominatim looks up in one request at most.
BATCH = 50
# The class and type Nominatim gives an object that has an address and nothing else: not one of its tags.
ADDRESS_ONLY = ("place", "house")
# Kept by Nominatim among an object's tags, though not one of them: the kind of place node a boundary is linked to.
# The names of that node are among its names too, each key starting with "_", as "_place_name:ja".
NOT_TAGS = ("linked_place",)


def _tags(properties):
    """An object's tags as far as Nominatim keeps them: its class and type, its names and its other tags. An address
    is in Nominatim's own form, so the object's addr:* tags are not among them."""
    tags = {key: value for key, value in (properties.get("extratags") or {}).items() if key not in NOT_TAGS}
    tags.update((key, value) for key, value in (properties.get("namedetails") or {}).items() if key[:1] != "_")
    key, value = properties.get("category"), properties.get("type")
    if key and value and (key, value) != ADDRESS_ONLY:
        tags.setdefault(key, value)
    return tags


def objects(refs):
    """Each object Nominatim has of those the ids name, by its (type, id): its kind, geometry and tags."""
    found = {}
    for start in range(0, len(refs), BATCH):
        names = ",".join(_elements.name(ref) for ref in refs[start : start + BATCH])
        params = {"osm_ids": names, "format": "geojson", "polygon_geojson": 1, "extratags": 1, "namedetails": 1}
        answer = _http.get("nominatim", "lookup", params)
        for feature in (answer or {}).get("features") or []:
            properties = feature.get("properties") or {}
            kind = properties.get("osm_type")
            if kind not in _elements.STATEMENTS or not feature.get("geometry"):
                continue
            tags = _tags(properties)
            shape_kind, geometry = _geometry.of_shape(kind, feature["geometry"], tags)
            if shape_kind is not None:
                found[(kind, int(properties["osm_id"]))] = (shape_kind, geometry, tags)
    return found


def timestamp():
    """When Nominatim's data is from, as Overpass writes it; None when Nominatim does not say."""
    status = _http.get("nominatim", "status", {"format": "json"})
    try:
        then = datetime.fromisoformat((status or {})["data_updated"])
    except (KeyError, TypeError, ValueError):
        return None
    return then.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
