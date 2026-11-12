"""A vector layer's geometry in memory, in the map's plane, so that every tile of it is cut without reading the file
again. Each feature is kept as its single parts, points, lines and polygons, as arrays of coordinates rather than
geometry objects, which take ten times the memory; a part remembers the feature it came from."""

import numpy
import pyproj
import shapely
from osgeo import gdal, ogr

from geocodekit.preview import _mercator, _source

# As many vertices as a layer may bring into memory, sixteen bytes each.
VERTICES = 20000000
BATCH = 65536
# The formats that give one feature only by reading the file through to it: a click on a large file would take as
# long as opening it did, so their attributes are kept from the one reading. Text holds little for its size.
READ_THROUGH = ("GeoJSON", "GeoJSONSeq")

# What shapely numbers the kinds of geometry: the single ones, and from MULTI on those made of several.
POINT, LINE, RING, POLYGON, MULTI = 0, 1, 2, 3, 4


def starts(lengths):
    """Where each run begins, in an array holding runs of these lengths one after another."""
    return numpy.cumsum(lengths) - lengths


class Points:
    def __init__(self, xy, fid):
        self.x, self.y, self.fid = numpy.ascontiguousarray(xy[:, 0]), numpy.ascontiguousarray(xy[:, 1]), fid


class Lines:
    def __init__(self, xy, length, fid):
        self.xy, self.length, self.fid = xy, length, fid
        self.start = starts(length)
        self.bounds = _bounds(xy, self.start)
        self.size = _size(self.bounds)


class Polygons:
    """`first` and `rings` say which rings are a polygon's, its shell before its holes; `ring_start` and
    `ring_length` which vertices are a ring's. A shell runs clockwise as the map shows it, a hole the other way."""

    def __init__(self, xy, ring_length, rings, fid):
        self.xy, self.ring_length, self.rings, self.fid = xy, ring_length, rings, fid
        self.ring_start = starts(ring_length)
        self.first = starts(rings)
        # A polygon lies within its shell.
        self.bounds = _bounds(xy, self.ring_start)[self.first]
        self.size = _size(self.bounds)


class Attributes:
    """Every feature's attributes, as the columns they were read in rather than as objects."""

    def __init__(self, batches, number):
        # Imported here and in `_whole`: no other layer's reader loads it.
        import pyarrow

        table = pyarrow.Table.from_batches(batches)
        # Through a list, as in `_whole`.
        self._fid = numpy.array(table.column(number).to_pylist(), dtype=numpy.int64)
        self._table = table.drop_columns([number])

    def of(self, fid):
        """As `attributes` gives them."""
        rows = numpy.flatnonzero(self._fid == fid)
        if rows.size == 0:
            return None
        return [[name, _plain(value)] for name, value in self._table.slice(int(rows[0]), 1).to_pylist()[0].items()]


class Layer:
    """`attributes` is None where a click reads them from the file."""

    def __init__(self, points, lines, polygons, attributes):
        self.points, self.lines, self.polygons, self.attributes = points, lines, polygons, attributes
        # How many features have points, lines and polygons among their parts, for those that any has. A feature that
        # is a collection may have several of them.
        self.forms = {
            name: int(numpy.unique(parts.fid).size)
            for name, parts in (("points", points), ("lines", lines), ("polygons", polygons))
            if parts is not None and parts.fid.size
        }


def _bounds(xy, start):
    if start.size == 0:
        return numpy.empty((0, 4))
    return numpy.column_stack(
        (
            numpy.minimum.reduceat(xy[:, 0], start),
            numpy.minimum.reduceat(xy[:, 1], start),
            numpy.maximum.reduceat(xy[:, 0], start),
            numpy.maximum.reduceat(xy[:, 1], start),
        )
    )


def _size(bounds):
    return numpy.maximum(bounds[:, 2] - bounds[:, 0], bounds[:, 3] - bounds[:, 1])


def _any(flags, start):
    """Whether any flag of each run is set."""
    return numpy.add.reduceat(flags.astype(numpy.int64), start) > 0


def _straight(value):
    """A curved geometry as the lines that follow it; shapely reads no curves."""
    if value is None:
        return None
    geometry = ogr.CreateGeometryFromWkb(bytes(value))
    return None if geometry is None else bytes(geometry.GetLinearGeometry().ExportToWkb())


def _single(wkb, fid):
    """The geometries of a batch as single parts, each with the number of its feature."""
    try:
        shapes = shapely.from_wkb(wkb, on_invalid="ignore")
    except NotImplementedError:
        shapes = shapely.from_wkb([_straight(value) for value in wkb], on_invalid="ignore")
    shapes = shapely.force_2d(shapes)
    kinds = shapely.get_type_id(shapes)
    # A collection may hold collections.
    while (kinds >= MULTI).any():
        many = kinds >= MULTI
        parts, of = shapely.get_parts(shapes[many], return_index=True)
        shapes = numpy.concatenate((shapes[~many], parts))
        fid = numpy.concatenate((fid[~many], fid[many][of]))
        kinds = shapely.get_type_id(shapes)
    drawn = ~(shapely.is_missing(shapes) | shapely.is_empty(shapes))
    return shapes[drawn], fid[drawn], kinds[drawn]


class _Projection:
    """From the layer's coordinates to the map's plane."""

    def __init__(self, srs):
        self._degrees = pyproj.Transformer.from_crs(pyproj.CRS.from_wkt(srs.ExportToWkt()), "EPSG:4326", always_xy=True)

    def __call__(self, xy):
        """The coordinates in the plane, and which of them have a place there."""
        longitude, latitude = self._degrees.transform(xy[:, 0], xy[:, 1])
        x, y = _mercator.plane(longitude, latitude)
        return numpy.column_stack((x, y)), numpy.isfinite(x) & numpy.isfinite(y)


def _geometry(layer, geometry, number):
    """The layer's geometry and the numbers of its features, a batch at a time, and nothing of its attributes: those
    of what is clicked are asked for one feature at a time."""
    fields = layer.GetLayerDefn()
    layer.SetIgnoredFields([fields.GetFieldDefn(index).GetName() for index in range(fields.GetFieldCount())])
    batches = layer.GetArrowStreamAsNumPy(
        options=["USE_MASKED_ARRAYS=NO", "INCLUDE_FID=YES", "MAX_FEATURES_IN_BATCH=%d" % BATCH]
    )
    for batch in batches:
        # Geometry of one length throughout, as points are, comes as an array of that width rather than of objects.
        yield batch[geometry].astype(object), batch[number].astype(numpy.int64)


def _whole(layer, geometry, number, columns):
    """As `_geometry`, with each batch's attributes added to `columns`."""
    import pyarrow

    for batch in layer.GetArrowStreamAsPyArrow(["INCLUDE_FID=YES", "MAX_FEATURES_IN_BATCH=%d" % BATCH]):
        columns.append(pyarrow.RecordBatch.from_struct_array(batch).drop_columns([geometry]))
        # Through lists: asked for an array, pyarrow loads pandas first, which takes longer than a small file does.
        yield batch.field(geometry).to_pylist(), numpy.array(batch.field(number).to_pylist(), dtype=numpy.int64)


def load(path, name, cancelled):
    """The layer, read a batch of features at a time so that the file's own form of it never stays in memory."""
    dataset = _source.opened(path, gdal.OF_VECTOR)
    layer = None if dataset is None else dataset.GetLayerByName(name)
    if layer is None:
        raise _source.Unshown("unopenable", gdal.GetLastErrorMsg())
    project = _Projection(layer.GetSpatialRef())
    # The names GDAL gives the two columns of a layer that has none of its own for them.
    geometry, number = layer.GetGeometryColumn() or "wkb_geometry", layer.GetFIDColumn() or "OGC_FID"
    columns = []
    if dataset.GetDriver().ShortName in READ_THROUGH:
        batches = _whole(layer, geometry, number, columns)
    else:
        batches = _geometry(layer, geometry, number)
    points, lines, polygons = [], [], []
    vertices = 0
    for wkb, fid in batches:
        if cancelled():
            raise _source.Cancelled()
        shapes, fid, kinds = _single(wkb, fid)

        chosen = kinds == POINT
        if chosen.any():
            xy, placed = project(shapely.get_coordinates(shapes[chosen]))
            points.append((xy[placed], fid[chosen][placed]))
            vertices += int(placed.sum())

        chosen = (kinds == LINE) | (kinds == RING)
        if chosen.any():
            xy, of = shapely.get_coordinates(shapes[chosen], return_index=True)
            length = numpy.bincount(of, minlength=int(chosen.sum()))
            xy, placed = project(xy)
            kept = ~_any(~placed, starts(length))
            lines.append((xy[numpy.repeat(kept, length)], length[kept], fid[chosen][kept]))
            vertices += xy.shape[0]

        chosen = kinds == POLYGON
        if chosen.any():
            rings, of = shapely.get_rings(shapely.orient_polygons(shapes[chosen], exterior_cw=True), return_index=True)
            count = numpy.bincount(of, minlength=int(chosen.sum()))
            xy, ring = shapely.get_coordinates(rings, return_index=True)
            ring_length = numpy.bincount(ring, minlength=rings.size)
            xy, placed = project(xy)
            kept = ~_any(_any(~placed, starts(ring_length)), starts(count))
            ring_kept = numpy.repeat(kept, count)
            polygons.append(
                (xy[numpy.repeat(ring_kept, ring_length)], ring_length[ring_kept], count[kept], fid[chosen][kept])
            )
            vertices += xy.shape[0]

        if vertices > VERTICES:
            raise _source.Unshown("too-large")

    def joined(batches, index, dtype=numpy.int64):
        return numpy.concatenate([batch[index] for batch in batches]).astype(dtype, copy=False)

    return Layer(
        Points(joined(points, 0, numpy.float64), joined(points, 1)) if points else None,
        Lines(joined(lines, 0, numpy.float64), joined(lines, 1), joined(lines, 2)) if lines else None,
        Polygons(joined(polygons, 0, numpy.float64), joined(polygons, 1), joined(polygons, 2), joined(polygons, 3))
        if polygons
        else None,
        Attributes(columns, number) if columns else None,
    )


def _plain(value):
    """An attribute's value as JSON carries it."""
    if value is None or isinstance(value, (str, int)):
        return value
    if isinstance(value, float):
        return value if numpy.isfinite(value) else None
    if isinstance(value, (list, tuple)):
        return [_plain(each) for each in value]
    if isinstance(value, (bytes, bytearray)):
        return None
    return str(value)


def attributes(path, name, fid):
    """A feature's attributes in the layer's order, each a name and a value, or None when the layer has no such
    feature."""
    dataset = _source.opened(path, gdal.OF_VECTOR)
    layer = None if dataset is None else dataset.GetLayerByName(name)
    if layer is None:
        raise _source.Unshown("unopenable", gdal.GetLastErrorMsg())
    feature = layer.GetFeature(fid)
    if feature is None:
        return None
    return [
        [feature.GetFieldDefnRef(index).GetName(), _plain(feature.GetField(index))]
        for index in range(feature.GetFieldCount())
    ]
