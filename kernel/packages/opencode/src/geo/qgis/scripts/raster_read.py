# -*- coding: utf-8 -*-
"""Read raster data: size, bands, statistics, CRS, extent, defect warnings.

Emits ONE marker-tagged JSON line (GEOKERNEL.md section 4.13); see
vector_read.py for why whole-output parsing is ruled out and why UTF-8 comes
from the subprocess environment rather than this coding declaration.
"""

import faulthandler
import sys

# Before ANY osgeo import: a broken install segfaults during dynamic-library
# load, where no except block can see it (section 4.13 constraint 4).
faulthandler.enable(file=sys.stderr)

import json
import math
import os
import re

from osgeo import gdal, osr

MARKER = "__GEOCODE_READ_JSON__"


def emit(payload, code):
    sys.stdout.write(MARKER + json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()
    sys.stderr.flush()
    # Skip interpreter teardown: GDAL writes to the standard streams during
    # cleanup, and nothing may follow the marker (section 4.13 constraint 3).
    os._exit(code)


gdal.UseExceptions()

WGS84 = osr.SpatialReference()
try:
    WGS84.ImportFromEPSG(4326)
    WGS84.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
except Exception:
    WGS84 = None


def crs_error(message, error):
    return f"{message}: {error}"


def import_srs_from_wkt(wkt):
    """Parse projection WKT without letting unsupported custom CRS abort reads."""
    if not wkt or wkt.strip() == "":
        return None, "CRS is missing. This dataset has no coordinate reference system defined."
    srs = osr.SpatialReference()
    try:
        err = srs.ImportFromWkt(wkt)
        if err not in (0, None):
            return None, f"CRS metadata is present, but GDAL returned error code {err} while parsing it."
    except Exception as e:
        return None, crs_error("CRS metadata is present, but GDAL/PROJ could not parse it", e)
    try:
        srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    except Exception:
        pass
    return srs, None


def extent_to_wgs84(srs, xmin, xmax, ymin, ymax):
    """Transform extent to WGS84. Returns dict or None if transform fails."""
    if not srs or not WGS84:
        return None
    src = srs.Clone()
    src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    if src.IsSame(WGS84):
        return {"xmin": xmin, "xmax": xmax, "ymin": ymin, "ymax": ymax}
    try:
        transform = osr.CoordinateTransformation(src, WGS84)
        corners = [
            (xmin, ymin), (xmin, ymax),
            (xmax, ymin), (xmax, ymax),
        ]
        lons, lats = [], []
        for x, y in corners:
            lon, lat, _ = transform.TransformPoint(x, y)
            lons.append(lon)
            lats.append(lat)
        return {
            "xmin": min(lons), "xmax": max(lons),
            "ymin": min(lats), "ymax": max(lats),
        }
    except Exception:
        return None


# Friendly fallback names for `+proj=xxx` keys. Used only when the WKT
# PROJCS / GEOGCS / PROJECTION nodes are placeholders ("unknown" / "unnamed")
# so that custom projections still get a recognisable family name instead
# of a bare "unknown". Append " (custom)" downstream so callers know this
# is a recognised family, not a fully-identified named CRS.
_PROJ_FRIENDLY_NAMES = {
    "lcc": "Lambert Conformal Conic",
    "tmerc": "Transverse Mercator",
    "utm": "UTM",
    "merc": "Mercator",
    "webmerc": "Web Mercator",
    "aea": "Albers Equal Area",
    "laea": "Lambert Azimuthal Equal Area",
    "aeqd": "Azimuthal Equidistant",
    "stere": "Stereographic",
    "sterea": "Oblique Stereographic",
    "omerc": "Oblique Mercator",
    "somerc": "Swiss Oblique Mercator",
    "longlat": "Geographic",
    "lonlat": "Geographic",
    "latlong": "Geographic",
    "eqc": "Equidistant Cylindrical",
    "cea": "Cylindrical Equal Area",
    "sinu": "Sinusoidal",
    "moll": "Mollweide",
    "robin": "Robinson",
    "ortho": "Orthographic",
    "eqdc": "Equidistant Conic",
    "krovak": "Krovak",
}

# Matches `+proj=value` allowing optional single/double quotes around the value.
_PROJ4_PROJ_RE = re.compile(r'(?:^|\s)\+proj=(?:"([^"]+)"|\'([^\']+)\'|([^\s]+))')


def derive_friendly_name(srs):
    """Resolve a human-readable CRS display name with placeholder fallback.

    Order:
      1. WKT PROJCS / GEOGCS name when it is not a placeholder.
      2. WKT PROJECTION node (e.g. "Lambert_Conformal_Conic_2SP") with
         underscores replaced by spaces, suffixed with " (custom)".
      3. proj4 +proj=xxx looked up in _PROJ_FRIENDLY_NAMES, suffixed with
         " (custom)".
      4. "Custom projection" as a final catch-all.

    The "(custom)" suffix signals that the projection family was recognised
    but the CRS lacks an authoritative identifier -- distinguishing this from
    a fully-named CRS like "WGS 84 / UTM zone 49N".
    """
    name = srs.GetAttrValue("PROJCS") or srs.GetAttrValue("GEOGCS")
    if name and name.strip().lower() not in ("unknown", "unnamed", "unnamed crs"):
        return name

    projection = srs.GetAttrValue("PROJECTION")
    if projection and projection.strip().lower() not in ("unknown", "unnamed"):
        return projection.strip().replace("_", " ") + " (custom)"

    try:
        proj4 = srs.ExportToProj4() or ""
    except Exception:
        proj4 = ""
    match = _PROJ4_PROJ_RE.search(proj4)
    if match:
        proj = (match.group(1) or match.group(2) or match.group(3)).lower()
        if proj in _PROJ_FRIENDLY_NAMES:
            return _PROJ_FRIENDLY_NAMES[proj] + " (custom)"

    return "Custom projection"


def resolve_crs(srs, existing_warning=None):
    """Return a compact CRS identifier: EPSG code if available, otherwise Proj4."""
    if not srs:
        return None, None, existing_warning or "CRS is missing. This dataset has no coordinate reference system defined."
    try:
        wkt = srs.ExportToWkt()
    except Exception as e:
        return None, None, existing_warning or crs_error("CRS metadata is present, but GDAL/PROJ could not export it", e)
    if not wkt or wkt.strip() == "":
        return None, None, existing_warning or "CRS is missing. This dataset has no coordinate reference system defined."

    name = derive_friendly_name(srs)

    # Let GDAL match WKT against its EPSG database (handles missing AUTHORITY tags)
    warning = existing_warning
    try:
        srs.AutoIdentifyEPSG()
    except Exception as e:
        warning = crs_error("CRS metadata is present, but GDAL/PROJ could not identify an EPSG code", e)

    code = srs.GetAuthorityCode(None)
    authority = srs.GetAuthorityName(None)

    # Compound CRS: root has no authority, check PROJCS only.
    # Do NOT fall through to GEOGCS -- that is the base datum, not the projection itself.
    if not code:
        code = srs.GetAuthorityCode("PROJCS")
        authority = srs.GetAuthorityName("PROJCS")

    if code and authority:
        return f"{authority}:{code}", name, None

    try:
        proj4 = srs.ExportToProj4().strip()
    except Exception as e:
        return wkt, name, warning or crs_error("CRS metadata is present, but GDAL/PROJ could not convert it to PROJ string", e)
    if proj4:
        return proj4, name, warning

    return wkt, name, warning


def container_subdatasets(ds):
    """The variables a container holds, or an empty list for an ordinary raster.

    A netCDF, HDF4, HDF5 or GRIB file carrying several variables is not a raster
    at all. GDAL opens it anyway and answers with RasterCount 0, a placeholder
    512x512 size and no georeferencing, so every fact read off it afterwards is
    fiction. The variables themselves are named in metadata, and handing those
    names back is the whole difference between a dead end and a next call:
    MODIS, Sentinel and ERA5 scenes all arrive this way.

    The description travels with the name because the name alone does not say
    what the variable IS. `NETCDF:"era5.nc":t2m` means nothing to a reader who
    has not met the dataset; GDAL's own `[1x48x64] 2 metre temperature` does.
    Absent for some drivers, so it is optional rather than assumed.
    """
    if ds.RasterCount > 0:
        return []
    metadata = ds.GetMetadata("SUBDATASETS") or {}
    found = []
    index = 1
    while True:
        name = metadata.get(f"SUBDATASET_{index}_NAME")
        if not name:
            break
        entry = {"name": name}
        description = metadata.get(f"SUBDATASET_{index}_DESC")
        if description:
            entry["description"] = description
        found.append(entry)
        index += 1
    return found


def georeferencing_facts(ds):
    """The five places a raster can say where it is on the earth.

    Reported, never judged. What they add up to is one rule, and it lives in
    TypeScript (geo/georeference.ts) so that there is only ever one of it --
    the interface reads the same five facts out of gdalinfo and reaches its
    verdict through the same function (GEOKERNEL.md section 7.9).
    """
    return {
        "transform": list(ds.GetGeoTransform()),
        "projection": bool(ds.GetProjection()),
        "gcp_count": ds.GetGCPCount(),
        "rpc": bool(ds.GetMetadata("RPC")),
        "geolocation": bool(ds.GetMetadata("GEOLOCATION")),
    }


def read_raster(file_path):
    ds = gdal.Open(file_path)
    if ds is None:
        raise RuntimeError(f"Cannot open raster file: {file_path}")

    gt = ds.GetGeoTransform()
    # GDAL silently returns the identity transform (0, 1, 0, 0, 0, 1) when the
    # file has no GeoTransform set -- same shape as a real transform, so
    # without explicit detection we'd report pixel-coordinate extents
    # disguised as geographic. This decides the EXTENT only; whether the file
    # is geographic data at all is a wider question with a wider answer, and
    # the caller reaches it from `georeferencing` below.
    no_geotransform = gt == (0.0, 1.0, 0.0, 0.0, 0.0, 1.0)

    srs, srs_warning = import_srs_from_wkt(ds.GetProjection())

    # The two corners the transform puts the grid between, then NORMALIZED,
    # because the field names promise it and a transform is free not to: a
    # negative x step flips one pair, and the identity GDAL hands back for "no
    # transform" steps POSITIVELY in y, which flips the other. The GDAL face
    # normalizes the same way (gdal/inspector.ts) -- one file must not come
    # back with its extent one way round for the Agent and the other for the
    # map. extent_to_wgs84 is unaffected either way: it transforms all four
    # corners and takes the extremes of the results.
    x0, y0 = gt[0], gt[3]
    x1 = x0 + gt[1] * ds.RasterXSize
    y1 = y0 + gt[5] * ds.RasterYSize
    xmin, xmax = min(x0, x1), max(x0, x1)
    ymin, ymax = min(y0, y1), max(y0, y1)

    crs, crs_name, crs_warning = resolve_crs(srs, srs_warning)
    has_crs = crs is not None

    geotransform_warning = (
        "No affine transform: the 'extent' below is pixel indices, not ground "
        "coordinates -- anything spatial computed from them will be wrong."
    ) if no_geotransform else None

    # A container answers every question above with fiction, and answers it in
    # the same shape a real raster would -- which is what makes it dangerous
    # rather than merely unhelpful. GDAL reports 512x512 because it has to
    # report something, a unit transform because there is none to report, and no
    # CRS because the CRS belongs to each variable rather than to the box. Left
    # as they stand, those read as a small, unreferenced image, and the two
    # warnings below would say the file is defective when it is simply not a
    # raster at all.
    subdatasets = container_subdatasets(ds)
    container_warning = None
    if subdatasets:
        container_warning = (
            f"This file is a container holding {len(subdatasets)} subdatasets rather than raster bands "
            "-- netCDF, HDF and GRIB scenes such as MODIS, Sentinel and ERA5 are normally shaped this "
            "way. Everything reported above about size, pixel size, extent and CRS describes GDAL's "
            "placeholder for the container, NOT the data, and none of it should be used or passed on. "
            "Read one of the subdatasets listed below by using its name as the file path."
        )
        # Both of these are TRUE of the container and MISLEADING about the file:
        # "CRS is missing" reads as a defect to be repaired, and the transform
        # note sends the reader looking for ground coordinates that live one
        # level down. The container warning above says what is actually going on.
        crs_warning = (
            "CRS is not set on the container itself. Each subdataset carries its own -- open one to see it."
        )
        geotransform_warning = None

    # When there's no GeoTransform, applying any CRS to the extent is
    # meaningless -- extent values are pixel indices, not coordinates.
    # Force extent_wgs84=None in that case regardless of whether a CRS
    # happens to be set on the file (rare but possible).
    #
    # For all other cases delegate to extent_to_wgs84 -- it handles the
    # WGS84-source case internally (clones srs, forces OAMS_TRADITIONAL_GIS_ORDER,
    # echoes the extent back unchanged) so EPSG:4326 datasets are not
    # short-circuited to null. This keeps the field always-populated and
    # matches vector_read.py's behaviour.
    if no_geotransform:
        extent_wgs84 = None
    else:
        extent_wgs84 = extent_to_wgs84(srs if has_crs else None, xmin, xmax, ymin, ymax)

    result = {
        "data_type": "raster",
        "driver": ds.GetDriver().ShortName,
        "size": {
            "width": ds.RasterXSize,
            "height": ds.RasterYSize,
        },
        "band_count": ds.RasterCount,
        "georeferencing": georeferencing_facts(ds),
        "crs": crs,
        "crs_name": crs_name,
        "crs_warning": crs_warning,
        "geotransform_warning": geotransform_warning,
        "container_warning": container_warning,
        # The doorknob. Absent for an ordinary raster, so its presence IS the
        # answer to "is this a box or a scene" and no consumer has to infer that
        # from a band count of zero.
        "subdatasets": subdatasets,
        "pixel_size": {
            "x": gt[1],
            "y": gt[5],
        },
        "extent": {
            "xmin": xmin,
            "xmax": xmax,
            "ymin": ymin,
            "ymax": ymax,
        },
        "extent_wgs84": extent_wgs84,
        "bands": [],
    }

    def safe_float(v):
        """Convert inf/nan to JSON-safe string representations."""
        if v is None:
            return None
        if math.isinf(v):
            return "Infinity" if v > 0 else "-Infinity"
        if math.isnan(v):
            return "NaN"
        return v

    for i in range(1, ds.RasterCount + 1):
        band = ds.GetRasterBand(i)
        nodata = band.GetNoDataValue()
        stats = band.GetStatistics(True, True)

        band_info = {
            "index": i,
            "data_type": gdal.GetDataTypeName(band.DataType),
            "nodata": safe_float(nodata),
            "statistics": {
                "min": safe_float(stats[0]),
                "max": safe_float(stats[1]),
                "mean": safe_float(stats[2]),
                "stddev": safe_float(stats[3]),
            },
            "color_interp": gdal.GetColorInterpretationName(band.GetColorInterpretation()),
        }
        result["bands"].append(band_info)

    ds = None
    return result


if __name__ == "__main__":
    try:
        emit(read_raster(sys.argv[1]), 0)
    except Exception as e:
        emit({"error": str(e)}, 1)
