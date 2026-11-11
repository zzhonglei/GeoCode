"""A raster's tiles: the part of it under a tile of the map, drawn as an image."""

import uuid

import numpy
from osgeo import gdal, osr

from geocodekit.preview import _mercator, _source

# An image's side in pixels: twice what a tile takes on the map, for displays of twice the density.
SIZE = 512
QUALITY = 85
# The longer side of the sample a band's range is found in.
SAMPLE = 512
# The share of a band's values left out at each end of its range, as QGIS draws a raster by default.
CUT = (2, 98)


def shown(dataset):
    """The bands drawn, numbered from one: red, green and blue where the bands say which they are, else the first
    three, or the first alone."""
    count = dataset.RasterCount
    if count < 3:
        return [1]
    said = {dataset.GetRasterBand(index).GetColorInterpretation(): index for index in range(count, 0, -1)}
    colours = [said.get(gdal.GCI_RedBand), said.get(gdal.GCI_GreenBand), said.get(gdal.GCI_BlueBand)]
    return colours if all(colours) else [1, 2, 3]


def _range(band):
    """The values a band is drawn between, from a sample of it; GDAL reads the sample from an overview when one fits."""
    scale = max(band.XSize, band.YSize) / SAMPLE
    width, height = max(1, round(band.XSize / scale)), max(1, round(band.YSize / scale))
    if scale <= 1:
        width, height = band.XSize, band.YSize
    values = band.ReadAsArray(buf_xsize=width, buf_ysize=height)
    valid = band.GetMaskBand().ReadAsArray(buf_xsize=width, buf_ysize=height) != 0
    if numpy.iscomplexobj(values):
        values = numpy.abs(values)
    values = values[valid & numpy.isfinite(values)]
    if values.size == 0:
        return 0.0, 1.0
    low, high = (float(value) for value in numpy.percentile(values, CUT))
    if high <= low:
        low, high = float(values.min()), float(values.max())
    return (low, high) if high > low else (low, low + 1.0)


class Look:
    """How a raster is drawn, worked out once: which bands, between which values, or through which colour table."""

    def __init__(self, dataset):
        self.bands = shown(dataset)
        bands = [dataset.GetRasterBand(index) for index in self.bands]
        table = bands[0].GetColorTable() if len(bands) == 1 else None
        self.palette = (
            None
            if table is None
            else numpy.array([table.GetColorEntry(index) for index in range(table.GetCount())], dtype=numpy.uint8)
        )
        # Three bands of bytes are a picture, drawn as it is.
        picture = len(bands) == 3 and all(band.DataType == gdal.GDT_Byte for band in bands)
        as_it_is = self.palette is not None or picture
        self.ranges = None if as_it_is else [_range(band) for band in bands]
        self.native = _native(dataset)


def _native(dataset):
    """The side of the raster's pixels in metres of the map's plane, or None where that cannot be said."""
    plane = osr.SpatialReference()
    plane.ImportFromEPSG(3857)
    try:
        warped = gdal.AutoCreateWarpedVRT(dataset, None, plane.ExportToWkt())
    except RuntimeError:
        return None
    return None if warped is None else abs(warped.GetGeoTransform()[1])


def _encoded(image, lossless):
    """A picture of four bands of bytes, as WebP."""
    held = gdal.GetDriverByName("MEM").Create("", image.shape[2], image.shape[1], 4, gdal.GDT_Byte)
    held.WriteArray(image)
    name = "/vsimem/geocode-preview-%s.webp" % uuid.uuid4().hex
    options = ["LOSSLESS=YES"] if lossless else ["QUALITY=%d" % QUALITY]
    gdal.GetDriverByName("WEBP").CreateCopy(name, held, options=options)
    try:
        file = gdal.VSIFOpenL(name, "rb")
        try:
            return bytes(gdal.VSIFReadL(1, gdal.VSIStatL(name).size, file))
        finally:
            gdal.VSIFCloseL(file)
    finally:
        gdal.Unlink(name)


def tile(dataset, look, z, x, y, cancelled):
    """The image of the tile, or None where the raster has nothing under it."""
    left, top, span = _mercator.tile(z, x, y)
    # Closer than the raster's own pixels, they are shown as the squares they are; a colour table's entries are never
    # mixed.
    nearest = look.palette is not None or (look.native is not None and span / SIZE < look.native)
    try:
        warped = gdal.Warp(
            "",
            dataset,
            format="MEM",
            dstSRS="EPSG:3857",
            outputBounds=(left, top - span, left + span, top),
            width=SIZE,
            height=SIZE,
            srcBands=look.bands,
            dstAlpha=True,
            resampleAlg="near" if nearest else "bilinear",
            callback=lambda *_: 0 if cancelled() else 1,
        )
    except RuntimeError:
        if cancelled():
            raise _source.Cancelled()
        raise
    values = warped.ReadAsArray()
    drawn = values[-1] != 0
    values = values[:-1]
    if numpy.iscomplexobj(values):
        values = numpy.abs(values)
    if values.dtype.kind == "f":
        drawn &= numpy.isfinite(values).all(axis=0)
    if not drawn.any():
        return None
    image = numpy.empty((4, SIZE, SIZE), dtype=numpy.uint8)
    if look.palette is not None:
        entries = look.palette[numpy.clip(values[0].astype(numpy.int64), 0, len(look.palette) - 1)]
        image[:] = numpy.moveaxis(entries, -1, 0)
        image[3] = numpy.where(drawn, image[3], 0)
        return _encoded(image, True)
    for index in range(3):
        band = values[min(index, values.shape[0] - 1)]
        if look.ranges is None:
            image[index] = band
            continue
        low, high = look.ranges[min(index, len(look.ranges) - 1)]
        with numpy.errstate(invalid="ignore"):
            image[index] = numpy.clip((band - low) * (255.0 / (high - low)), 0, 255)
    image[3] = numpy.where(drawn, 255, 0)
    return _encoded(image, False)
