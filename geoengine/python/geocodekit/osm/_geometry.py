"""Geometries of OSM elements as Overpass gives them with `out geom`, or as Nominatim gives
their shapes: a closed way is an area when the community's rules say so, a multipolygon relation is assembled from its
members' rings, and a route relation is its members' lines. An element whose rings do not close has no geometry rather
than a part of one."""

from shapely.geometry import LineString, MultiLineString, Point, Polygon, shape
from shapely.ops import linemerge, polygonize, unary_union
from shapely.prepared import prep
from shapely.validation import make_valid

from geocodekit.osm import _presets

AREA_RELATIONS = ("multipolygon", "boundary")
LINE_RELATIONS = ("route", "waterway", "multilinestring")
FAMILIES = {"point": "points", "line": "lines", "area": "polygons"}


def _points(nodes):
    return [(node["lon"], node["lat"]) for node in nodes or [] if node]


def _polygonal(geometry):
    """The areas of a geometry made valid; None when nothing of it is an area."""
    if not geometry.is_valid:
        geometry = make_valid(geometry)
    if geometry.geom_type in ("Polygon", "MultiPolygon"):
        return geometry if not geometry.is_empty else None
    parts = [part for part in getattr(geometry, "geoms", []) if part.geom_type in ("Polygon", "MultiPolygon")]
    return unary_union(parts) if parts else None


def _closed(points):
    return len(points) >= 4 and points[0] == points[-1]


def _lines(members):
    """The member ways' lines."""
    found = (_points(member.get("geometry")) for member in members)
    return [LineString(points) for points in found if len(points) > 1]


def _assembled(members):
    """A multipolygon from its member ways, whatever their roles say: each face of their rings is inside when an odd
    number of rings holds it, so islands in lakes and lakes on islands come out right. None when a ring is open."""
    lines = _lines(members)
    if not lines:
        return None
    merged = linemerge(lines)
    rings = list(merged.geoms) if merged.geom_type == "MultiLineString" else [merged]
    if not all(_closed(list(ring.coords)) for ring in rings):
        return None
    holders = [prep(Polygon(ring)) for ring in rings]
    kept = [
        face
        for face in polygonize(rings)
        if sum(holder.contains(face.representative_point()) for holder in holders) % 2 == 1
    ]
    return _polygonal(unary_union(kept)) if kept else None


def of(element):
    """An element's kind ("point", "line" or "area") and geometry; (None, None) when it has none."""
    tags = element.get("tags") or {}
    if element["type"] == "node":
        return "point", Point(element["lon"], element["lat"])
    if element["type"] == "way":
        points = _points(element.get("geometry"))
        if len(points) < 2:
            return None, None
        if _closed(points) and _presets.is_area(tags):
            area = _polygonal(Polygon(points))
            return ("area", area) if area is not None else (None, None)
        return "line", LineString(points)
    ways = [member for member in element.get("members", []) if member.get("type") == "way"]
    if tags.get("type") in AREA_RELATIONS:
        area = _assembled(ways)
        return ("area", area) if area is not None else (None, None)
    if tags.get("type") in LINE_RELATIONS:
        lines = _lines(ways)
        if not lines:
            return None, None
        merged = linemerge(lines)
        return "line", merged if merged.geom_type == "MultiLineString" else MultiLineString([merged])
    return None, None


def of_shape(kind, geojson, tags):
    """An object's kind and geometry from a GeoJSON geometry, as Nominatim gives one: a way's
    points are judged by the same rule as above, a relation's areas and lines are taken as they are assembled.
    (None, None) for a shape that says less, as a point given for a relation."""
    form = geojson.get("type")
    if kind == "node":
        return ("point", shape(geojson)) if form == "Point" else (None, None)
    if kind == "way":
        coordinates = geojson.get("coordinates") or []
        ring = coordinates[0] if form == "Polygon" and coordinates else coordinates if form == "LineString" else []
        points = [tuple(point) for point in ring]
        if len(points) < 2:
            return None, None
        if _closed(points) and _presets.is_area(tags):
            area = _polygonal(Polygon(points))
            return ("area", area) if area is not None else (None, None)
        return "line", LineString(points)
    if form in ("Polygon", "MultiPolygon"):
        area = _polygonal(shape(geojson))
        return ("area", area) if area is not None else (None, None)
    if form in ("LineString", "MultiLineString"):
        lines = shape(geojson)
        return "line", lines if form == "MultiLineString" else MultiLineString([lines])
    return None, None


def representative(kind, geometry):
    """One point for a feature: a point itself, the middle of a line, and a point inside an area, which its centroid
    need not be."""
    if kind == "point":
        return geometry
    if kind == "line":
        return geometry.interpolate(0.5, normalized=True)
    return geometry.point_on_surface()
