"""Finding a dataset's images over the study region, by acquisition."""

import json

import ee

from geocodekit import _tool
from geocodekit.gee import _run

# Acquisitions listed at most; past these, those with the most cloud-free cover of the region.
MOST_ROWS = 40
# Acquisitions measured in one request: a year of Sentinel-2 at once runs out of Earth Engine's memory.
BATCH = 20
# Pixels an acquisition is measured on at most, on a coarser grid past them: the shares need only be roughly right, and
# a large region measured on the images' own grid runs past Earth Engine's limits.
MOST_PIXELS = 1e5
CLOUD_SCORE = "GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED"
# The collection's property holding the masking arguments it was measured with, as JSON.
MASKING = "GEOCODE_MASKING"
# Of an image that geedim masks, what makes one acquisition with others: the satellite, its orbit, and how the table
# names the orbit.
PASSES = {
    "COPERNICUS/S2": ("SPACECRAFT_NAME", "SENSING_ORBIT_NUMBER", "R"),
    "LANDSAT/": ("SPACECRAFT_ID", "WRS_PATH", "P"),
}


def images(collection, region, start, end, **masking):
    """Finds a dataset's images over the region from start to end, the end excluded, and prints each acquisition's
    cover of the region and the cloud-free share of that cover, its clouds found as geedim finds them. "collection" is
    a dataset's ID or an ee.ImageCollection; "masking" takes geedim's cloud masking arguments, such as score=0.5.
    Returns the images unmasked, with geedim's mask bands, as geedim composites them: gee.composite masks them with the
    same arguments, and .gd.maskClouds() masks them for other uses."""
    with _tool.stage("Finding images of %s" % (collection if isinstance(collection, str) else "the collection")):
        _run.geedim()
        found = ee.ImageCollection(collection).filterDate(start, end).filterBounds(region)
        dataset = found.gd.id
        clouds = found.gd.cloudSupport
        passes = next((value for prefix, value in PASSES.items() if clouds and dataset.startswith(prefix)), None)
        scored = (
            clouds
            and dataset.startswith("COPERNICUS/S2")
            and masking.get("mask_method", "cloud-score") == "cloud-score"
        )
        known = (
            ee.ImageCollection(CLOUD_SCORE).filterDate(start, end).filterBounds(region).aggregate_array("system:index")
        )

        def keyed(image):
            key = ee.Date(image.get("system:time_start")).format("YYYY-MM-dd")
            if passes:
                orbit = ee.Number(image.get(passes[1])).format("%03d")
                key = key.cat(" ").cat(image.get(passes[0])).cat(" %s" % passes[2]).cat(orbit)
            return image.set("acquisition", key)

        marked = found.gd.addMaskBands(**masking).map(keyed)
        grid = marked.first().select(0).projection()

        def row(key):
            # Its own day first: picking each acquisition out of all the images of its batch runs out of memory.
            day = ee.Date(ee.String(key).slice(0, 10))
            group = marked.filterDate(day, day.advance(1, "day")).filter(ee.Filter.eq("acquisition", key))
            bands = ["FILL_MASK", "CLOUDLESS_MASK"] if clouds else ["FILL_MASK"]
            masks = group.select(bands).map(lambda image: image.unmask(0)).max()
            # As geedim's regionCoverage: over the whole region, not only the part of it the images cover.
            sums = ee.Image.cat(masks, ee.Image(1).rename("REGION")).reduceRegion(
                ee.Reducer.sum(), region, crs=grid, scale=grid.nominalScale(), bestEffort=True, maxPixels=MOST_PIXELS
            )
            values = {"key": key, "images": group.size(), "region": sums.get("REGION"), "fill": sums.get("FILL_MASK")}
            if clouds:
                values["clear"] = sums.get("CLOUDLESS_MASK")
            if scored:
                # geedim masks an image without Cloud Score+ as all cloud.
                values["scored"] = group.filter(ee.Filter.inList("system:index", known)).size()
            return ee.Feature(None, values)

        keys = marked.aggregate_array("acquisition").distinct().sort().getInfo()
        if not keys:
            raise ValueError(
                "There are no images of %s from %s to %s (end excluded) over the region."
                % (dataset or "the collection", start, end)
            )
        rows = []
        _tool.update("Measuring %s over the region" % _run.plural(len(keys), "acquisition"), 0)
        for first in range(0, len(keys), BATCH):
            batch = keys[first : first + BATCH]
            measured = ee.FeatureCollection(ee.List(batch).map(row)).getInfo()
            rows += [feature["properties"] for feature in measured["features"]]
            _tool.update(progress=len(rows) / len(keys))

        for item in rows:
            item["covered"] = item["fill"] / item["region"]
            item["cloud-free"] = item["clear"] / item["fill"] if clouds and item["fill"] else 0
            # Where Cloud Score+ is missing, the cover is all that is known.
            item["rank"] = item["covered"] * item["cloud-free"] if clouds and item.get("scored", 1) else item["covered"]
        unmasked = "" if clouds else "; clouds not masked" + ("" if dataset else ": no dataset ID, as after a merge")
        print(
            "%s, %s to %s: %s in %s%s."
            % (
                dataset or "The collection",
                start,
                end,
                _run.plural(sum(item["images"] for item in rows), "image"),
                _run.plural(len(rows), "acquisition"),
                unmasked,
            )
        )
        shown = rows
        if len(rows) > MOST_ROWS:
            best = sorted(rows, key=lambda item: item["rank"], reverse=True)[:MOST_ROWS]
            shown = sorted(best, key=lambda item: item["key"])
            print("The %d of %d with the most %scover:" % (MOST_ROWS, len(rows), "cloud-free " if clouds else ""))
        heads = ["date", "satellite", "orbit"] if passes else ["date"]
        table = [heads + ["images", "covered"] + ["cloud-free"] * clouds]
        for item in shown:
            cells = item["key"].split(" ") + [str(item["images"]), "%.1f%%" % (100 * item["covered"])]
            if scored and item["scored"] == 0:
                cells.append("no Cloud Score+")
            elif scored and item["scored"] < item["images"]:
                cells.append("%.1f%%, Cloud Score+ %d/%d" % (100 * item["cloud-free"], item["scored"], item["images"]))
            elif clouds:
                cells.append("%.1f%%" % (100 * item["cloud-free"]))
            table.append(cells)
        widths = [max(len(cells[column]) for cells in table) for column in range(len(table[0]) - 1)]
        for cells in table:
            print("  ".join([cell.ljust(width) for cell, width in zip(cells, widths)] + cells[len(widths) :]))
        # For gee.composite, which masks the images as they were measured here.
        return marked.set(MASKING, json.dumps(masking, default=str))
