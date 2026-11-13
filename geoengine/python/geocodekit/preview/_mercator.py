"""Web Mercator, the plane the map is drawn in, and its tiles."""

import math

import numpy

HALF = 20037508.342789244
# Past this latitude the plane ends.
LATITUDE = 85.0511287798066
# A vector tile's side in its own units, and how far past its edges its content reaches so that a symbol drawn on an
# edge is whole in both tiles.
EXTENT = 4096
BUFFER = 64
# A cell of a tile's grid, in its units: a quarter of a pixel when a tile is drawn 512 pixels wide. What falls into
# one cell cannot be told apart on a display.
CELL = 2


def plane(longitude, latitude):
    x = longitude * (HALF / 180)
    y = numpy.log(numpy.tan((90 + numpy.clip(latitude, -LATITUDE, LATITUDE)) * (math.pi / 360))) * (HALF / math.pi)
    return x, y


def degrees(x, y):
    """The longitude and latitude of a place in the plane."""
    return x * (180 / HALF), math.degrees(2 * math.atan(math.exp(y * (math.pi / HALF))) - math.pi / 2)


def tile(z, x, y):
    """A tile's left and top edges and its side, in metres of the plane."""
    span = 2 * HALF / 2**z
    return -HALF + x * span, HALF - y * span, span
