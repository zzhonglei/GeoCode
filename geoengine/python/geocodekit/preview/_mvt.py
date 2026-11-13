"""Mapbox Vector Tile bytes, written whole arrays at a time: a tile's points, lines or rings each go into one feature
of many parts, so no Python loop runs per feature. A tile carries no attributes; what was clicked is asked for."""

import numpy

from geocodekit.preview._mercator import EXTENT


def _varint(value):
    out = bytearray()
    while value >= 0x80:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def _varints(values):
    """Every value as a varint, each under 2**28."""
    encoded = numpy.empty((values.size, 4), dtype=numpy.uint8)
    more = [values >= 1 << 7, values >= 1 << 14, values >= 1 << 21]
    encoded[:, 0] = (values & 0x7F) | (more[0] << 7)
    encoded[:, 1] = ((values >> 7) & 0x7F) | (more[1] << 7)
    encoded[:, 2] = ((values >> 14) & 0x7F) | (more[2] << 7)
    encoded[:, 3] = values >> 21
    written = numpy.ones((values.size, 4), dtype=bool)
    written[:, 1], written[:, 2], written[:, 3] = more
    return encoded[written].tobytes()


def _zigzag(values):
    return (values << 1) ^ (values >> 63)


def _layer(name, kind, geometry):
    feature = b"\x18" + bytes([kind]) + b"\x22" + _varint(len(geometry)) + geometry
    encoded = name.encode()
    extent = b"\x28" + _varint(EXTENT)
    body = b"\x78\x02\x0a" + _varint(len(encoded)) + encoded + b"\x12" + _varint(len(feature)) + feature + extent
    return b"\x1a" + _varint(len(body)) + body


def points(name, u, v):
    """A layer of one feature, a multipoint; `u` and `v` are tile units, in the order they are written."""
    if u.size == 0:
        return b""
    steps = numpy.empty(u.size * 2, dtype=numpy.int64)
    steps[0::2] = numpy.diff(u, prepend=0)
    steps[1::2] = numpy.diff(v, prepend=0)
    return _layer(name, 1, _varint((u.size << 3) | 1) + _varints(_zigzag(steps)))


def paths(name, units, lengths, closed):
    """A layer of one feature of many lines, or of many rings when `closed`. `units` holds the parts' vertices one
    after another, in tile units, and `lengths` how many each part has: two at least for a line, three for a ring,
    whose first vertex is not repeated at its end."""
    if lengths.size == 0:
        return b""
    # A part is a MoveTo with its first vertex, a LineTo with the rest, and for a ring a ClosePath.
    sizes = 2 * lengths + 2 + (1 if closed else 0)
    begins = numpy.cumsum(sizes) - sizes
    stream = numpy.empty(int(sizes.sum()), dtype=numpy.int64)
    stream[begins] = 9
    stream[begins + 3] = ((lengths - 1) << 3) | 2
    if closed:
        stream[begins + sizes - 1] = 15
    part = numpy.repeat(numpy.arange(lengths.size), lengths)
    place = numpy.arange(units.shape[0]) - numpy.repeat(numpy.cumsum(lengths) - lengths, lengths)
    steps = _zigzag(numpy.diff(units, axis=0, prepend=numpy.zeros((1, 2), dtype=numpy.int64)))
    at = begins[part] + 1 + 2 * place + (place >= 1)
    stream[at] = steps[:, 0]
    stream[at + 1] = steps[:, 1]
    return _layer(name, 3 if closed else 2, _varints(stream))
