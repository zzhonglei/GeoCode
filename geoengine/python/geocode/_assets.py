"""Saving to the run's task and reading from it."""

import datetime
import hashlib
import json
import numbers
import time

import ee

from geocode import _outputs, _run

# What a save waits for or cancels: one already being cancelled is ending either way.
UNDER_WAY = ("PENDING", "RUNNING")
# Of a fingerprint in an export's description: enough to tell two versions of one asset apart.
SHORT = 8
# What sets an image's grid and bands as Earth Engine's export to an asset does; given none, its own grid is used.
GRID = ("bands", "crs", "crs_transform", "scale", "shape")


# The functions that read an asset, and the argument naming it, in a serialized computation.
LOADS = {"Image.load": "id", "ImageCollection.load": "id", "Collection.loadTable": "tableId"}


def checked(name, what):
    if not isinstance(name, str) or not _run.NAME.match(name):
        raise ValueError(
            '%r is not a valid %s name: use 1 to 30 letters, digits, "_" or "-", such as "ndvi_summer".' % (name, what)
        )
    return name


def sources(serialized):
    """When each of GeoCode's assets a serialized computation reads was last updated: one replaced since by a save is
    other content, though the computation names it by the same path. Public datasets are left out: new scenes update
    them almost daily, which would make a finished composite look changed."""
    found = set()

    def walk(value):
        if isinstance(value, dict):
            called = value.get("functionInvocationValue")
            if isinstance(called, dict) and called.get("functionName") in LOADS:
                argument = (called.get("arguments") or {}).get(LOADS[called["functionName"]]) or {}
                path = argument.get("constantValue")
                if isinstance(path, str) and path.startswith(_run.root + "/"):
                    found.add(path)
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(json.loads(serialized))
    updated = {}
    for path in sorted(found):
        try:
            updated[path] = ee.data.getAsset(path).get("updateTime", "")
        except ee.EEException:
            # Gone, or still being exported: the computation fails on it anyway.
            updated[path] = None
    return updated


def number(value, what):
    # numpy's numbers are Real too; an ee.Number is not, and cannot be part of the grid.
    if isinstance(value, numbers.Real) and not isinstance(value, bool):
        return float(value)
    raise TypeError(
        "%s must be a number, not %s; bring an ee.Number into Python with getInfo()." % (what, type(value).__name__)
    )


def load(name):
    """Reads a saved asset: "composite" of this task, "other-task/composite" of another task, or "projects/..." by its
    full path. Returns an ee.Image, ee.FeatureCollection or ee.ImageCollection, as the asset is."""
    if not isinstance(name, str):
        raise TypeError('gc.load takes an asset\'s name as a string, such as "composite".')
    if name.startswith("projects/"):
        return read(name)
    parts = name.split("/")
    if len(parts) == 1:
        return read("%s/%s/%s" % (_run.root, _run.task, checked(name, "asset")))
    if len(parts) == 2:
        return read("%s/%s/%s" % (_run.root, checked(parts[0], "task"), checked(parts[1], "asset")))
    raise ValueError(
        'gc.load takes "asset" of this task, "task/asset" of another, or a full path starting with "projects/", not %r.'
        % name
    )


def read(path):
    try:
        kind = ee.data.getAsset(path).get("type")
    except ee.EEException:
        raise LookupError(absent(path)) from None
    if kind == "IMAGE":
        return ee.Image(path)
    if kind == "TABLE":
        return ee.FeatureCollection(path)
    if kind == "IMAGE_COLLECTION":
        return ee.ImageCollection(path)
    raise TypeError("%s is a %s, not an image, a table or an image collection." % (path, str(kind).lower()))


def absent(path):
    """Why an asset is not there, as far as GeoCode can tell."""
    task, _, asset = path[len(_run.root) + 1 :].partition("/")
    if not path.startswith(_run.root + "/") or not asset:
        return "There is no asset %s, or the user's account may not read it." % path
    for operation in _run.exports():
        if (operation["task"], operation["asset"]) == (task, asset) and operation["state"] in _run.ACTIVE:
            return "%s of task %s is still being exported (%s); it can be read once the export finishes." % (
                asset,
                task,
                operation["state"],
            )
    if _run.kind("%s/%s" % (_run.root, task)) != "FOLDER":
        return "There is no task %s in GeoCode's folder." % task
    names = sorted(_run.named(_run.children("%s/%s" % (_run.root, task))))
    held = ", ".join(names) if names else "none"
    return "Task %s has no asset %s. Its assets: %s." % (task, asset, held)


def save(data, name, *, title, description, **grid):
    """Saves an ee.Image or ee.FeatureCollection to this run's task as the asset "name", waiting for the export, and
    returns it read from the saved asset. An image is saved within its bounds, so clip it first, on its own grid unless
    crs, crs_transform, shape or scale give another, with only the bands given as bands when it is; each band keeps
    its type, as in Earth Engine's own export. Content saved before under the name is reused as it is; other content
    replaces it."""
    checked(name, "asset")
    for key, text in (("title", title), ("description", description)):
        if not isinstance(text, str) or not text.strip():
            raise ValueError("gc.save needs a %s: say what the asset is, in the user's language." % key)
    image = isinstance(data, ee.Image)
    if not image and not isinstance(data, ee.FeatureCollection):
        raise TypeError(
            "gc.save takes an ee.Image or an ee.FeatureCollection, not %s; reduce a collection to an image first, as by "
            "composite or mosaic." % type(data).__name__
        )
    # As the signature the agent is shown has it: an argument given as None is not given.
    grid = {key: value for key, value in grid.items() if value is not None}
    if not image and grid:
        raise ValueError("A table takes no %s; it is saved as it is." % ", ".join(sorted(grid)))
    _outputs.without_region(grid)
    others = sorted(set(grid) - set(GRID))
    if others:
        raise TypeError("gc.save takes %s, not %s." % (", ".join(GRID), ", ".join(others)))
    # The same grid written another way, as 10 and 10.0, is the same content.
    if "scale" in grid:
        grid["scale"] = number(grid["scale"], "scale")
    if "crs_transform" in grid:
        grid["crs_transform"] = [number(value, "crs_transform") for value in grid["crs_transform"]]

    serialized = ee.serializer.toJSON(data)
    text = json.dumps({"data": serialized, "grid": grid, "sources": sources(serialized)}, sort_keys=True)
    fingerprint = hashlib.sha256(text.encode("utf-8")).hexdigest()
    path = "%s/%s/%s" % (_run.root, _run.task, name)

    # First: an export still under way, such as one a stopped run left, decides what the asset will be, whatever is
    # saved there now.
    for operation in _run.exports():
        if (operation["task"], operation["asset"]) != (_run.task, name) or operation["state"] not in UNDER_WAY:
            continue
        if operation["fingerprint"] == fingerprint[:SHORT]:
            print("%s is already being exported with the same content; waiting for it." % name)
            return finish(operation["name"], path, name, [])
        try:
            ee.data.cancelOperation(operation["name"])
            print("Cancelled an export of %s still running with other content." % name)
        except ee.EEException:
            # Ended between the listing and now.
            pass

    try:
        existing = ee.data.getAsset(path)
    except ee.EEException:
        existing = None
    if existing is not None and (existing.get("properties") or {}).get("fingerprint") == fingerprint:
        print("%s is unchanged since it was saved; reading the saved asset." % name)
        return read(path)

    if image:
        # Only for an export: measuring asks Earth Engine about the image, which a saved asset reused spares.
        data, grid = _outputs.measured(data, grid)
        placed = {"crs": grid.get("crs"), "crsTransform": grid.get("crs_transform"), "scale": grid.get("scale")}
        if "shape" in grid:
            placed["dimensions"] = list(grid["shape"])[::-1]
        if "crs_transform" not in grid or "shape" not in grid:
            # Without a window of its own; with one, Earth Engine would stretch the region to the shape instead.
            placed["region"] = data.geometry()
        placed = {key: value for key, value in placed.items() if value is not None}
    made = make_folders()
    if existing is not None:
        print("Warning: %s was saved before with other content; it is being replaced." % name)
    saved = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    properties = {
        "title": title,
        "description": description,
        "task": _run.task,
        "saved": saved,
        "fingerprint": fingerprint,
    }
    label = "%s:%s:%s" % (_run.task, name, fingerprint[:SHORT])
    if image:
        export = ee.batch.Export.image.toAsset(
            image=data.set(properties), description=label, assetId=path, maxPixels=1e13, overwrite=True, **placed
        )
    else:
        export = ee.batch.Export.table.toAsset(
            collection=data.set(properties), description=label, assetId=path, overwrite=True
        )
    try:
        export.start()
    except Exception:
        # Refused as it was submitted, as when a source asset is missing.
        remove_empty(made)
        raise
    print("Exporting %s (export ID %s); waiting for it." % (name, export.id))
    return finish(export.operation_name, path, name, made)


def make_folders():
    """Makes GeoCode's folder and the task's, as far as they are missing; the ones made now."""
    made = []
    for folder in (_run.root, "%s/%s" % (_run.root, _run.task)):
        try:
            ee.data.createAsset({"type": "FOLDER"}, folder)
            made.append(folder)
        except ee.EEException as error:
            # There already, made before or by another run at the same time.
            kind = _run.kind(folder)
            if kind is None:
                raise error from None
            if kind != "FOLDER":
                raise RuntimeError("%s is not a folder, so GeoCode cannot save there" % folder) from None
    return made


def finish(operation, path, name, made):
    """Waits for an export, reporting its progress, and reads the saved asset; a failed one leaves no empty folder."""
    started = time.monotonic()
    error = _outputs.failure(operation, name)
    if error is None:
        print("Saved %s after %d s." % (name, time.monotonic() - started))
        return read(path)
    remove_empty(made)
    raise RuntimeError("Exporting %s failed: %s" % (name, error))


def remove_empty(made):
    """Removes the folders a failed save made, as long as nothing else was saved there since."""
    for folder in reversed(made):
        try:
            if not _run.children(folder):
                ee.data.deleteAsset(folder)
        except ee.EEException:
            # Another run saved there meanwhile; the failure being reported matters more.
            pass
