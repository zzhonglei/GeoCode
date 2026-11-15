"""What a page in the chat reads of a dataset to draw a map of it as it likes: a vector layer as GeoJSON with the fields
it names, and a raster's values on a grid of the map's plane. The preview's tiles serve neither: they carry no
attributes, merge a tile's features into one, and come coloured already."""

import numpy
from osgeo import gdal

from geocodekit.preview import _mercator, _source

# The most either may weigh, under the most one answer of a reader may (FRAME_LIMIT in geoengine/src/runtime.ts):
# past that, GeoEngine ends the reader rather than take the answer.
LIMIT = 32 * 1024 * 1024
# As many features as are worth turning into GeoJSON at all: a layer with more outweighs the limit long before.
FEATURES = 500000
# The longer side, in pixels, of a raster's grid: as much as a reply shows. A raster with fewer is not enlarged.
SIDE = 2048


def _drawable(described, chosen, kind):
    """Refuses a layer the page cannot draw as `kind`. A file of several layers needs one named: the first, as the
    preview takes it, may not be the one the page means."""
    if not chosen and len(described["layers"]) > 1:
        held = ", ".join("%s (%s)" % (layer["name"], layer["kind"]) for layer in described["layers"])
        raise _source.Unshown("layers", "the file holds several layers; name one as layer: %s" % held)
    if described["kind"] != kind:
        other = "geocode.raster" if kind == "vector" else "geocode.vector"
        raise _source.Unshown("kind", "%s is a %s layer; use %s" % (described["layer"], described["kind"], other))
    if "unplaced" in described:
        raise _source.Unshown(described["unplaced"])


def features(path, described, chosen, fields, cancelled, number):
    """The layer as GeoJSON bytes: longitudes and latitudes, each feature with its number in the layer as its id and
    only `fields` of its attributes."""
    _drawable(described, chosen, "vector")
    names = [field["name"] for field in described["fields"]]
    unknown = [field for field in fields if field not in names]
    if unknown:
        raise _source.Unshown(
            "fields", "no field %s; the fields are: %s" % (", ".join(unknown), ", ".join(names) or "none")
        )
    if described["features"] > FEATURES:
        raise _source.Unshown(
            "too-large", "%d features; at most %d can be drawn this way" % (described["features"], FEATURES)
        )
    dataset = _source.opened(path, gdal.OF_VECTOR)
    if dataset is None:
        raise _source.Unshown("unopenable", gdal.GetLastErrorMsg())
    target = "/vsimem/geocode-features-%d.geojson" % number
    over = []

    # Stopped once it outweighs the limit, which a layer of many large features does long before it is whole.
    def going(*_):
        written = gdal.VSIStatL(target)
        if written is not None and written.size > LIMIT:
            over.append(written.size)
        return 0 if cancelled() or over else 1

    try:
        gdal.VectorTranslate(
            target,
            dataset,
            format="GeoJSON",
            layers=[described["layer"]],
            selectFields=list(fields),
            preserveFID=True,
            dim="XY",
            dstSRS="EPSG:4326",
            layerCreationOptions=["RFC7946=YES"],
            callback=going,
        )
    except RuntimeError as error:
        # A callback that stops GDAL makes it raise as well.
        if cancelled():
            raise _source.Cancelled()
        if not over:
            raise _source.Unshown("unopenable", str(error))
    finally:
        dataset = None
    try:
        size = gdal.VSIStatL(target).size
        if over or size > LIMIT:
            raise _source.Unshown("too-large", "more than %d MB as GeoJSON" % (LIMIT >> 20))
        handle = gdal.VSIFOpenL(target, "rb")
        try:
            return gdal.VSIFReadL(1, size, handle)
        finally:
            gdal.VSIFCloseL(handle)
    finally:
        gdal.Unlink(target)


def _palette(band, grid):
    """The colour of each value the grid holds, where the band has a colour table: a band of classes. A table lists
    every value its type can hold, most of them unused."""
    table = band.GetColorTable()
    if table is None:
        return None
    held = grid.ReadAsArray()
    colours = {}
    for value in numpy.unique(held[~numpy.isnan(held)]).astype(numpy.int64).tolist():
        if 0 <= value < table.GetCount():
            red, green, blue, alpha = table.GetColorEntry(value)
            if alpha:
                colours[str(value)] = "#%02x%02x%02x" % (red, green, blue)
    return colours


def grid(opened, described, chosen, bands, cancelled):
    """The header and the bytes of the values of `bands`, numbered from one, on a grid of the map's plane: each band's
    values as 32-bit floats, row by row, one band after another, with no data as NaN. `opened` gives the dataset to
    read, through the preview's overviews where the raster has none of its own; it is asked for only once the layer
    and the bands are known to be drawable, as making overviews takes long."""
    _drawable(described, chosen, "raster")
    count = len(described["bands"])
    if not bands or any(not 1 <= band <= count for band in bands):
        raise _source.Unshown("bands", "the raster has %d band%s, numbered from 1" % (count, "" if count == 1 else "s"))
    dataset = opened()

    def going(*_):
        return 0 if cancelled() else 1

    try:
        # Where the raster lies on the plane, at its own resolution; the plane ends short of the poles, and a raster
        # that reaches them, or runs from 0 to 360 degrees, is planned past its edges.
        plan = gdal.Warp("", dataset, format="VRT", dstSRS="EPSG:3857")
        width, height = plan.RasterXSize, plan.RasterYSize
        left, step_x, _, top, _, step_y = plan.GetGeoTransform()
        right, bottom = left + width * step_x, top + height * step_y
        plan = None
        half = _mercator.HALF
        edges = (max(left, -half), max(bottom, -half), min(right, half), min(top, half))
        # A raster round the whole earth is planned a little short of it when it runs from 0 to 360 degrees.
        if edges[2] - edges[0] > 1.98 * half:
            edges = (-half, edges[1], half, edges[3])
        if edges != (left, bottom, right, top):
            # Sized by the part of the plane it covers: what the plan made of a raster past its edges is no guide.
            across, down = edges[2] - edges[0], edges[3] - edges[1]
            width, height = (SIDE, SIDE * down / across) if across >= down else (SIDE * across / down, SIDE)
            left, bottom, right, top = edges
        scale = min(1.0, SIDE / max(width, height), (LIMIT / (4 * len(bands)) / (width * height)) ** 0.5)
        width, height = max(1, round(width * scale)), max(1, round(height * scale))
        # Whole numbers are mostly classes or counts, which an average would turn into values the raster never has.
        whole = all(described["bands"][band - 1]["type"].startswith(("Byte", "Int", "UInt")) for band in bands)
        drawn = gdal.Warp(
            "",
            dataset,
            format="MEM",
            dstSRS="EPSG:3857",
            outputBounds=(left, bottom, right, top),
            width=width,
            height=height,
            srcBands=list(bands),
            outputType=gdal.GDT_Float32,
            dstNodata=float("nan"),
            resampleAlg="near" if whole else "average",
            multithread=True,
            callback=going,
        )
    except RuntimeError as error:
        if cancelled():
            raise _source.Cancelled()
        raise _source.Unshown("unopenable", str(error))
    data = b"".join(drawn.GetRasterBand(index).ReadRaster() for index in range(1, len(bands) + 1))
    corners = [(left, top), (right, top), (right, bottom), (left, bottom)]
    header = {
        "width": width,
        "height": height,
        "bands": len(bands),
        "coordinates": [list(_mercator.degrees(x, y)) for x, y in corners],
    }
    palette = _palette(dataset.GetRasterBand(bands[0]), drawn.GetRasterBand(1)) if len(bands) == 1 else None
    if palette:
        header["palette"] = palette
    return header, data
