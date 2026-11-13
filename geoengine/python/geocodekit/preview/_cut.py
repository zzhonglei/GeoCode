"""A tile of a vector layer, and the feature under a click. A tile keeps what a display can tell apart: a part
smaller than a cell of the tile's grid is drawn as a dot, one a cell at most, and a larger one keeps one vertex a
cell; a polygon longer than a cell and narrower than one, as the line it is then."""

import numpy
import shapely

from geocodekit.preview import _mercator, _mvt, _source
from geocodekit.preview._mercator import BUFFER, CELL, EXTENT
from geocodekit.preview._vector import LINE, POLYGON, starts

# As many parts as a click is measured against: the smallest about it, which a click picks first.
CANDIDATES = 2000


def _only(values, lengths, kept):
    """The runs that are kept, of runs laid one after another."""
    return values[numpy.repeat(kept, lengths)], lengths[kept]


def _distinct(units, lengths, closed):
    """The parts without the vertices that fall where the one before them did, and which of the parts are still
    drawable. A ring comes with its first vertex repeated at its end and leaves without it."""
    start = starts(lengths)
    count = units.shape[0]
    kept = numpy.ones(count, dtype=bool)
    kept[1:] = (units[1:] != units[:-1]).any(axis=1)
    kept[start] = True
    if closed:
        kept[start + lengths - 1] = False
        # What is left may again end where it began.
        last = numpy.maximum.reduceat(numpy.where(kept, numpy.arange(count), -1), start)
        again = (last > start) & (units[last] == units[start]).all(axis=1)
        kept[last[again]] = False
    lengths = numpy.add.reduceat(kept.astype(numpy.int64), start)
    units = units[kept]

    # Nor the vertices on the straight way from the one before them to the one after.
    start = starts(lengths)
    before, after = units[1:-1] - units[:-2], units[2:] - units[1:-1]
    kept = numpy.ones(units.shape[0], dtype=bool)
    kept[1:-1] = (before[:, 0] * after[:, 1] != before[:, 1] * after[:, 0]) | ((before * after).sum(axis=1) <= 0)
    kept[start] = True
    kept[start + lengths - 1] = True
    lengths = numpy.add.reduceat(kept.astype(numpy.int64), start)
    return units[kept], lengths, lengths >= (3 if closed else 2)


def _turns(units, lengths):
    """Twice the area each ring holds, positive where it runs clockwise as drawn."""
    start = starts(lengths)
    following = numpy.arange(units.shape[0]) + 1
    following[start + lengths - 1] = start
    return numpy.add.reduceat(units[:, 0] * units[following, 1] - units[following, 0] * units[:, 1], start)


def _wound(units, lengths, shell):
    """The rings each wound as a tile tells what it is by: a shell clockwise as drawn, a hole the other way. Falling
    onto the grid can turn a thin ring over, and the first ring of a tile's polygons says which way its shells run:
    turned over, it would make holes of them all."""
    start = starts(lengths)
    count = units.shape[0]
    turn = _turns(units, lengths)
    wrong = numpy.where(shell, turn < 0, turn > 0)
    if not wrong.any():
        return units
    backwards = numpy.repeat(2 * start + lengths - 1, lengths) - numpy.arange(count)
    return units[numpy.where(numpy.repeat(wrong, lengths), backwards, numpy.arange(count))]


def _clipped_lines(xy, lengths, box):
    lines = shapely.linestrings(xy, indices=numpy.repeat(numpy.arange(lengths.size), lengths))
    cut = shapely.clip_by_rect(lines, *box)
    pieces = shapely.get_parts(cut[~shapely.is_empty(cut)])
    pieces = pieces[shapely.get_type_id(pieces) == LINE]
    xy, of = shapely.get_coordinates(pieces, return_index=True)
    return xy, numpy.bincount(of, minlength=pieces.size)


def _cut_one(polygon, box):
    """A polygon GEOS will not cut as it is, mended first; nothing of it when that fails too."""
    try:
        return shapely.clip_by_rect(shapely.make_valid(polygon), *box)
    except shapely.errors.GEOSException:
        return None


def _clipped_polygons(xy, ring_lengths, rings, box):
    """The polygons cut to the box: their vertices, their rings' lengths and how many rings each has."""
    ring_shapes = shapely.linearrings(xy, indices=numpy.repeat(numpy.arange(ring_lengths.size), ring_lengths))
    polygons = shapely.polygons(ring_shapes, indices=numpy.repeat(numpy.arange(rings.size), rings))
    try:
        cut = shapely.clip_by_rect(polygons, *box)
    except shapely.errors.GEOSException:
        cut = numpy.array([_cut_one(polygon, box) for polygon in polygons], dtype=object)
    pieces = shapely.get_parts(cut[~(shapely.is_missing(cut) | shapely.is_empty(cut))])
    # Cutting gives rings back in either direction, and the direction is what tells a hole from a shell.
    pieces = shapely.orient_polygons(pieces[shapely.get_type_id(pieces) == POLYGON], exterior_cw=True)
    ring_shapes, of = shapely.get_rings(pieces, return_index=True)
    xy, ring = shapely.get_coordinates(ring_shapes, return_index=True)
    return xy, numpy.bincount(ring, minlength=ring_shapes.size), numpy.bincount(of, minlength=pieces.size)


def tile(layer, z, x, y, cancelled):
    """The tile as Mapbox Vector Tile bytes, or None when the layer has nothing in it. Its layers are named points,
    lines and polygons, small-lines and small-polygons for the dots of those too small to draw, and thin-polygons for
    the lines of polygons too thin to: what is shown of a layer is chosen by which of the three its features are."""
    left, top, span = _mercator.tile(z, x, y)
    unit = span / EXTENT
    cell = CELL * unit
    margin = BUFFER * unit
    box = (left - margin, top - span - margin, left + span + margin, top + margin)

    def units(xy):
        out = numpy.empty(xy.shape, dtype=numpy.int64)
        out[:, 0] = numpy.floor((xy[:, 0] - left) / unit)
        out[:, 1] = numpy.floor((top - xy[:, 1]) / unit)
        return out

    def thinned(xy):
        """One of the points in each cell, in tile units."""
        inside = (xy[:, 0] >= box[0]) & (xy[:, 0] < box[2]) & (xy[:, 1] > box[1]) & (xy[:, 1] <= box[3])
        at = units(xy[inside])
        side = (EXTENT + 2 * BUFFER) // CELL
        _, first = numpy.unique((at[:, 1] + BUFFER) // CELL * side + (at[:, 0] + BUFFER) // CELL, return_index=True)
        return at[first, 0], at[first, 1]

    def sorted_out(bounds, size):
        """The parts that reach into the tile: those too small to draw, those wholly in it, and those to be cut."""
        reaching = (
            (bounds[:, 2] >= box[0]) & (bounds[:, 0] <= box[2]) & (bounds[:, 3] >= box[1]) & (bounds[:, 1] <= box[3])
        )
        small = reaching & (size < cell)
        large = numpy.flatnonzero(reaching & ~small)
        within = (
            (bounds[large, 0] >= box[0])
            & (bounds[large, 2] <= box[2])
            & (bounds[large, 1] >= box[1])
            & (bounds[large, 3] <= box[3])
        )
        return numpy.flatnonzero(small), large[within], large[~within]

    def check():
        if cancelled():
            raise _source.Cancelled()

    layers = []

    def dots(name, bounds):
        """A dot where each of the parts too small to draw lies."""
        layers.append(_mvt.points(name, *thinned((bounds[:, :2] + bounds[:, 2:]) / 2)))

    points = layer.points
    if points is not None:
        near = (points.x >= box[0]) & (points.x < box[2]) & (points.y > box[1]) & (points.y <= box[3])
        if near.any():
            layers.append(_mvt.points("points", *thinned(numpy.column_stack((points.x[near], points.y[near])))))
    check()

    lines = layer.lines
    if lines is not None:
        small, within, crossing = sorted_out(lines.bounds, lines.size)
        dots("small-lines", lines.bounds[small])
        xy, lengths = lines.taken(within)
        if crossing.size:
            cut_xy, cut_lengths = _clipped_lines(*lines.taken(crossing), box)
            xy, lengths = numpy.concatenate((xy, cut_xy)), numpy.concatenate((lengths, cut_lengths))
        check()
        if lengths.size:
            at = units(xy)
            at -= at % CELL
            at, lengths, drawable = _distinct(at, lengths, False)
            layers.append(_mvt.paths("lines", *_only(at, lengths, drawable), False))
    check()

    polygons = layer.polygons
    if polygons is not None:
        small, within, crossing = sorted_out(polygons.bounds, polygons.size)
        dots("small-polygons", polygons.bounds[small])
        xy, ring_lengths, rings = polygons.taken(within)
        if crossing.size:
            cut_xy, cut_lengths, cut_rings = _clipped_polygons(*polygons.taken(crossing), box)
            xy = numpy.concatenate((xy, cut_xy))
            ring_lengths = numpy.concatenate((ring_lengths, cut_lengths))
            rings = numpy.concatenate((rings, cut_rings))
        check()
        if ring_lengths.size:
            at = units(xy)
            at -= at % CELL
            at, ring_lengths, drawable = _distinct(at, ring_lengths, True)
            shell = numpy.zeros(ring_lengths.size, dtype=bool)
            shell[starts(rings)] = True
            # A shell fallen onto one line of the grid has no inside left, however many vertices it keeps, and is not
            # small enough to be a dot.
            thin = shell & (ring_lengths >= 2) & (~drawable | (_turns(at, ring_lengths) == 0))
            if thin.any():
                layers.append(_mvt.paths("thin-polygons", *_only(at, ring_lengths, thin), False))
                drawable &= ~thin
            # A hole left without its shell would be read as a hole of the polygon before it.
            drawable &= numpy.repeat(drawable[starts(rings)], rings)
            at, ring_lengths = _only(at, ring_lengths, drawable)
            layers.append(_mvt.paths("polygons", _wound(at, ring_lengths, shell[drawable]), ring_lengths, True))
    check()
    return b"".join(layers) or None


def nearest(layer, x, y, tolerance, forms):
    """The number of the feature a click at `x`, `y` lands on, within `tolerance` metres of the plane: the smallest
    of those under it, so that a building is picked rather than the district it stands in. `forms` names those of
    points, lines and polygons that are shown, and so can be clicked. None when it lands on nothing."""
    found = []
    here = shapely.Point(x, y)

    points = layer.points if "points" in forms else None
    if points is not None and points.x.size:
        distance = numpy.hypot(points.x - x, points.y - y)
        closest = int(numpy.argmin(distance))
        if distance[closest] <= tolerance:
            found.append((0.0, float(distance[closest]), int(points.fid[closest])))

    def about(bounds):
        near = numpy.flatnonzero(
            (bounds[:, 0] <= x + tolerance)
            & (bounds[:, 2] >= x - tolerance)
            & (bounds[:, 1] <= y + tolerance)
            & (bounds[:, 3] >= y - tolerance)
        )
        area = (bounds[near, 2] - bounds[near, 0]) * (bounds[near, 3] - bounds[near, 1])
        order = numpy.argsort(area)[:CANDIDATES]
        return near[order], area[order]

    def best(shapes, area, fid):
        distance = shapely.distance(shapes, here)
        for index in numpy.flatnonzero(distance <= tolerance):
            found.append((float(area[index]), float(distance[index]), int(fid[index])))

    lines = layer.lines if "lines" in forms else None
    if lines is not None:
        near, area = about(lines.bounds)
        if near.size:
            xy, lengths = lines.taken(near)
            shapes = shapely.linestrings(xy, indices=numpy.repeat(numpy.arange(near.size), lengths))
            best(shapes, area, lines.fid[near])

    polygons = layer.polygons if "polygons" in forms else None
    if polygons is not None:
        near, area = about(polygons.bounds)
        if near.size:
            xy, ring_lengths, rings = polygons.taken(near)
            ring_shapes = shapely.linearrings(xy, indices=numpy.repeat(numpy.arange(ring_lengths.size), ring_lengths))
            shapes = shapely.polygons(ring_shapes, indices=numpy.repeat(numpy.arange(near.size), rings))
            best(shapes, area, polygons.fid[near])

    return min(found)[2] if found else None
