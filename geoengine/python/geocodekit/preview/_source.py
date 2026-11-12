"""A dataset as the preview reads it: opened for one answer and closed again, with nothing left beside it."""

import hashlib
import os

from osgeo import gdal


class Unshown(Exception):
    """Why the preview shows nothing of a dataset, as a code the interface words."""

    def __init__(self, code, message=""):
        super().__init__(message or code)
        self.code = code


class Cancelled(Exception):
    """The answer is no longer wanted."""


def configure():
    gdal.UseExceptions()
    # GDAL would write the statistics it computes into an .aux.xml beside the data.
    gdal.SetConfigOption("GDAL_PAM_ENABLED", "NO")
    # In megabytes. A reader stays for as long as its preview is looked at, and several run at once.
    gdal.SetConfigOption("GDAL_CACHEMAX", "256")


# The formats the preview reads, by their drivers' names; the names their files go by are in
# desktop/packages/ui/src/geocode/preview/geoFiles.ts. Nothing else is opened, whatever a file is named: a virtual
# raster or a service's description under one of those names would send GDAL to the files and addresses it lists.
# GeoJSONSeq with GeoJSON: read as GeoJSON, a file of one feature a line would show its first feature alone.
DRIVERS = ["ESRI Shapefile", "GPKG", "GTiff", "GeoJSON", "GeoJSONSeq"]


def _untouched(path, flags):
    """The options that keep a driver from writing beside the data, as `untouched` in OPENING of
    geoengine/src/qgis/reader.ts gives them to QGIS's Python for the formats it reads."""
    identified = gdal.IdentifyDriverEx(path, flags, DRIVERS)
    driver = identified.ShortName if identified is not None else None
    # SQLite would write a -wal and a -shm beside a GeoPackage in WAL mode. Without a -wal there, the file holds all
    # of its data; with one, another program has it open, and its changes are read too.
    if driver == "GPKG" and not os.path.exists(path + "-wal"):
        return ["IMMUTABLE=YES"]
    return []


def opened(path, flags, table=None):
    """The dataset, or None when no driver of that kind reads it. `table` names one of the several rasters a
    GeoPackage may hold."""
    try:
        options = _untouched(path, flags) + ([] if table is None else ["TABLE=" + table])
        return gdal.OpenEx(path, flags | gdal.OF_READONLY, allowed_drivers=DRIVERS, open_options=options)
    except RuntimeError:
        return None


def files(dataset, path):
    """Every file the dataset is made of: a change to any of them is a change to the data."""
    listed = dataset.GetFileList() or []
    # A GeoPackage another program is writing keeps its changes here until it merges them into the file.
    return sorted(set(listed) | {path, path + "-wal"})


def stamp(paths):
    """Changes whenever one of the files does."""
    digest = hashlib.sha1()
    for path in paths:
        try:
            status = os.stat(path)
            digest.update(("%s\0%d\0%d\n" % (path, status.st_size, status.st_mtime_ns)).encode())
        except OSError:
            digest.update(("%s\0absent\n" % path).encode())
    return digest.hexdigest()[:16]
