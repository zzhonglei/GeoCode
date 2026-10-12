"""Exporting an image within its bounds, on its own grid unless told otherwise: to a local GeoTIFF, to Google Drive,
or, by gc.save, to the task."""

import contextlib
import math
import os
import re
import threading
import time
import warnings

import ee

from geocode import _run

# How often a download looks at its share done, reporting it when it moved; and how often it reports it at least,
# which also tells GeoEngine the run is alive.
LOOK_SECONDS = 1
REPORT_SECONDS = 5
# How often an export is asked about: its share done moves on the tool row about as often.
POLL_SECONDS = 3
GEOTIFF = (".tif", ".tiff")
# What prepareForExport takes to set a grid; given none, the image's own is used.
GRID = ("crs", "crs_transform", "shape", "scale")
# The grid Earth Engine gives a computed image with none of its own, as a reducer's: 1° in EPSG:4326.
NO_GRID = [1, 0, 0, 0, 1, 0]
CODE = re.compile(r"^[A-Z-]+:\d+$")


def without_region(grid):
    if "region" in grid:
        # Earth Engine's own exports take one, so the agent may give it out of habit.
        raise ValueError(
            "gc.save, gc.download and gc.to_drive take no region; clip the image first with image.clip(region)."
        )


def prepared(image, grid):
    """The image ready to export, within its own bounds: on the grid given as geedim's prepareForExport takes it, or
    else on the grid of its finest band."""
    image, grid = measured(image, grid)
    if "crs_transform" in grid and "shape" in grid:
        # A window of its own: with a region too, Earth Engine would stretch the region to the shape instead.
        return image.gd.prepareForExport(**grid)
    return image.gd.prepareForExport(region=image.geometry(), **grid)


def measured(image, grid):
    """The image with only the bands kept, and the grid given or else that of its finest band; one without bounds, or
    without a grid of its own, is refused."""
    import geedim  # noqa: F401 (registers the .gd accessors)

    without_region(grid)
    # As the signature the agent is shown has it: an argument given as None is not given.
    grid = {key: value for key, value in grid.items() if value is not None}
    if "bands" in grid:
        # Before the grid is measured: the finest of the bands kept, not of the image.
        image = image.select(grid["bands"])
        grid = {key: value for key, value in grid.items() if key != "bands"}
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
    return image, grid


def download(image, path, **grid):
    """Downloads an ee.Image to the GeoTIFF at path, relative to the workspace: numbered ("ndvi_1.tif") when that file
    exists, and in the workspace itself when its folder does not. The image is downloaded within its bounds, so clip it
    first, on its own grid unless crs, crs_transform, shape or scale give another; geedim's other prepareForExport
    arguments, such as dtype or bands, apply too. Returns the path it saved to."""
    target, notes = destination(path)
    folder, name = os.path.split(target)
    with _run.stage("Preparing %s" % name):
        ready = prepared(image, grid).gd
    # Hidden beside the target, so that the target is never a partial file and the rename is atomic.
    partial = os.path.join(folder, ".%s.%d.part" % (name, os.getpid()))
    started = time.monotonic()
    try:
        with _run.stage("Downloading %s" % name, 0):
            with reporting(), warnings.catch_warnings():
                # geedim looks every image up among the public datasets for its bands' descriptions: an asset of a
                # task is not one, which only leaves the descriptions out.
                warnings.filterwarnings("ignore", "Couldn't find STAC entry", RuntimeWarning)
                # In tiles of 2 MB rather than geedim's 4, so the share done moves in finer steps; no smaller, or
                # geedim no longer cuts a float64 image in whole blocks of the GeoTIFF it writes.
                ready.toGeoTIFF(partial, overwrite=True, max_tile_size=2)
            # Looked at only every second, so a download of one tile would show none of it done.
            _run.update(progress=1)
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
            _run.plural(profile["count"], "band"),
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


def to_drive(image, name, folder="GeoCode", **grid):
    """Exports an ee.Image to the user's Google Drive as the GeoTIFF name in folder, waiting for the export. The image
    is exported within its bounds, so clip it first, on its own grid unless crs, crs_transform, shape or scale give
    another; geedim's other prepareForExport arguments, such as dtype or bands, apply too."""
    stem, extension = os.path.splitext(name)
    if extension.lower() in GEOTIFF:
        # Earth Engine adds .tif itself.
        name = stem
    with _run.stage("Exporting %s to Google Drive" % name):
        ready = prepared(image, grid)
        # The name Earth Engine's task list shows; it takes only these characters.
        label = re.sub(r"[^A-Za-z0-9.,:;_-]", "_", name)[:100]
        task = ready.gd.toGoogleCloud(name, type="drive", folder=folder, wait=False, description=label, maxPixels=1e13)
        print("Exporting %s to Google Drive (export ID %s); waiting for it." % (name, task.id))
        started = time.monotonic()
        error = failure(task.operation_name)
    if error is not None:
        raise RuntimeError("Exporting %s to Google Drive failed: %s" % (name, error))
    print("Exported %s to the Google Drive folder %s after %d s." % (name, folder, time.monotonic() - started))


def failure(operation):
    """Waits for an export, telling the stage its share done; why it failed, or None when it succeeded."""
    done = 0
    while True:
        status = ee.data.getOperation(operation)
        metadata = status.get("metadata", {})
        if status.get("done"):
            break
        # Earth Engine's share can fall back between the export's stages.
        done = max(done, metadata.get("progress", 0))
        _run.update(progress=done)
        time.sleep(POLL_SECONDS)
    if metadata.get("state") == "SUCCEEDED":
        return None
    return (status.get("error") or {}).get("message") or metadata.get("state", "an unknown error")


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
def reporting():
    """Tells the stage, instead of geedim's progress bar, the share of the tiles downloaded."""
    import geedim.utils

    bars = []
    nowhere = open(os.devnull, "w")

    class Quiet(geedim.utils.tqdm):
        def __init__(self, *arguments, **options):
            # Counting every tile at once: by default tqdm counts in bursts, and the share would lag.
            super().__init__(*arguments, **{**options, "file": nowhere, "miniters": 1, "mininterval": 0})
            bars.append(self)

    def report():
        told, at = 0, time.monotonic()
        while not stopped.wait(LOOK_SECONDS):
            share = bars[-1].n / bars[-1].total if bars else 0
            if share != told or time.monotonic() - at >= REPORT_SECONDS:
                _run.update(progress=share)
                told, at = share, time.monotonic()

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
