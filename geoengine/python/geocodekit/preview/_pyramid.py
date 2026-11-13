"""Overviews for a raster that has none of its own and is too large to draw without them: a tile that shows the whole
of such a raster reads every pixel of it. They are kept in GeoCode's cache, never beside the data, as the overviews of
a VRT that stands in for the raster; GDAL reads the raster through it, from the overviews where a tile shows the raster
reduced and from the raster itself otherwise."""

import hashlib
import os
import shutil
import time
import traceback

from osgeo import gdal

from geocodekit.preview import _raster, _source

# The longer side, in pixels, past which a raster is given overviews: up to it the whole raster is read in a moment.
SIDE = 8192
# The first overview holds every fourth pixel each way, and a tile closer than that reads the raster itself, sixteen
# of its pixels to one at most. Overviews from here take a tenth of the raster's size; from every second pixel, a third.
FIRST = 4
# The coarsest overview's longer side is no more than this.
COARSEST = 256
# As many bytes of overviews as are kept; past them, those used the longest ago go.
KEPT = 4 * 1024**3
VRT = "raster.vrt"
# Seconds since overviews being made were last written to, past which no reader is making them any more: one ended
# while it made them, and left them half made.
ABANDONED = 3600


def opened(vrt):
    """The stand-in, or None when it is no longer there: the cache is the user's to empty at any time."""
    try:
        return gdal.OpenEx(vrt, gdal.OF_RASTER | gdal.OF_READONLY, allowed_drivers=["VRT"])
    except RuntimeError:
        return None


def _build(dataset, entry):
    """The stand-in and its overviews, made under another name and given theirs once whole."""
    band = dataset.GetRasterBand(1)
    levels = [FIRST]
    while max(dataset.RasterXSize, dataset.RasterYSize) / levels[-1] > COARSEST:
        levels.append(levels[-1] * 2)
    making = "%s.%d.making" % (entry, os.getpid())
    os.makedirs(making)
    try:
        vrt = os.path.join(making, VRT)
        gdal.Translate(vrt, dataset, format="VRT")
        # Opened for reading alone, a dataset has its overviews written into a file beside it: beside the VRT here.
        standing = gdal.OpenEx(vrt, gdal.OF_RASTER | gdal.OF_READONLY, allowed_drivers=["VRT"])
        standing.BuildOverviews(
            # Classes have no average: one between two of them is a value the raster does not hold, or another class.
            "NEAREST" if _raster.of_classes(band) else "AVERAGE",
            levels,
            options=[
                "COMPRESS=DEFLATE",
                "BLOCKSIZE=512",
                "BIGTIFF=IF_SAFER",
                # Half the processors: the app goes on being used meanwhile.
                "NUM_THREADS=%d" % max(1, (os.cpu_count() or 2) // 2),
            ],
        )
        standing.Close()
        try:
            os.rename(making, entry)
        except PermissionError:
            # One retry: on Windows an indexer or antivirus can hold a file just written for a few milliseconds.
            time.sleep(0.06)
            os.rename(making, entry)
        # A folder's time is from when its last file was made, before the overviews were built; trimming keeps the
        # newest.
        os.utime(entry)
    except (RuntimeError, OSError):
        shutil.rmtree(making, ignore_errors=True)
        raise


def _trim(folder):
    """Leaves no more than KEPT bytes of overviews, never without the newest."""
    entries = []
    for name in os.listdir(folder):
        entry = os.path.join(folder, name)
        if not os.path.isdir(entry):
            continue
        # Those still being made, by this reader or another, are left to it; those a reader left go. By their files'
        # times: a folder's own is from when a file was last made in it, not written to.
        if name.endswith(".making"):
            files = [os.path.join(entry, each) for each in os.listdir(entry)]
            if max([os.path.getmtime(each) for each in files] or [os.path.getmtime(entry)]) < time.time() - ABANDONED:
                shutil.rmtree(entry, ignore_errors=True)
        else:
            size = sum(os.path.getsize(os.path.join(entry, each)) for each in os.listdir(entry))
            entries.append((os.path.getmtime(entry), size, entry))
    total = sum(size for _, size, _ in entries)
    for _, size, entry in sorted(entries)[:-1]:
        if total <= KEPT:
            break
        shutil.rmtree(entry, ignore_errors=True)
        total -= size


def stand_in(path, table, stamp, folder):
    """The VRT that the tiles of the raster under `stamp` are read through, made when there is none, or None for a
    raster read as it is. One that cannot be made is read as it is too, slowly rather than not at all."""
    dataset = _source.opened(path, gdal.OF_RASTER, table)
    if dataset is None:
        return None
    band = dataset.GetRasterBand(1)
    if max(dataset.RasterXSize, dataset.RasterYSize) <= SIDE or band.GetOverviewCount() > 0:
        return None
    # A mask the file keeps apart from its bands is not reduced with them: what it hides would show in the overviews.
    if band.GetMaskFlags() == gdal.GMF_PER_DATASET:
        return None
    # Under the data's stamp: changed data finds no overviews of what it was.
    entry = os.path.join(folder, hashlib.sha1("\0".join((path, table or "", stamp)).encode()).hexdigest()[:24])
    vrt = os.path.join(entry, VRT)
    try:
        if os.path.exists(vrt):
            # Used now, so among the last to go.
            os.utime(entry)
            return vrt
        _build(dataset, entry)
    except (RuntimeError, OSError):
        traceback.print_exc()
        return None
    # Apart: overviews just made are read all the same when the others cannot be trimmed, as when another reader
    # takes one of them away first.
    try:
        _trim(folder)
    except OSError:
        traceback.print_exc()
    return vrt
