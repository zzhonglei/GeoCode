"""Writing downloaded features into one GeoPackage: a layer for each family of geometry, each
described with the attribution OSM's licence asks for, when its data is from and what was downloaded. The file is
written beside its place under a hidden name and moved there once whole, numbered rather than over a file there."""

import os
import tempfile

from geocodekit import _files, _tool

LAYERS = ("points", "lines", "polygons")
EXTENSION = ".gpkg"
ATTRIBUTION = "OpenStreetMap data (c) OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright."


class Unwritable(Exception):
    """A folder no file can be written in, as one the user may not write in or on a disk that is read only."""


def target(path):
    """Where a download is to go, with the extension a GeoPackage has."""
    return path if path.lower().endswith(EXTENSION) else path + EXTENSION


def ready(path):
    """Finds that a file can be written where a download is to go before anything is downloaded for it: in its folder,
    or in the nearest one there is when that is still to be made, which only a file written makes."""
    folder = os.path.dirname(target(path))
    there = folder
    while not os.path.isdir(there) and os.path.dirname(there) != there:
        there = os.path.dirname(there)
    try:
        with tempfile.TemporaryFile(dir=there):
            pass
    except OSError as error:
        raise Unwritable("%s: %s" % (folder, error.strerror or error))


def describe(what, timestamp, missing):
    lines = [ATTRIBUTION, "Data as of %s." % timestamp, "Downloaded %s." % what]
    if missing:
        lines.append("Incomplete: %s." % "; ".join(missing))
    return " ".join(lines)


def write(path, layers, columns, description):
    """Writes the layers, each a list of (attributes, geometry) by its name, into a new file at path or numbered beside
    it; returns the path written and how many features each layer has."""
    import geopandas
    import pyogrio

    path = target(path)
    folder, name = os.path.split(path)
    os.makedirs(folder, exist_ok=True)
    # Ending as a GeoPackage does, which GDAL asks of one.
    partial = os.path.join(folder, ".%s.%d.part%s" % (name[: -len(EXTENSION)], os.getpid(), EXTENSION))
    _tool.partial(partial)
    counts = {}
    try:
        for layer in LAYERS:
            features = layers.get(layer)
            if not features:
                continue
            frame = geopandas.GeoDataFrame(
                [attributes for attributes, _geometry in features],
                columns=columns,
                geometry=[geometry for _attributes, geometry in features],
                crs="EPSG:4326",
            )
            options = {"DESCRIPTION": description}
            pyogrio.write_dataframe(frame, partial, layer=layer, driver="GPKG", layer_options=options)
            counts[layer] = len(features)
        saved = _files.numbered(path)
        os.replace(partial, saved)
    finally:
        if os.path.exists(partial):
            os.remove(partial)
    return saved, counts
