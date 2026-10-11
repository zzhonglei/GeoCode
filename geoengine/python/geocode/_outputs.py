"""Downloading an image to a local GeoTIFF, on its own grid unless told otherwise."""

import contextlib
import math
import os
import re
import threading
import time

import ee

from geocode import _run
from geocode._composite import plural

# How often a download reports its share done, which also tells GeoEngine the run is alive.
REPORT_SECONDS = 5
GEOTIFF = (".tif", ".tiff")
# What prepareForExport takes to set a grid; given none, the image's own is used.
GRID = ("crs", "crs_transform", "shape", "scale")
# The grid Earth Engine gives a computed image with none of its own, as a reducer's: 1° in EPSG:4326.
NO_GRID = [1, 0, 0, 0, 1, 0]
CODE = re.compile(r"^[A-Z-]+:\d+$")


def prepared(image, grid):
    """The image ready to export, within its own bounds: on the grid given as geedim's prepareForExport takes it, or
    else on the grid of its finest band."""
    import geedim  # noqa: F401 (registers the .gd accessors)

    if "bands" in grid:
        # Before the grid is measured: the finest of the bands kept, not of the image.
        image = image.select(grid.pop("bands"))
    found = ee.Dictionary({"unbounded": image.geometry().isUnbounded(), "grid": image.gd.projection()}).getInfo()
    if found["unbounded"]:
        raise ValueError("The image has no bounds, like any composite; clip it first with image.clip(region).")
    if not any(key in grid for key in GRID):
        own = found["grid"]
        if own.get("crs") == "EPSG:4326" and own["transform"] == NO_GRID:
            raise ValueError(
                "The image has no grid of its own, as after median() or mosaic(); give one, such as "
                'crs="EPSG:32651", scale=10, or composite with gc.composite.'
            )
        grid = {"crs": own.get("crs") or own["wkt"], "crs_transform": own["transform"], **grid}
    if "crs_transform" in grid and "shape" in grid:
        # A window of its own: with a region too, Earth Engine would stretch the region to the shape instead.
        return image.gd.prepareForExport(**grid)
    return image.gd.prepareForExport(region=image.geometry(), **grid)


def download(image, path, **grid):
    """Downloads an ee.Image to the GeoTIFF at path, relative to the workspace: numbered ("ndvi_1.tif") when that file
    exists, and in the workspace itself when its folder does not. The image is downloaded within its bounds, so clip it
    first, on its own grid unless crs, crs_transform, shape or scale give another; geedim's other prepareForExport
    arguments, such as dtype or bands, apply too. Returns the path it saved to."""
    target, notes = destination(path)
    ready = prepared(image, grid).gd
    folder, name = os.path.split(target)
    # Hidden beside the target, so that the target is never a partial file and the rename is atomic.
    partial = os.path.join(folder, ".%s.%d.part" % (name, os.getpid()))
    started = time.monotonic()
    try:
        with reporting(shown(target)):
            ready.toGeoTIFF(partial, overwrite=True)
        saved = numbered(target)
        os.replace(partial, saved)
    except BaseException:
        with contextlib.suppress(OSError):
            os.remove(partial)
        raise
    if saved != target:
        notes.append("%s exists, so it was saved as %s." % (shown(target), os.path.basename(saved)))
    import rasterio.crs

    profile = ready.profile
    crs = rasterio.crs.CRS.from_user_input(profile["crs"])
    if crs.is_geographic:
        unit = "°"
    else:
        unit = " m" if crs.linear_units in ("metre", "meter") else " " + crs.linear_units
    print(
        "Downloaded %s: %s of %s (nodata %s), %d × %d pixels on %s at %s%s, %s, after %d s."
        % (
            shown(saved),
            plural(profile["count"], "band"),
            profile["dtype"],
            figure(ready.nodata),
            profile["width"],
            profile["height"],
            ready.crs if CODE.match(ready.crs) else "a projection without an EPSG code",
            figure(abs(profile["transform"].a)),
            unit,
            "%.1f MB" % (os.path.getsize(saved) / 2**20),
            time.monotonic() - started,
        )
    )
    for note in notes:
        print(note)
    return shown(saved)


def destination(path):
    """Where path saves to, with .tif added when it has none, and a note when that is not path's folder."""
    target = os.path.abspath(os.path.expanduser(path))
    if os.path.isdir(target):
        raise ValueError("%s is a folder; name the file in it, such as %s." % (path, os.path.join(path, "image.tif")))
    extension = os.path.splitext(target)[1]
    if not extension:
        target += ".tif"
    elif extension.lower() not in GEOTIFF:
        raise ValueError("gc.download saves GeoTIFF files; name the file with .tif, not %s." % extension)
    folder = os.path.dirname(target)
    if os.path.isdir(folder):
        return target, []
    moved = os.path.join(os.getcwd(), os.path.basename(target))
    return moved, ["There is no folder %s, so the file was saved in the workspace." % shown(folder)]


def numbered(target):
    stem, extension = os.path.splitext(target)
    count = 0
    while os.path.exists(target):
        count += 1
        target = "%s_%d%s" % (stem, count, extension)
    return target


def shown(path):
    """A path relative to the workspace when it is in there; os.path.relpath fails across Windows drives."""
    workspace = os.path.join(os.getcwd(), "")
    return path[len(workspace) :] if path.startswith(workspace) else path


def figure(value):
    """A number as written: 0, -2147483648, 0.00008983, -inf; not in %g's exponents."""
    if math.isinf(value):
        return "%g" % value
    if value == int(value):
        return "%d" % value
    return ("%.10f" % value).rstrip("0")


@contextlib.contextmanager
def reporting(file):
    """Reports, instead of geedim's progress bar, the share of the tiles downloaded."""
    import geedim.utils

    bars = []
    nowhere = open(os.devnull, "w")

    class Quiet(geedim.utils.tqdm):
        def __init__(self, *arguments, **options):
            # Counting every tile at once: by default tqdm counts in bursts, and the share would lag.
            super().__init__(*arguments, **{**options, "file": nowhere, "miniters": 1, "mininterval": 0})
            bars.append(self)

    def report():
        while not stopped.wait(REPORT_SECONDS):
            share = bars[-1].n / bars[-1].total if bars else 0
            _run.report({"type": "download", "file": file, "progress": share})

    stopped = threading.Event()
    reporter = threading.Thread(target=report)
    original = geedim.utils.tqdm
    geedim.utils.tqdm = Quiet
    reporter.start()
    try:
        yield
    finally:
        stopped.set()
        reporter.join()
        geedim.utils.tqdm = original
        nowhere.close()
