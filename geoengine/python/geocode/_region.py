"""Reading the study region from a local vector file."""

import os

import ee

# Every request that uses the region carries all its vertices, and grows slower with them.
MOST_VERTICES = 10000
# WGS84's and GRS80's semi-major axis: a datum on another ellipsoid is converted here, as QGIS converts it, since
# Earth Engine's own conversion of such datums differs from QGIS's by meters to tens of meters.
MODERN_AXIS = 6378137.0
# The longest edge of a region sent in lon/lat, in the file's units (degrees or not): one straight there strays well
# under a meter from the file's.
STEP = {False: 5000.0, True: 0.05}


def region(path, layer=None):
    """Reads the one polygon of a local vector file as the study region, an ee.Geometry whose edges are straight in the
    file's coordinate system, as a GIS draws them. "layer" names the layer of a file that holds several."""
    import geopandas
    import shapely
    import shapely.ops
    from pyproj import Geod, Transformer
    from shapely.geometry import mapping

    file = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(file):
        raise FileNotFoundError("There is no file %s." % file)
    name = os.path.basename(file)
    if layer is None:
        layers = list(geopandas.list_layers(file)["name"])
        if len(layers) > 1:
            raise ValueError(
                '%s has %d layers: %s. Name one with layer="...".' % (name, len(layers), ", ".join(layers))
            )
    frame = geopandas.read_file(file, layer=layer)
    if frame.crs is None:
        raise ValueError(
            "%s has no coordinate system. Assign the one its coordinates are in with QGIS's native:assignprojection,"
            " then read the output." % name
        )
    if len(frame) != 1:
        raise ValueError(
            "%s has %d features; a region is one polygon. In QGIS, keep the one wanted with"
            " native:extractbyattribute, or merge them with native:dissolve, first." % (name, len(frame))
        )
    geometry = frame.geometry.iloc[0]
    if geometry is None or geometry.is_empty:
        raise ValueError("The feature in %s has no geometry." % name)
    if geometry.geom_type not in ("Polygon", "MultiPolygon"):
        raise ValueError("The feature in %s is a %s; a region is a polygon." % (name, geometry.geom_type))
    if not geometry.is_valid:
        raise ValueError(
            "The polygon in %s is invalid: %s. Repair it in QGIS with native:fixgeometries first."
            % (name, shapely.is_valid_reason(geometry))
        )
    vertices = shapely.get_num_coordinates(geometry)
    if vertices > MOST_VERTICES:
        raise ValueError(
            "The polygon in %s has %d vertices; a region has at most %d, since every request that uses it carries all"
            " of them. Simplify it in QGIS with native:simplifygeometries first." % (name, vertices, MOST_VERTICES)
        )
    geometry = shapely.force_2d(geometry)
    crs = frame.crs.to_2d()
    base = crs.source_crs if crs.is_bound else crs
    code = crs.to_epsg(min_confidence=100)
    degrees = crs.is_geographic
    modern = crs.ellipsoid.semi_major_metre == MODERN_AXIS

    to_lonlat = Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform
    text = "EPSG:%d" % code if code else wkt1(crs)
    warning = None
    if modern and text:
        shape = geometry
    else:
        # An older datum, or a system Earth Engine cannot read: in lon/lat as QGIS converts each point, with points
        # close enough together to keep the file's straight edges.
        dense = shapely.segmentize(geometry, STEP[degrees])
        shape = unwrapped(shapely.ops.transform(to_lonlat, dense))
        text = "EPSG:4326"
        points = shapely.get_coordinates(dense)
        own = Transformer.from_crs(crs, crs.geodetic_crs, always_xy=True).transform(points[:, 0], points[:, 1])
        converted = to_lonlat(points[:, 0], points[:, 1])
        unshifted = Geod(ellps="WGS84").inv(own[0], own[1], converted[0], converted[1])[2] < 0.01
        if not modern and unshifted.any():
            whole = unshifted.all()
            part, which = ("", "its coordinates") if whole else (" for part of the region", "the coordinates there")
            warning = (
                "Warning: no transformation from the datum %s to WGS84 is available%s, so %s were taken as WGS84 ones."
                % (base.datum.name, part, which)
            )

    read = name if layer is None else "%s, layer %s" % (name, layer)
    if code:
        print("Region %s: EPSG:%d, %s." % (read, code, crs.name))
    else:
        kind = base.name
        if kind == "unknown":
            kind = "lon/lat on %s" % base.ellipsoid.name if degrees else base.coordinate_operation.method_name
        print("Region %s: %s, without an EPSG code." % (read, kind))
    if warning:
        print(warning)
    return ee.Geometry(mapping(shape), text, False)


def wkt1(crs):
    """The system as WKT1, the only text Earth Engine reads besides EPSG codes, or None for one WKT1 cannot hold."""
    from pyproj.exceptions import CRSError

    try:
        return crs.to_wkt("WKT1_GDAL")
    except CRSError:
        return None


def unwrapped(lonlat):
    """The polygon with each ring's longitudes running on past 180 where it crosses there, as Earth Engine reads a ring
    across the antimeridian, and its holes beside it."""
    import numpy
    import shapely

    def ring(coords, near=None):
        points = numpy.array(coords)
        points[:, 0] = numpy.unwrap(points[:, 0], period=360)
        if near is not None:
            points[:, 0] += 360 * round((near - points[0, 0]) / 360)
        return points

    def polygon(part):
        shell = ring(part.exterior.coords)
        return shapely.Polygon(shell, [ring(hole.coords, shell[0, 0]) for hole in part.interiors])

    if lonlat.geom_type == "Polygon":
        return polygon(lonlat)
    return shapely.MultiPolygon([polygon(part) for part in lonlat.geoms])
