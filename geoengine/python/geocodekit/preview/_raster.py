"""A raster's tiles: the part of it under a tile of the map, drawn as an image."""

import colorsys
import math
import uuid

import numpy
from osgeo import gdal

from geocodekit.preview import _mercator, _source

# An image's side in pixels: twice what a tile takes on the map, for displays of twice the density.
SIZE = 512
QUALITY = 85
# The longer side of the sample a band's range is found in.
SAMPLE = 512
# As many bytes as are read at once for the samples of several bands together.
TOGETHER = 128 * 1024 * 1024
# The fewest rows read at once for them.
STRIP = 64
# The share of a band's values left out at each end of its range, as QGIS draws a raster by default; the interface
# names the range by them in desktop/packages/ui/src/geocode/preview/previewText.ts.
CUT = (2, 98)
# As many steps as a band's histogram has, from its least value to its greatest; of a band of whole numbers, as many
# as there are values between when they are fewer.
BINS = 256
# As many different values as a band of whole numbers may have and be taken for classes, each drawn in a colour of its
# own, when it brings no colour table: land cover, a mask, zones. More are taken for measurements.
CLASSES = 64
# As many pixels as are counted one by one for the classes, which takes a moment: those of a raster that is drawn
# without overviews. Of a larger raster a sample is counted, and may leave out the rarest classes.
COUNTED = 8192 * 8192
# The places a band is looked at in its own pixels to tell whether it is one of classes, each this many pixels a
# side, by where along the band's width and height they lie.
PLACES = ((0.5, 0.5), (0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75))
PLACE = 512
# The share of a band's sample that one value at either end of its values may take, in a band that says nothing of
# where it has no data, before it is told as what may be a border of no data the file does not declare: a scene
# exported or cut out with its edge filled with nothing but 0 has a quarter of its pixels and more of it.
SUSPECT = 0.05
# The colour of a value that was met in no count of the classes.
UNCOUNTED = (128, 128, 128, 255)
# The pixels read at a time to count them.
CHUNK = 16000000
WHOLE = (gdal.GDT_Byte, gdal.GDT_Int8, gdal.GDT_UInt16, gdal.GDT_Int16, gdal.GDT_UInt32, gdal.GDT_Int32)
# The name the interface asks for a band's classes by, where it would name a ramp; the interface has it as BY_CLASS in
# desktop/packages/ui/src/geocode/preview/previewClient.ts.
BY_CLASS = "classes"

# What one band may be coloured through, each by the colours it passes from its low end to its high, evenly apart.
# The interface draws them from here, so the colours of its legend are those of the map.
RAMPS = {
    "grey": ["#000000", "#ffffff"],
    "terrain": ["#2b6654", "#429961", "#8cc273", "#e3de8c", "#f2b866", "#cc854d", "#9e6147", "#f7f7f7"],
    "viridis": ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
    "magma": ["#000004", "#3b0f70", "#8c2981", "#de4968", "#fe9f6d", "#fcfdbf"],
    "spectral": ["#5e4fa2", "#66c2a5", "#e6f598", "#fee08b", "#f46d43", "#9e0142"],
    "rdylgn": ["#d73027", "#fdae61", "#ffffbf", "#a6d96a", "#1a9850"],
    "blues": ["#f7fbff", "#c6dbef", "#6baed6", "#2171b5", "#08306b"],
}


def _ramp(name):
    """A ramp as 256 colours, one for each step a band's values are drawn in. The interface works out the colour of a
    clicked pixel the same way, as `drawnColour` in desktop/packages/ui/src/geocode/preview/rasterLook.ts: a change
    here is made there too."""
    stops = numpy.array([[int(colour[at : at + 2], 16) for at in (1, 3, 5)] for colour in RAMPS[name]], dtype=float)
    along = numpy.linspace(0, len(stops) - 1, 256)
    return numpy.stack([numpy.interp(along, numpy.arange(len(stops)), stops[:, part]) for part in range(3)]).round()


def shown(dataset):
    """The bands drawn, numbered from one: red, green and blue where the bands say which they are, else the first
    three, or the first alone."""
    count = dataset.RasterCount
    if count < 3:
        return [1]
    said = {dataset.GetRasterBand(index).GetColorInterpretation(): index for index in range(count, 0, -1)}
    colours = [said.get(gdal.GCI_RedBand), said.get(gdal.GCI_GreenBand), said.get(gdal.GCI_BlueBand)]
    return colours if all(colours) else [1, 2, 3]


def _sampled(band):
    """The width and the height of the sample of a band."""
    scale = max(band.XSize, band.YSize) / SAMPLE
    if scale <= 1:
        return band.XSize, band.YSize
    return max(1, round(band.XSize / scale)), max(1, round(band.YSize / scale))


def _sample(band, blank=None):
    """The values of a sample of a band that are data, and not `blank`, a value the interface takes for no data
    besides the band's own; GDAL reads the sample from an overview when one fits."""
    width, height = _sampled(band)
    values = band.ReadAsArray(buf_xsize=width, buf_ysize=height)
    valid = band.GetMaskBand().ReadAsArray(buf_xsize=width, buf_ysize=height) != 0
    if numpy.iscomplexobj(values):
        values = numpy.abs(values)
    values = values[valid & numpy.isfinite(values)]
    return values if blank is None else values[values != blank]


def _thinned(read, height, rows, every):
    """Every `every`th pixel each way of a raster `height` rows high, of which `read(top, count)` reads `count` rows
    from row `top`, the rows second to last in what it gives; read a strip of `rows` rows at a time."""
    kept = []
    for top in range(0, height, rows):
        count = min(rows, height - top)
        kept.append(read(top, count)[..., (-top) % every :: every, ::every])
    return numpy.concatenate(kept, axis=-2)


def _samples(dataset, indices, blank=None):
    """A sample of each of the bands of these numbers, as `_sample` gives one, read several bands at a time: of a
    file that keeps the bands of a pixel together, each band read alone is the whole file read, and so is each band
    of several read reduced at once, which GDAL reads band by band. Where there are no overviews to read a reduced
    raster from, the raster's own pixels are read, in strips, and thinned."""
    first = dataset.GetRasterBand(1)
    width, height = _sampled(first)
    every = math.ceil(max(first.XSize, first.YSize) / SAMPLE)
    thin = every > 1 and first.GetOverviewCount() == 0
    rows = max(STRIP, first.GetBlockSize()[1])
    size = gdal.GetDataTypeSizeBytes(first.DataType)
    # Of the strips, where those are read: a strip of all the bands at once is the file read once.
    held = first.XSize * rows * size if thin else width * height * size
    at_once = max(1, TOGETHER // max(1, held))
    # The mask of all the bands, read once for them all.
    shared = None
    for start in range(0, len(indices), at_once):
        chosen = indices[start : start + at_once]
        if thin:
            read = _thinned(
                lambda top, count: dataset.ReadAsArray(0, top, first.XSize, count, band_list=chosen).reshape(
                    (len(chosen), count, first.XSize)
                ),
                first.YSize,
                rows,
                every,
            )
        else:
            read = dataset.ReadAsArray(buf_xsize=width, buf_ysize=height, band_list=chosen)
            read = read.reshape((len(chosen), height, width))
        for index, values in zip(chosen, read):
            band = dataset.GetRasterBand(index)
            if numpy.iscomplexobj(values):
                values = numpy.abs(values)
            valid = numpy.isfinite(values)
            # What it has no data by, without its mask read where that is the band itself read again.
            flags, nodata = band.GetMaskFlags(), band.GetNoDataValue()
            if flags & gdal.GMF_NODATA and nodata is not None:
                valid &= values != nodata
            elif not flags & gdal.GMF_ALL_VALID:
                mask = band.GetMaskBand()
                if flags & gdal.GMF_PER_DATASET and shared is not None:
                    read_mask = shared
                elif thin:
                    read_mask = _thinned(
                        lambda top, count: mask.ReadAsArray(0, top, mask.XSize, count), mask.YSize, rows, every
                    )
                else:
                    read_mask = mask.ReadAsArray(buf_xsize=width, buf_ysize=height)
                if flags & gdal.GMF_PER_DATASET:
                    shared = read_mask
                valid &= read_mask != 0
            if blank is not None:
                valid &= values != blank
            yield index, values[valid]


def of_classes(band):
    """Whether a band looks to be one of classes, from a few places of it in its own pixels: asked before the band
    has overviews, which must not mix its classes, and when a sample of the whole of it would read all of it."""
    if band.GetColorTable() is not None:
        return True
    if band.DataType not in WHOLE:
        return False
    found = set()
    width, height = min(PLACE, band.XSize), min(PLACE, band.YSize)
    for across, down in PLACES:
        left, top = int((band.XSize - width) * across), int((band.YSize - height) * down)
        found.update(numpy.unique(band.ReadAsArray(left, top, width, height)).tolist())
    return len(found) <= CLASSES


def _counted(band, sure):
    """Every value of a band of whole numbers with how many of its pixels have it, and whether that is of a sample
    only; None for a band that is not one of classes. `sure` says that it is one however many values it has, as a
    band with a colour table is."""
    if band.DataType not in WHOLE:
        return None
    values, counts = numpy.unique(_sample(band), return_counts=True)
    if not sure and values.size > CLASSES:
        return None
    if band.XSize * band.YSize > COUNTED:
        return values, counts, True
    if band.DataType == gdal.GDT_Byte:
        counts = numpy.array(band.GetHistogram(-0.5, 255.5, 256, 0, 0), dtype=numpy.int64)
        return numpy.flatnonzero(counts), counts[counts > 0], False
    found = {}
    rows = max(1, CHUNK // band.XSize)
    mask = band.GetMaskBand()
    for top in range(0, band.YSize, rows):
        height = min(rows, band.YSize - top)
        part = band.ReadAsArray(0, top, band.XSize, height)
        part = part[mask.ReadAsArray(0, top, band.XSize, height) != 0]
        for value, count in zip(*numpy.unique(part, return_counts=True)):
            found[int(value)] = found.get(int(value), 0) + int(count)
        if not sure and len(found) > CLASSES:
            return None
    values = numpy.array(sorted(found), dtype=numpy.int64)
    return values, numpy.array([found[int(value)] for value in values], dtype=numpy.int64), False


def _distinct(count):
    """As many colours as told apart as that many can be, for classes that bring none: each a turn of the golden angle
    on from the one before, so that neighbours differ most."""
    colours = numpy.empty((count, 4), dtype=numpy.uint8)
    for index in range(count):
        hue = (0.58 + index * 0.6180339887) % 1.0
        red, green, blue = colorsys.hsv_to_rgb(hue, (0.62, 0.45, 0.78)[index % 3], (0.82, 0.92, 0.66)[index % 3])
        colours[index] = (round(red * 255), round(green * 255), round(blue * 255), 255)
    return colours


def _measured(band, blank=None):
    """What a sample of a band says of its values: their least and greatest, mean and deviation, the values that
    leave out CUT of them at each end, how many fall into each step of its histogram and the values the steps run
    from and to, its `edges`, the share of them that the least and the greatest each are, and the values the band is
    drawn `between` when the interface names none. None of a band without data. Of the values that are not `blank`,
    where the interface takes it for no data besides the band's own."""
    return _measure(_sample(band, blank))


def _measure(sample):
    """As `_measured`, of the sample of a band."""
    values = sample.astype(numpy.float64)
    if values.size == 0:
        return None
    least, most = float(values.min()), float(values.max())
    low, high = (float(value) for value in numpy.percentile(values, CUT))
    if sample.dtype.kind in "iu":
        # Steps of as many whole numbers each, from half below the least: steps that held one value and two in turn,
        # as 256 even steps over 147 values do, would draw the histogram as the teeth of a comb.
        width = math.ceil((most - least + 1) / BINS)
        steps = math.ceil((most - least + 1) / width)
        edges = (least - 0.5, least - 0.5 + steps * width)
    else:
        steps, edges = BINS, (least, most if most > least else least + 1.0)
    counts = numpy.histogram(values, bins=steps, range=edges)[0]
    between = (low, high) if high > low else (least, most)
    return {
        "between": list(between if between[1] > between[0] else (least, least + 1.0)),
        "min": least,
        "max": most,
        "mean": float(values.mean()),
        "std": float(values.std()),
        "low": low,
        "high": high,
        "counts": counts.tolist(),
        "edges": list(edges),
        "ends": [float(numpy.count_nonzero(values == end) / values.size) for end in (least, most)],
    }


class Look:
    """What is worked out once of how a raster is drawn: the bands, the values they are drawn between or the colour
    table they are drawn through when the interface does not say, and what is measured of each band. How one band is
    drawn when the interface does not say is told there as well, by `bandLook` in
    desktop/packages/ui/src/geocode/preview/rasterLook.ts: a change to it here is made there too."""

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
        self._as_it_is = self.palette is not None or picture
        # The classes of one band of whole numbers: their values in order, their colours, how many pixels each has,
        # and whether that was counted in a sample. Drawn by them unless the interface asks for a ramp. The colours
        # are the colour table's where the band brings one, by which its tiles are then drawn.
        self.classes = None
        counted = _counted(bands[0], self.palette is not None) if len(bands) == 1 else None
        if counted is not None and counted[0].size:
            values, counts, sampled = counted
            if self.palette is None:
                colours = _distinct(values.size)
            else:
                colours = self.palette[numpy.clip(values, 0, len(self.palette) - 1)]
            self.classes = (values.astype(numpy.int64), colours, counts, sampled)
        # By the band's number and the value taken for no data besides its own, None for none. Those of the bands drawn
        # are measured now, the rest when the interface asks.
        self._measured = {}
        self.ranges = self.ranges_of(dataset, None)
        self.native = native(dataset)

    def measured(self, dataset, index, blank=None):
        if (index, blank) not in self._measured:
            self._measured[(index, blank)] = _measured(dataset.GetRasterBand(index), blank)
        return self._measured[(index, blank)]

    def ranges_of(self, dataset, blank):
        """The values the bands drawn are drawn between when the interface does not say, measured without `blank`;
        None for a raster drawn as it is."""
        if self._as_it_is:
            return None
        measured = [self.measured(dataset, index, blank) for index in self.bands]
        return [each["between"] if each else [0.0, 1.0] for each in measured]

    def _suspect(self, dataset):
        """A value that may be a border of no data the file does not declare: at the same end of the values of each
        band drawn that says nothing of where it has no data, and as much as SUSPECT of each. Only told, never taken
        for no data unasked: 0 is as often a value as any, the sea's height or a class."""
        found = None
        for index in self.bands:
            band = dataset.GetRasterBand(index)
            measured = self.measured(dataset, index)
            if band.GetMaskFlags() != gdal.GMF_ALL_VALID or measured is None:
                continue
            pairs = zip((measured["min"], measured["max"]), measured["ends"])
            ends = [(value, share) for value, share in pairs if share >= SUSPECT]
            if found is not None:
                ends = [(value, min(share, found[1])) for value, share in ends if value == found[0]]
            if not ends:
                return None
            found = ends[0]
        return None if found is None else {"value": found[0], "share": found[1]}

    def statistics(self, dataset, blank=None):
        """What the interface shows of the raster's values and offers to draw them with: each band as measured, the
        ramps, and the classes of a band that has them, each with its colour, how many pixels are of it and the
        share that is, with whether those were `sampled` rather than counted through; all of them without `blank`,
        where the interface takes it for no data besides the bands' own. And a value that may be a border of no
        data the file does not declare, other than `blank`, where one is `suspect`."""
        rest = [index for index in range(1, dataset.RasterCount + 1) if (index, blank) not in self._measured]
        for index, sample in _samples(dataset, rest, blank):
            self._measured[(index, blank)] = _measure(sample)
        described = {
            "bands": [self._measured[(index, blank)] for index in range(1, dataset.RasterCount + 1)],
            "ramps": RAMPS,
        }
        suspect = self._suspect(dataset)
        if suspect is not None and suspect["value"] != blank:
            described["suspect"] = suspect
        if self.classes is not None:
            values, colours, counts, sampled = self.classes
            kept = values != blank if blank is not None else numpy.ones(values.size, dtype=bool)
            names = dataset.GetRasterBand(self.bands[0]).GetCategoryNames() or []
            described["sampled"] = sampled
            described["classes"] = [
                {
                    "value": int(value),
                    "color": colour.tolist(),
                    "count": int(count),
                    "share": float(count / counts[kept].sum()),
                    "name": names[int(value)] if 0 <= int(value) < len(names) and names[int(value)] else None,
                }
                for value, colour, count in zip(values[kept], colours[kept], counts[kept])
            ]
        return described


def native(dataset):
    """The side of the raster's pixels in metres of the map's plane, the least of it at a few places of the raster
    that the map shows, or None where that cannot be said. Of a pixel and its neighbours, not of the raster's extent:
    a raster across the antimeridian would else have pixels as wide as the world is over its width. Not where the
    plane ends, short of the poles, where a step of a pixel would come out as the way round the pole."""
    asked = []
    for across, down in PLACES:
        x, y = across * dataset.RasterXSize, down * dataset.RasterYSize
        asked += [(x, y), (x + 1, y), (x, y + 1)]
    try:
        points, reached = gdal.Transformer(dataset, None, ["DST_SRS=EPSG:4326"]).TransformPoints(0, asked)
    except RuntimeError:
        return None
    longitudes, latitudes = (numpy.array([point[index] for point in points]).reshape(-1, 3) for index in (0, 1))
    shown = (numpy.array(reached, dtype=bool).reshape(-1, 3) & (numpy.abs(latitudes) < _mercator.LATITUDE)).all(axis=1)
    across, up = _mercator.plane(longitudes, latitudes)
    # A step east across the antimeridian comes out a world to the west.
    across = (across[:, 1:] - across[:, :1] + _mercator.HALF) % (2 * _mercator.HALF) - _mercator.HALF
    sides = numpy.hypot(across, up[:, 1:] - up[:, :1]).mean(axis=1)[shown]
    sides = sides[numpy.isfinite(sides) & (sides > 0)]
    return float(sides.min()) if sides.size else None


def pixel(dataset, x, y, blank=None):
    """The pixel under a place in the map's plane: its `column` and `row`, counted from none; its `values`, one for
    each band as the file holds it, None where the band has no data there; its `centre` in the raster's own
    coordinates, None of a raster that is placed by other means than a grid; and its `outline`, the four corners as
    longitudes and latitudes. None for a place outside the raster. `blank` is a value the interface takes for no data
    besides the bands' own, as `tile` takes it: none of the values are data where all the bands hold it, and a band
    that holds it alone, as blue may in a shadow, is read out as it is."""
    across = gdal.Transformer(dataset, None, ["DST_SRS=EPSG:3857"])
    reached, at = across.TransformPoint(1, x, y)
    if not reached or not (math.isfinite(at[0]) and math.isfinite(at[1])):
        return None
    column, row = math.floor(at[0]), math.floor(at[1])
    if not (0 <= column < dataset.RasterXSize and 0 <= row < dataset.RasterYSize):
        return None
    values = []
    for index in range(1, dataset.RasterCount + 1):
        band = dataset.GetRasterBand(index)
        value = band.ReadAsArray(column, row, 1, 1)[0, 0]
        if numpy.iscomplexobj(value):
            value = numpy.abs(value)
        known = band.GetMaskBand().ReadAsArray(column, row, 1, 1)[0, 0] != 0 and numpy.isfinite(value)
        values.append(value.item() if known else None)
    if blank is not None and all(value == blank for value in values):
        values = [None] * len(values)
    outline = []
    for right, down in ((0, 0), (1, 0), (1, 1), (0, 1)):
        corner = across.TransformPoint(0, column + right, row + down)[1]
        outline.append(list(_mercator.degrees(corner[0], corner[1])))
    grid = dataset.GetGeoTransform(can_return_null=True)
    centre = None
    if grid is not None:
        centre = [
            grid[0] + (column + 0.5) * grid[1] + (row + 0.5) * grid[2],
            grid[3] + (column + 0.5) * grid[4] + (row + 0.5) * grid[5],
        ]
    return {"column": column, "row": row, "values": values, "centre": centre, "outline": outline}


def _nodata(band):
    """The value a band has no data by, where it says one that the warp can write: none where its mask says where
    it has no data instead, or where it is NaN, which a band of numbers that are not finite is left out by anyway."""
    value = band.GetNoDataValue()
    if value is None or not band.GetMaskFlags() & gdal.GMF_NODATA or math.isnan(value):
        return None
    return value


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


def tile(dataset, look, z, x, y, cancelled, asked=None, blank=None):
    """The image of the tile, or None where the raster has nothing under it. `asked` is how the interface wants the
    raster drawn: its `bands`, one or three, numbered from one; the `ranges` their values are drawn between, a low
    and a high for each, or none to draw them as they are; and, for one band, the `ramp` it is coloured through, from
    its high end to its low where it is `reversed`, or BY_CLASS in its place for a band of classes. Without it the
    raster is drawn as `look` has it: by its classes where it has them. `blank` is a value the interface takes for no
    data besides the bands' own: a pixel all the bands drawn hold it in is not drawn, as a border of 0 is in all of
    them, and a band holding it alone, as a picture's blue may in a shadow, keeps its pixel. What is measured of a
    band leaves it out band by band, which only narrows the range the band is drawn between."""
    left, top, span = _mercator.tile(z, x, y)
    classed = look.classes is not None and (asked is None or asked.get("ramp") == BY_CLASS)
    palette = look.palette if classed or asked is None else None
    bands = look.bands if classed or asked is None else asked["bands"]
    if asked is not None:
        ranges = asked.get("ranges")
    else:
        ranges = look.ranges if blank is None else look.ranges_of(dataset, blank)
    ramp = _ramp(asked["ramp"]) if asked is not None and asked.get("ramp") in RAMPS and len(bands) == 1 else None
    if ramp is not None and asked.get("reversed"):
        ramp = ramp[:, ::-1]
    # Closer than the raster's own pixels, they are shown as the squares they are; the colours of classes are never
    # mixed.
    nearest = classed or palette is not None or (look.native is not None and span / SIZE < look.native)
    # The alpha the warp gives a pixel is that of any band with data there; each band drawn is told its value of no
    # data as well, which the warp writes where that band has none, so that a pixel of a picture is not drawn where
    # one of its bands has no data, as the bands of a scene end apart at its edge.
    nodata = [_nodata(dataset.GetRasterBand(index)) for index in bands]
    told = {}
    if any(value is not None for value in nodata):
        told["dstNodata"] = " ".join("None" if value is None else repr(value) for value in nodata)
    try:
        warped = gdal.Warp(
            "",
            dataset,
            format="MEM",
            dstSRS="EPSG:3857",
            outputBounds=(left, top - span, left + span, top),
            width=SIZE,
            height=SIZE,
            srcBands=bands,
            dstAlpha=True,
            resampleAlg="near" if nearest else "bilinear",
            callback=lambda *_: 0 if cancelled() else 1,
            **told,
        )
    except RuntimeError:
        if cancelled():
            raise _source.Cancelled()
        raise
    values = warped.ReadAsArray()
    drawn = values[-1] != 0
    values = values[:-1]
    for index, value in enumerate(nodata):
        if value is not None:
            drawn &= values[index] != value
    if blank is not None:
        drawn &= (values != blank).any(axis=0)
    if numpy.iscomplexobj(values):
        values = numpy.abs(values)
    if values.dtype.kind == "f":
        drawn &= numpy.isfinite(values).all(axis=0)
    if not drawn.any():
        return None
    image = numpy.empty((4, SIZE, SIZE), dtype=numpy.uint8)
    if palette is not None:
        entries = palette[numpy.clip(values[0].astype(numpy.int64), 0, len(palette) - 1)]
        image[:] = numpy.moveaxis(entries, -1, 0)
        image[3] = numpy.where(drawn, image[3], 0)
        return _encoded(image, True)
    if classed:
        known, colours = look.classes[0], look.classes[1]
        at = numpy.clip(numpy.searchsorted(known, values[0]), 0, known.size - 1)
        # A class too rare for the sample a large raster's are counted in is drawn all the same, in no class's colour.
        counted = (known[at] == values[0])[..., None]
        entries = numpy.where(counted, colours[at], numpy.array(UNCOUNTED, dtype=numpy.uint8))
        image[:] = numpy.moveaxis(entries, -1, 0)
        image[3] = numpy.where(drawn, image[3], 0)
        return _encoded(image, True)
    for index in range(3):
        band = values[min(index, values.shape[0] - 1)]
        if ranges is None:
            image[index] = numpy.clip(band, 0, 255)
            continue
        low, high = ranges[min(index, len(ranges) - 1)]
        with numpy.errstate(invalid="ignore"):
            # A range of no width draws all at or above it as the high end. Scaled as `drawnColour` in
            # desktop/packages/ui/src/geocode/preview/rasterLook.ts scales a clicked pixel's value.
            image[index] = numpy.clip((band - low) * (255.0 / max(high - low, 1e-12)), 0, 255)
    if ramp is not None:
        image[:3] = ramp[:, image[0]]
    image[3] = numpy.where(drawn, 255, 0)
    return _encoded(image, False)
