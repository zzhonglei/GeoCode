"""The areas the OSM tools look in (docs/OSM.md, section 5), as the agent writes one: ids of OSM areas, bbox:,
around: a point or objects, or file: a local boundary. An area becomes what a query filters by, and, when it is a
polygon, the polygon itself, which features are kept within once Overpass has answered."""

import math
import os

from geocodekit.osm import _elements, _filters, _http
from geocodekit.osm._elements import Invalid

# Overpass slows with each vertex of a polygon it filters by: a ring with more is queried by its convex hull, and an
# area of more parts than this by the box around them all. Either holds the area whole, and is narrowed back after.
RING_VERTICES = 1000
PARTS = 8
METERS_PER_DEGREE = 111320.0
SECONDS = 120

FORMS = (
    "write an area as the ids of OSM areas (R123 or R123,W456), bbox:south,west,north,east, "
    "around:latitude,longitude,meters, around:<ids>,meters or file:<path>"
)


class Area:
    """What a query filters by: the filters a statement ends with, one per part of the area, the box holding it, as
    south, west, north and east, and the polygon features are kept within, if any."""

    def __init__(self, text, clauses, bounds, exact=None):
        self.text = text
        self.clauses = clauses
        self.bounds = bounds
        self.exact = exact

    def select(self, alternatives, cell=None):
        """The union of the features meeting any alternative in the area, within a cell of it when given one."""
        within = "" if cell is None else "(%s)" % ",".join("%.7f" % value for value in cell)
        statements = [
            "nwr%s%s%s;" % (_filters.clause(alternative), clause, within)
            for alternative in alternatives
            for clause in self.clauses
        ]
        return "(%s)" % "".join(statements)


def shown(text):
    """An area as a file others may open names it: a boundary file by its name, not where it lies on this computer."""
    if not text.lower().startswith("file:"):
        return text
    target, bar, layer = text[5:].strip().partition("|")
    return "file:%s%s%s" % (os.path.basename(os.path.normpath(target)), bar, layer)


def _numbers(text, count, whole, form):
    try:
        values = [float(part) for part in text.split(",")]
    except ValueError:
        values = []
    if len(values) != count:
        raise Invalid('"%s" is not an area: write %s' % (whole, form))
    return values


def _point(latitude, longitude, whole):
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        raise Invalid('"%s" has a latitude or longitude out of range: latitude comes first' % whole)


def parse(text):
    """The area a text names, looking up the OSM objects it names and reading the file it names."""
    text = text.strip()
    lower = text.lower()
    if lower.startswith("bbox:"):
        return _box(text)
    if lower.startswith("around:"):
        return _around(text)
    if lower.startswith("file:"):
        return _file(text)
    if not text:
        raise Invalid("no area is given: %s" % FORMS)
    return _objects(text)


def _box(text):
    form = "bbox:south,west,north,east, as bbox:24.95,121.45,25.21,121.67"
    south, west, north, east = _numbers(text[5:], 4, text, form)
    _point(south, west, text)
    _point(north, east, text)
    if south >= north or west >= east:
        raise Invalid('"%s" is not a box: south comes before north and west before east' % text)
    return Area(text, ["(%.7f,%.7f,%.7f,%.7f)" % (south, west, north, east)], (south, west, north, east))


def _widened(bounds, meters):
    south, west, north, east = bounds
    across = meters / METERS_PER_DEGREE
    along = across / max(0.01, math.cos(math.radians(max(abs(south), abs(north)))))
    return (max(-90.0, south - across), max(-180.0, west - along), min(90.0, north + across), min(180.0, east + along))


def _around(text):
    parts = [part.strip() for part in text[7:].split(",")]
    if parts and parts[0][:1].upper() in _elements.TYPES and len(parts) >= 2:
        refs = [_elements.parse(part) for part in parts[:-1]]
        meters = _numbers(parts[-1], 1, text, "around:<ids>,meters, as around:R10958940,1000")[0]
        if meters <= 0:
            raise Invalid('"%s" needs a distance above 0 meters' % text)
        return _polygon(text, _buffered([_shape(element) for element in _found(refs)], meters))
    latitude, longitude, meters = _numbers(
        text[7:], 3, text, "around:latitude,longitude,meters, as around:25.0339,121.5645,1000"
    )
    _point(latitude, longitude, text)
    if meters <= 0:
        raise Invalid('"%s" needs a radius above 0 meters' % text)
    clause = "(around:%.1f,%.7f,%.7f)" % (meters, latitude, longitude)
    return Area(text, [clause], _widened((latitude, longitude, latitude, longitude), meters))


def _bounds_of(element):
    if "bounds" in element:
        box = element["bounds"]
        return (box["minlat"], box["minlon"], box["maxlat"], box["maxlon"])
    return (element["lat"], element["lon"], element["lat"], element["lon"])


def _found(refs):
    """The objects the ids name, with their geometries. An id OSM lacks was written wrong, unless the server stopped
    early: then its own words say why the object is not there."""
    found = _http.overpass("[out:json][timeout:%d];%s;out geom;" % (SECONDS, _elements.select(refs)), SECONDS)
    have = {(element["type"], element["id"]) for element in found["elements"]}
    lost = [ref for ref in refs if ref not in have]
    if lost and found.get("remark"):
        raise _http.Refused(found["remark"])
    if lost:
        names = ", ".join("%s%d" % (_elements.LETTERS[kind], number) for kind, number in lost)
        raise Invalid("OSM has no %s" % names)
    return found["elements"]


def _shape(element):
    """An object's geometry, or the box around it when it has none, as a relation of another kind."""
    from shapely.geometry import box

    from geocodekit.osm import _geometry

    _kind, geometry = _geometry.of(element)
    if geometry is not None:
        return geometry
    south, west, north, east = _bounds_of(element)
    return box(west, south, east, north)


def _buffered(shapes, meters):
    """The objects and all within `meters` of them, measured in a projection centred on them: a degree of longitude
    is shorter away from the equator."""
    import pyproj
    from shapely.ops import transform, unary_union

    whole = unary_union(shapes)
    centre = whole.centroid
    local = pyproj.CRS.from_proj4("+proj=aeqd +lat_0=%.7f +lon_0=%.7f +units=m" % (centre.y, centre.x))
    there = pyproj.Transformer.from_crs("EPSG:4326", local, always_xy=True).transform
    back = pyproj.Transformer.from_crs(local, "EPSG:4326", always_xy=True).transform
    return transform(back, transform(there, whole).buffer(meters))


def _objects(text):
    from shapely.ops import unary_union

    from geocodekit.osm import _geometry

    refs = [_elements.parse(part) for part in text.split(",")]
    areas = []
    for element in _found(refs):
        kind, geometry = _geometry.of(element)
        if kind != "area":
            name = _elements.ref(element)
            shape = {"point": "a point", "line": "a line"}.get(kind, "not an area")
            raise Invalid(
                "%s is %s, so it has no inside to look in; use around:%s,<meters> for what is near it"
                % (name, shape, name)
            )
        areas.append(geometry)
    return _polygon(text, unary_union(areas))


def _file(text):
    import geopandas
    import pyogrio
    from shapely.ops import unary_union

    target, _bar, layer = text[5:].strip().partition("|")
    name = layer[len("layername=") :] if layer.startswith("layername=") else None
    try:
        layers = [entry[0] for entry in pyogrio.list_layers(target)]
    except Exception as error:
        raise Invalid("%s cannot be read as geographic data: %s" % (target, error))
    if name is None and len(layers) > 1:
        raise Invalid(
            "%s has several layers (%s); name one, as file:%s|layername=%s"
            % (target, ", ".join(layers), target, layers[0])
        )
    if name is not None and name not in layers:
        raise Invalid("%s has no layer %s; its layers are %s" % (target, name, ", ".join(layers)))
    frame = geopandas.read_file(target, layer=name or layers[0], engine="pyogrio")
    if frame.crs is None:
        raise Invalid("%s has no coordinate reference system, so where it lies is unknown" % target)
    shapes = [
        shape for shape in frame.to_crs(4326).geometry if shape is not None and shape.geom_type.endswith("Polygon")
    ]
    if not shapes:
        raise Invalid("%s holds no polygon to use as an area" % target)
    return _polygon(text, unary_union(shapes))


def _polygon(text, exact):
    """An area that is a polygon: queried by each part's outer ring, or a superset of it, never by less."""
    parts = list(exact.geoms) if exact.geom_type == "MultiPolygon" else [exact]
    if len(parts) > PARTS:
        parts = [exact.envelope]
    rings = []
    for part in parts:
        ring = part.exterior
        if len(ring.coords) > RING_VERTICES:
            ring = part.convex_hull.exterior
        if len(ring.coords) > RING_VERTICES:
            ring = part.envelope.exterior
        rings.append(ring)
    clauses = ['(poly:"%s")' % " ".join("%.7f %.7f" % (y, x) for x, y in ring.coords[:-1]) for ring in rings]
    west, south, east, north = exact.bounds
    return Area(text, clauses, (south, west, north, east), exact=exact)
