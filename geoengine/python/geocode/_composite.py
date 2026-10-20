"""Compositing a dataset's images over the study region, and finding where the composite leaves it without data."""

import json

import ee

from geocode import _run
from geocode._images import MASKING

# geedim's mask bands, which its composite keeps: none is the dataset's.
MASK_BANDS = [
    "AEROSOL_MASK",
    "CDI_CLOUD_MASK",
    "CLOUDLESS_MASK",
    "CLOUD_DIST",
    "CLOUD_MASK",
    "CLOUD_PROB",
    "CLOUD_SCORE",
    "CLOUD_SHADOW_MASK",
    "FILL_MASK",
    "NONPHYSICAL_MASK",
    "SATURATION_MASK",
    "SHADOW_MASK",
]


def composite(images, region, dates=None, method=None, mask=True, min_coverage=0.999):
    """Composites the images as geedim does, masking their clouds as gc.images measured them unless mask is False and
    ordering them by the cloud-free share of their cover of the region; "dates" keeps only those of the given days
    ("2024-06-07") or acquisitions ("2024-06-07 Sentinel-2B R108"). Prints the share of the region the composite's
    first band covers and, of the rest, where no image reaches and where every image is masked, and stops when it
    covers less than min_coverage. Returns the composite of the dataset's own bands, not clipped, each band on its grid
    in the image at the region's centre."""
    with _run.stage("Compositing the images"):
        _run.geedim()
        if isinstance(dates, str):
            dates = [dates]
        chosen = images.filter(ee.Filter.Or(*[picked(entry) for entry in dates])) if dates else images
        counts = ee.Dictionary(
            {
                "masking": chosen.get(MASKING),
                "images": chosen.size(),
                "acquisitions": chosen.aggregate_array("acquisition").distinct().size(),
            }
        ).getInfo()
        if not counts["images"]:
            raise ValueError("None of the images are of %s." % ", ".join(dates))
        centre = chosen.filterBounds(region.centroid(1))
        source = ee.Image(ee.Algorithms.If(centre.size().gt(0), centre.first(), chosen.first()))
        grid = source.gd.projection()
        made = chosen.gd.composite(method=method, mask=mask, region=region, **json.loads(counts["masking"] or "{}"))
        bands = made.bandNames().removeAll(MASK_BANDS)
        # Each band on its own grid in the source image, as Sentinel-2's B11 at 20 m beside B2 at 10 m.
        gridded = bands.map(lambda band: made.select([band]).setDefaultProjection(source.select([band]).projection()))
        made = ee.ImageCollection(gridded).toBands().rename(bands).copyProperties(made, made.propertyNames())
        made = ee.Image(made)

        # unmask() keeps an image's footprint, so only the maximum, which has none, is unmasked outside every image.
        reached = chosen.map(lambda image: image.select(0).mask()).max().unmask(0).gt(0)
        covered = made.select(0).mask().unmask(0).gt(0)
        holes = {"none": reached.Not(), "cloud": reached.And(covered.Not())}
        # At Earth Engine's default tile size, a summer of Sentinel-2 composited by q-mosaic runs out of memory.
        measure = dict(
            geometry=region, crs=grid, scale=grid.nominalScale(), bestEffort=True, maxPixels=1e6, tileScale=4
        )
        found = ee.Dictionary(
            {
                "sums": ee.Image.cat(covered, holes["none"], holes["cloud"], ee.Image(1))
                .rename(["covered", "none", "cloud", "all"])
                .reduceRegion(ee.Reducer.sum(), **measure),
                "grid": grid,
                "scale": grid.nominalScale(),
                **{
                    name: ee.Image.pixelLonLat().updateMask(hole).reduceRegion(ee.Reducer.minMax(), **measure)
                    for name, hole in holes.items()
                },
            }
        ).getInfo()

        sums = found["sums"]
        share = {name: sums[name] / sums["all"] for name in ("covered", "none", "cloud")}
        count = (
            _run.plural(counts["acquisitions"], "acquisition")
            if counts["acquisitions"]
            else _run.plural(counts["images"], "image")
        )
        taken = "Composite of " + count
        left = [name for name in ("none", "cloud") if round(100 * share[name], 2) > 0]
        said = {"none": "No image reaches", "cloud": "Every image is masked as cloud over"}
        lines = ["%s %.2f%% of the region%s." % (said[name], 100 * share[name], extent(found[name])) for name in left]
        if share["covered"] >= min_coverage:
            crs = found["grid"].get("crs", "a projection without an EPSG code")
            print(
                "%s: covers %.2f%% of the region, on %s at %g m." % (taken, 100 * share["covered"], crs, found["scale"])
            )
            for line in lines:
                print(line)
            return made
        fixes = {
            "none": "where no image reaches, take more acquisitions or another dataset",
            "cloud": "where every image is masked, take more acquisitions or loosen the masking in gc.images",
        }
        head = "%s covers %.2f%% of the region, less than min_coverage=%g." % (
            taken,
            100 * share["covered"],
            min_coverage,
        )
        tail = "To fill it, %s; or lower min_coverage=." % "; ".join(fixes[name] for name in left)
        raise ValueError("\n".join([head] + lines + [tail]))


def picked(entry):
    """The images of a day, or of one acquisition as gc.images lists it."""
    if len(entry) == 10:
        return ee.Filter.date(entry, ee.Date(entry).advance(1, "day"))
    # A row copied from the table is spaced out to its columns.
    return ee.Filter.eq("acquisition", " ".join(entry.split()))


def extent(bounds):
    """", within" the lon/lat range of a hole, or nothing where only partial pixels at the region's edge make it up."""
    if bounds["longitude_min"] is None:
        return ""

    def at(value, signs):
        return "%.2f°%s" % (abs(value), signs[value < 0])

    return ", within %s to %s, %s to %s" % (
        at(bounds["longitude_min"], "EW"),
        at(bounds["longitude_max"], "EW"),
        at(bounds["latitude_min"], "NS"),
        at(bounds["latitude_max"], "NS"),
    )
