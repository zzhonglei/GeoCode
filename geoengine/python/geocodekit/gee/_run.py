"""The task a run works in, set before GeoAgent's script starts; what GeoCode's folder holds, for the answer's header;
and geedim, as GeoCode's functions use it."""

import json
import re
from concurrent.futures import ThreadPoolExecutor

import ee

NAME = re.compile(r"^[A-Za-z0-9_-]{1,30}$")
# An export's description, the only place a running export names its destination: "task:asset:fingerprint".
LABEL = re.compile(r"^([A-Za-z0-9_-]{1,30}):([A-Za-z0-9_-]{1,30}):([0-9a-f]{8})$")
ACTIVE = ("PENDING", "RUNNING", "CANCELLING")

ASSETS_SHOWN = 100
TAKEN_SHOWN = 20
BANDS_SHOWN = 50
TEXT_SHOWN = {"title": 100, "description": 500}
OTHERS_SHOWN = 3
# GeoEngine reads the header as one line of at most 64 KiB; assets past this are counted, not listed.
HEADER_BYTES = 48 * 1024

# Set by start: GeoCode's folder and the task's name.
root = None
task = None


def geedim():
    """Imports geedim, which registers the .gd accessors, once a function needs it; its requests follow the proxy as
    every request of the environment does."""
    import geedim


def plural(count, noun):
    return "%d %s%s" % (count, noun, "" if count == 1 else "s")


def start(project, folder, name, new, started):
    """Sets up the run's task and reads what GeoCode's folder holds, for the answer's header. A new task whose name is
    taken, or a task to continue that has no folder and was not started in this conversation, ends the run before the
    script starts."""
    global root, task
    root = "projects/%s/assets/%s" % (project, folder)
    task = name
    # By listing the project's assets: Earth Engine answers a missing asset and one the user may not read alike.
    found = named(children("projects/%s/assets" % project)).get(folder)
    if found is not None and found.get("type") != "FOLDER":
        raise RuntimeError("%s is not a folder, so GeoCode cannot keep its tasks there" % root)
    tasks = {} if found is None else {
        key: asset for key, asset in named(children(root)).items() if asset.get("type") == "FOLDER"
    }
    with ThreadPoolExecutor(8) as pool:
        contents = dict(zip(tasks, pool.map(lambda key: children(root + "/" + key), tasks)))
        if new and name in tasks:
            held = sorted(named(contents[name]))
            return {"taken": held[:TAKEN_SHOWN], "more": len(held) - len(held[:TAKEN_SHOWN])}
        held = sorted(contents.get(name, []), key=lambda asset: asset.get("updateTime", ""), reverse=True)
        assets = list(pool.map(details, held[:ASSETS_SHOWN]))
    others = sorted(
        (
            {"name": key, "assets": len(contents[key]), "updated": latest(tasks[key], contents[key])}
            for key in tasks
            if key != name
        ),
        key=lambda other: other["updated"],
        reverse=True,
    )
    if not new and not started and name not in tasks:
        return {"missing": [other["name"] for other in others[:OTHERS_SHOWN]]}
    space = {
        "assets": assets,
        "more": len(held) - len(assets),
        "others": others[:OTHERS_SHOWN],
        "tasks": len(others),
    }
    while space["assets"] and len(json.dumps(space, ensure_ascii=False).encode("utf-8")) > HEADER_BYTES:
        space["assets"].pop()
        space["more"] += 1
    return space


def kind(path):
    """An asset's type, or None when there is none."""
    try:
        return ee.data.getAsset(path).get("type")
    except ee.EEException:
        return None


def children(parent):
    return ee.data.listAssets({"parent": parent}).get("assets", [])


def named(assets):
    return {asset["name"].rsplit("/", 1)[-1]: asset for asset in assets}


def latest(folder, assets):
    return max([folder.get("updateTime", "")] + [asset.get("updateTime", "") for asset in assets])


def details(listed):
    """An asset as the header shows it; as listed, when it changed or went since the listing."""
    try:
        info = ee.data.getAsset(listed["name"])
    except ee.EEException:
        info = listed
    properties = info.get("properties") or {}
    described = {
        "name": info["name"].rsplit("/", 1)[-1],
        "type": info.get("type", ""),
        "saved": str(properties.get("saved") or info.get("updateTime", "")),
    }
    bands = [band.get("id", "") for band in info.get("bands", [])]
    if bands:
        described["bands"] = bands[:BANDS_SHOWN]
    for key in ("title", "description"):
        if isinstance(properties.get(key), str) and properties[key].strip():
            described[key] = properties[key].strip()[: TEXT_SHOWN[key]]
    return described


def exports():
    """GeoCode's exports in the project, latest first, by what their descriptions name."""
    found = []
    for operation in ee.data.listOperations():
        metadata = operation.get("metadata", {})
        match = LABEL.match(metadata.get("description", ""))
        if match is None:
            continue
        found.append({
            "name": operation["name"],
            "task": match.group(1),
            "asset": match.group(2),
            "fingerprint": match.group(3),
            "state": metadata.get("state", ""),
            "created": metadata.get("createTime", ""),
        })
    return sorted(found, key=lambda operation: operation["created"], reverse=True)
