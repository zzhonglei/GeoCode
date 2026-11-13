"""What a dataset is, as the interface shows it before any tile: its kind, its layers or bands, and where on the map
it lies, or why it has no place there."""

import math
import os

from osgeo import gdal, ogr, osr

from geocodekit.preview import _raster, _source
from geocodekit.preview._mercator import LATITUDE

# What GDAL gives a raster that says nothing of where it lies.
NOWHERE = (0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
# Points taken along each edge of a rectangle to find what it covers in another coordinate system, where its edges
# are curves.
ALONG = 21


def _crs(srs):
    if srs is None:
        return None
    authority, code = srs.GetAuthorityName(None), srs.GetAuthorityCode(None)
    return {"name": srs.GetName(), "code": "%s:%s" % (authority, code) if authority and code else None}


def _number(value):
    """A value as JSON carries it; a raster often has NaN for where it has no data, which JSON has no word for."""
    return value if value is not None and math.isfinite(value) else None


def _geographic(west, south, east, north):
    """The part of the map the bounds cover, or why they cover none."""
    if not all(math.isfinite(value) for value in (west, south, east, north)):
        return {"unplaced": "unprojectable"}
    south, north = max(south, -LATITUDE), min(north, LATITUDE)
    if south >= north and abs(south) >= LATITUDE:
        return {"unplaced": "polar"}
    # In longitudes counted from 0 to 360, data wholly past 180 lies in the map's west, which shows longitudes from
    # -180 to 180. Data across the antimeridian comes back with its west past its east, and data in those longitudes
    # across 180 reaches past it: both reach round the map.
    if west >= 180:
        west, east = west - 360, east - 360
    if west > east or west < -180 or east > 180:
        west, east = -180.0, 180.0
    return {"bounds": [west, south, east, north]}


def _vector_place(layer, srs):
    if layer.GetGeomType() == ogr.wkbNone:
        return {"unplaced": "no-geometry"}
    if srs is None:
        return {"unplaced": "no-crs"}
    if srs.IsLocal():
        return {"unplaced": "local-crs"}
    extent = layer.GetExtent(force=1, can_return_null=1)
    if extent is None:
        return {"unplaced": "empty"}
    west, east, south, north = extent
    # GeoJSON is read as longitude and latitude whatever numbers it holds: its standard has no other coordinates, and
    # many a file has.
    if srs.IsGeographic() and (south < -90 or north > 90 or west < -360 or east > 360):
        return {"unplaced": "not-degrees"}
    target = osr.SpatialReference()
    target.ImportFromEPSG(4326)
    target.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    source = srs.Clone()
    source.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    try:
        bounds = osr.CoordinateTransformation(source, target).TransformBounds(west, south, east, north, ALONG)
    except RuntimeError:
        return {"unplaced": "unprojectable"}
    return _geographic(*bounds)


def _geometry(layer):
    kind = layer.GetGeomType()
    return None if kind == ogr.wkbNone else ogr.GeometryTypeToName(kind)


def _vector(layer):
    definition = layer.GetLayerDefn()
    srs = layer.GetSpatialRef()
    described = {
        "kind": "vector",
        "features": layer.GetFeatureCount(),
        "geometry": _geometry(layer),
        "fields": [
            {"name": field.GetName(), "type": field.GetFieldTypeName(field.GetType())}
            for field in (definition.GetFieldDefn(index) for index in range(definition.GetFieldCount()))
        ],
        "crs": _crs(srs),
    }
    if ogr.GT_Flatten(layer.GetGeomType()) in (ogr.wkbUnknown, ogr.wkbGeometryCollection):
        # The layer's type does not say which of points, lines and polygons its features are, and the three are shown
        # or hidden apart. The reader counts them once it has read the layer.
        described["forms"] = None
    described.update(_vector_place(layer, srs))
    return described


def _raster_place(dataset, srs):
    placed = dataset.GetGeoTransform(can_return_null=True)
    if (placed is None or tuple(placed) == NOWHERE) and dataset.GetGCPCount() == 0:
        return {"unplaced": "no-georeference"}
    if srs is None:
        return {"unplaced": "no-crs"}
    if srs.IsLocal():
        return {"unplaced": "local-crs"}
    width, height = dataset.RasterXSize, dataset.RasterYSize
    steps = [index / (ALONG - 1) for index in range(ALONG)]
    edge = (
        [(step * width, 0) for step in steps]
        + [(step * width, height) for step in steps]
        + [(0, step * height) for step in steps]
        + [(width, step * height) for step in steps]
    )
    try:
        transformer = gdal.Transformer(dataset, None, ["DST_SRS=EPSG:4326"])
        points, reached = transformer.TransformPoints(0, edge)
    except RuntimeError:
        return {"unplaced": "unprojectable"}
    known = [point for point, ok in zip(points, reached) if ok]
    if not known:
        return {"unplaced": "unprojectable"}
    longitudes, latitudes = [point[0] for point in known], [point[1] for point in known]
    # A projected raster round a pole holds it within its edges, which come no nearer to it; and all longitudes meet
    # there. A raster in longitudes and latitudes that reaches a pole has its edge along it.
    for pole in () if srs.IsGeographic() else (90.0, -90.0):
        reached, (column, row, _) = transformer.TransformPoint(1, 0.0, pole)
        if reached and 0 <= column <= width and 0 <= row <= height:
            longitudes += [-180.0, 180.0]
            latitudes.append(pole)
    return _geographic(min(longitudes), min(latitudes), max(longitudes), max(latitudes))


def _raster_described(dataset):
    bands = [dataset.GetRasterBand(index) for index in range(1, dataset.RasterCount + 1)]
    srs = dataset.GetSpatialRef() or dataset.GetGCPSpatialRef()
    described = {
        "kind": "raster",
        "width": dataset.RasterXSize,
        "height": dataset.RasterYSize,
        "bands": [
            {
                "type": gdal.GetDataTypeName(band.DataType),
                "color": gdal.GetColorInterpretationName(band.GetColorInterpretation()),
                "nodata": _number(band.GetNoDataValue()),
            }
            for band in bands
        ],
        "shown": _raster.shown(dataset),
        "overviews": bands[0].GetOverviewCount(),
        "crs": _crs(srs),
    }
    described.update(_raster_place(dataset, srs))
    if "bounds" in described:
        described["resolution"] = _raster.native(dataset)
    return described


def _rasters(dataset):
    """The rasters a dataset holds, each by its name and by the table it is opened as: a GeoPackage may hold several,
    which GDAL lists in place of bands; any other file holds the one it opens as, and so does a GeoPackage of one."""
    if dataset is None:
        return []
    if dataset.RasterCount > 0:
        return [(dataset.GetMetadataItem("IDENTIFIER") or os.path.basename(dataset.GetDescription()), None)]
    if dataset.GetDriver().ShortName != "GPKG":
        return []
    tables = [name.rsplit(":", 1)[1] for name, _ in dataset.GetSubDatasets()]
    return [(table, table) for table in tables]


def describe(path, layer=None):
    """The description of one layer of the dataset at `path`, with the layers it holds, and the files it is made of.
    A layer is a vector layer or a raster, and a GeoPackage may hold several of both. Asked for none, the first vector
    layer that can be drawn is described, a raster where there is none."""
    if not os.path.exists(path):
        raise _source.Unshown("missing")
    vector = _source.opened(path, gdal.OF_VECTOR)
    raster = _source.opened(path, gdal.OF_RASTER)
    tables = [] if vector is None else [vector.GetLayer(index) for index in range(vector.GetLayerCount())]
    rasters = _rasters(raster)
    if not tables and not rasters:
        if raster is not None and raster.GetSubDatasets():
            raise _source.Unshown("subdatasets")
        raise _source.Unshown("unopenable", gdal.GetLastErrorMsg())
    if layer is None:
        drawn = next((table.GetName() for table in tables if table.GetGeomType() != ogr.wkbNone), None)
        # A file of tables alone still shows its first.
        layer = drawn or (rasters[0][0] if rasters else tables[0].GetName())
    table = next((table for table in tables if table.GetName() == layer), None)
    if table is not None:
        source, described = vector, _vector(table)
    else:
        found = next((found for found in rasters if found[0] == layer), None)
        if found is None:
            raise _source.Unshown("no-layer", layer)
        source = raster if found[1] is None else _source.opened(path, gdal.OF_RASTER, found[1])
        if source is None:
            raise _source.Unshown("unopenable", gdal.GetLastErrorMsg())
        described = _raster_described(source)
        # What the raster's tiles open it as.
        described["table"] = found[1]
    described["layer"] = layer
    described["layers"] = [
        {"name": table.GetName(), "kind": "vector", "geometry": _geometry(table)} for table in tables
    ] + [{"name": name, "kind": "raster", "geometry": None} for name, _ in rasters]
    return described, _source.files(source, path)
