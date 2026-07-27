# -*- coding: utf-8 -*-
"""Read vector data: layer metadata, exact field statistics, sampled features.

Emits ONE marker-tagged JSON line (GEOKERNEL.md section 4.13): stdout under a
QGIS-bundled interpreter is a noisy shared channel, so whole-output parsing is
not reliable. The payload keeps non-ASCII attribute values raw
(ensure_ascii=False) -- the subprocess environment forces UTF-8 streams on
every assembly track, and that is what protects the BODY here, not just the
diagnostics.
"""

import faulthandler
import sys

# Before ANY osgeo import: a broken install segfaults during dynamic-library
# load, where no except block can see it (section 4.13 constraint 4).
faulthandler.enable(file=sys.stderr)

import json
import os
import re
from collections import Counter

from osgeo import ogr, osr

MARKER = "__GEOCODE_READ_JSON__"


def emit(payload, code):
    sys.stdout.write(MARKER + json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()
    sys.stderr.flush()
    # Skip interpreter teardown: GDAL and friends write to the standard
    # streams during cleanup, and nothing may follow the marker (section 4.13
    # constraint 3).
    os._exit(code)


ogr.UseExceptions()

WGS84 = osr.SpatialReference()
try:
    WGS84.ImportFromEPSG(4326)
    WGS84.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
except Exception:
    WGS84 = None


def crs_error(message, error):
    return f"{message}: {error}"


def layer_spatial_ref(layer):
    """Read layer CRS without letting unsupported custom CRS abort vector reads."""
    try:
        return layer.GetSpatialRef(), None
    except Exception as e:
        return None, crs_error("CRS metadata is present, but GDAL/PROJ could not parse it", e)


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


def geometry_summary(geom):
    """Return a compact summary of a geometry instead of full WKT."""
    if geom is None:
        return None
    geom_name = geom.GetGeometryName()
    summary = {
        "type": geom_name,
    }
    if geom_name != "POINT":
        env = geom.GetEnvelope()  # (minX, maxX, minY, maxY)
        summary["bbox"] = [env[0], env[2], env[1], env[3]]  # [minX, minY, maxX, maxY]
    geom_type = geom.GetGeometryType()
    # area for polygons, length for lines
    if geom_type in (ogr.wkbPolygon, ogr.wkbMultiPolygon,
                     ogr.wkbPolygon25D, ogr.wkbMultiPolygon25D):
        summary["area"] = geom.GetArea()
    elif geom_type in (ogr.wkbLineString, ogr.wkbMultiLineString,
                       ogr.wkbLineString25D, ogr.wkbMultiLineString25D):
        summary["length"] = geom.Length()
    return summary


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
_TEMPORAL_FIELD_RE = re.compile(
    r'(^|[_:\-\s])(datetime|timestamp|created_at|updated_at|modified_at|date|time|created|updated|modified)([_:\-\s]|$)'
)
_COUNTABLE_FIELD_TYPES = {"String", "Integer", "Integer64"}
_TEMPORAL_FIELD_TYPES = {"Date", "Time", "DateTime"}
_LIST_FIELD_TYPES = {"StringList", "IntegerList", "Integer64List", "RealList"}


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


def feature_to_dict(feat, defn):
    """Convert an OGR feature to a dict with attributes and geometry summary."""
    geom = feat.GetGeometryRef()
    feature = {
        "fid": feat.GetFID(),
        "attributes": {},
        "geometry": geometry_summary(geom),
    }
    for j in range(defn.GetFieldCount()):
        feature["attributes"][defn.GetFieldDefn(j).GetName()] = feat.GetField(j)
    return feature


def field_name_for_match(name):
    """Normalize common camelCase field names before semantic matching."""
    return re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()


def field_skip_reason(field):
    """Return why a field should not be counted, or None when countable."""
    if (
        field["type"] in _TEMPORAL_FIELD_TYPES
        or _TEMPORAL_FIELD_RE.search(field_name_for_match(field["name"]))
    ):
        return "temporal fields are skipped because timestamps usually have high cardinality and are not categorical values"
    if field["type"] == "Real":
        return "real-valued numeric fields are skipped because exact-value frequency is usually not meaningful"
    if field["type"] in _LIST_FIELD_TYPES:
        return "list fields are skipped because each record can contain multiple values"
    if field["type"] == "Binary":
        return "binary fields are skipped because they are not useful as categorical text values"
    if field["type"] not in _COUNTABLE_FIELD_TYPES:
        return f"unsupported field type: {field['type']}"
    return None


# Stop counting a field once it exceeds this many distinct values. Such a
# field would be reported as "all unique / not useful" after the scan anyway,
# but on multi-million-row tables its Counter would keep growing for the
# whole pass -- this turns an unbounded memory+time cost into the same
# end result, declared early.
HIGH_CARDINALITY_LIMIT = 100_000


def empty_field_stat(field):
    """Build an internal accumulator for one field."""
    reason = field_skip_reason(field)
    return {
        "name": field["name"],
        "type": field["type"],
        "status": "skipped" if reason else "counted",
        "reason": reason,
        "non_null_count": 0,
        "null_count": 0,
        "counts": Counter(),
    }


def skipped_field_output(stat, reason):
    return {
        "name": stat["name"],
        "type": stat["type"],
        "null_count": stat["null_count"],
        "top_values": reason,
    }


def field_stat_output(stat, top_n):
    if stat["status"] == "skipped":
        return skipped_field_output(stat, stat["reason"])
    if stat["non_null_count"] > 1 and len(stat["counts"]) == stat["non_null_count"]:
        return skipped_field_output(
            stat,
            "all non-null values are unique, so top-value frequency is not useful",
        )
    return {
        "name": stat["name"],
        "type": stat["type"],
        "null_count": stat["null_count"],
        "top_values": [
            {
                # Counter keys ARE the raw OGR values: countable types are
                # only String/Integer/Integer64, all hashable + JSON-safe.
                "value": value,
                "count": count,
            }
            for value, count in stat["counts"].most_common(top_n)
        ],
    }


def _merge_array_into_stat(np, arr, stat, high_cardinality_reason):
    """Fold one numpy column batch into a field stat accumulator."""
    if np.ma.isMaskedArray(arr):
        stat["null_count"] += int(np.ma.count_masked(arr))
        data = arr.compressed()
    elif arr.dtype == object:
        null_mask = np.array([v is None for v in arr], dtype=bool)
        stat["null_count"] += int(null_mask.sum())
        data = arr[~null_mask]
    else:
        data = arr
    if stat["status"] != "counted" or data.size == 0:
        return
    stat["non_null_count"] += int(data.size)
    counts = stat["counts"]
    values, value_counts = np.unique(data, return_counts=True)
    for value, count in zip(values, value_counts):
        if isinstance(value, bytes):
            value = value.decode("utf-8", "replace")
        elif isinstance(value, np.bool_):
            # Match the OGR loop path: GetField on boolean-subtype fields
            # returns Python bools (verified on GDAL 3.12).
            value = bool(value)
        elif isinstance(value, np.integer):
            value = int(value)
        elif isinstance(value, np.str_):
            value = str(value)
        counts[value] += int(count)
    if len(counts) > HIGH_CARDINALITY_LIMIT:
        stat["status"] = "skipped"
        stat["reason"] = high_cardinality_reason
        stat["counts"] = Counter()


def arrow_field_statistics(layer, fields, top_n=10):
    """Field statistics via GDAL's Arrow batch interface (GDAL >= 3.6).

    Reads attribute columns in bulk C-level batches and counts them with
    numpy -- on real datasets this is one to two orders of magnitude faster
    than the per-feature OGR loop. Returns None when the fast path is
    unavailable (old GDAL, no numpy, driver quirk, any error), in which
    case the caller falls back to the exact same semantics in
    scan_statistics. Results are identical: exact full-table statistics.
    """
    try:
        import numpy as np

        if not hasattr(layer, "GetArrowStreamAsNumPy"):
            return None

        stats = [empty_field_stat(field) for field in fields]
        high_cardinality_reason = (
            f"more than {HIGH_CARDINALITY_LIMIT} distinct values, "
            "so top-value frequency is not useful"
        )

        try:
            layer.SetIgnoredFields(["OGR_GEOMETRY"])
        except Exception:
            pass
        stream = None
        try:
            layer.ResetReading()
            stream = layer.GetArrowStreamAsNumPy(
                options=["INCLUDE_GEOMETRY=NO", "MAX_FEATURES_IN_BATCH=65536"]
            )
            for batch in stream:
                for stat in stats:
                    arr = batch.get(stat["name"])
                    if arr is None:
                        continue
                    _merge_array_into_stat(np, arr, stat, high_cardinality_reason)
        finally:
            # Release the stream BEFORE any other read touches this layer: a
            # mid-iteration exception falls back to the OGR loop scan, and a
            # still-active ArrowStream would break ResetReading/GetNextFeature
            # on some drivers.
            del stream
            try:
                layer.SetIgnoredFields([])
            except Exception:
                pass

        return [field_stat_output(stat, top_n) for stat in stats]
    except Exception:
        return None


def scan_statistics(layer, fields, max_features, collect_geometry_types, top_n=10):
    """Single full-table pass: exact field value frequencies, plus a geometry
    type census when the declared layer type is ambiguous.

    This is the only O(feature_count) work in metadata mode, so it carries
    the performance contract for large datasets:
      - geometry parsing is skipped entirely (SetIgnoredFields) when no
        geometry census is needed -- polygon blobs dominate feature
        materialisation cost and the stats never look at them;
      - Counter keys are the raw OGR values, no per-value JSON encoding;
      - fields that are skipped from counting only ever answer IsFieldNull,
        never materialise a value;
      - the ambiguous-geometry census rides this same pass instead of a
        second full read.
    Statistics remain exact over the full table -- nothing is sampled.
    """
    stats = [empty_field_stat(field) for field in fields]
    geometry_types = {}

    ignored_geometry = False
    if not collect_geometry_types:
        try:
            layer.SetIgnoredFields(["OGR_GEOMETRY"])
            ignored_geometry = True
        except Exception:
            pass

    high_cardinality_reason = (
        f"more than {HIGH_CARDINALITY_LIMIT} distinct values, "
        "so top-value frequency is not useful"
    )

    layer.ResetReading()
    feat = layer.GetNextFeature()
    while feat is not None:
        for i, stat in enumerate(stats):
            if stat["status"] == "counted":
                value = feat.GetField(i)
                if value is None:
                    stat["null_count"] += 1
                    continue
                stat["non_null_count"] += 1
                counts = stat["counts"]
                counts[value] += 1
                if len(counts) > HIGH_CARDINALITY_LIMIT:
                    stat["status"] = "skipped"
                    stat["reason"] = high_cardinality_reason
                    stat["counts"] = Counter()
            elif feat.IsFieldNull(i):
                stat["null_count"] += 1
        if collect_geometry_types:
            geom = feat.GetGeometryRef()
            gname = geom.GetGeometryName() if geom else "NONE"
            entry = geometry_types.setdefault(gname, {"count": 0, "fids": []})
            entry["count"] += 1
            if len(entry["fids"]) < max_features:
                entry["fids"].append(feat.GetFID())
        feat = layer.GetNextFeature()

    if ignored_geometry:
        try:
            layer.SetIgnoredFields([])
        except Exception:
            pass

    return [field_stat_output(stat, top_n) for stat in stats], geometry_types


def read_layer_detail(layer, max_features, offset):
    """Read detailed info for a single layer."""
    srs, srs_warning = layer_spatial_ref(layer)
    defn = layer.GetLayerDefn()

    fields = []
    for j in range(defn.GetFieldCount()):
        fd = defn.GetFieldDefn(j)
        fields.append({
            "name": fd.GetName(),
            "type": fd.GetTypeName(),
        })

    extent = layer.GetExtent()

    crs, crs_name, crs_warning = resolve_crs(srs, srs_warning)
    declared_geom_type = ogr.GeometryTypeToName(layer.GetGeomType())

    # The geometry census (needed when the declared type is ambiguous) rides
    # the same single pass as the field statistics -- see scan_statistics.
    # When no census is needed, prefer the Arrow bulk path (orders of
    # magnitude faster on large tables) and fall back to the loop scan.
    declared_is_ambiguous = declared_geom_type.lower() in ("unknown (any)", "geometry", "none")
    field_stats = None
    geometry_types = {}
    scan_engine = "ogr"
    if not declared_is_ambiguous:
        field_stats = arrow_field_statistics(layer, fields)
        if field_stats is not None:
            scan_engine = "arrow"
    if field_stats is None:
        field_stats, geometry_types = scan_statistics(layer, fields, max_features, declared_is_ambiguous)

    is_mixed = False
    if geometry_types:
        # Normalize single/multi variants to the same base type
        MULTI_MAP = {
            "MULTIPOLYGON": "POLYGON", "MULTILINESTRING": "LINESTRING",
            "MULTIPOINT": "POINT",
        }
        base_types = {MULTI_MAP.get(t, t) for t in geometry_types}
        is_mixed = len(base_types) > 1

    layer_info = {
        "data_type": "vector",
        "name": layer.GetName(),
        "geometry_type": declared_geom_type,
    }
    if geometry_types:
        layer_info["geometry_type_statistics"] = {k: v["count"] for k, v in geometry_types.items()}

    layer_info.update({
        "feature_count": layer.GetFeatureCount(),
        "crs": crs,
        "crs_name": crs_name,
        "crs_warning": crs_warning,
        "extent": {
            "xmin": extent[0],
            "xmax": extent[1],
            "ymin": extent[2],
            "ymax": extent[3],
        },
        # Delegate WGS84 detection to extent_to_wgs84 (which clones srs and forces
        # OAMS_TRADITIONAL_GIS_ORDER before comparing) so WGS84 datasets get the
        # original extent echoed back rather than null. Keeping the field always-
        # populated also matches raster_read.py -- both modes expose the same
        # bounding-box-in-degrees regardless of source CRS.
        "extent_wgs84": extent_to_wgs84(srs, extent[0], extent[1], extent[2], extent[3]),
        # Which statistics engine ran -- "arrow" (GDAL bulk batches) or "ogr"
        # (per-feature loop fallback). Same exact results either way; kept in
        # the output so slow-read reports can tell which path the file took.
        "scan_engine": scan_engine,
        "fields": field_stats,
        "features": [],
    })

    if is_mixed:
        # Mixed geometry: sample each type, prioritize complex geometries
        layer_info["geometry_types"] = layer_info["geometry_type_statistics"]

        type_order = ["MULTIPOLYGON", "POLYGON", "MULTILINESTRING", "LINESTRING",
                       "MULTIPOINT", "POINT", "GEOMETRYCOLLECTION"]
        sorted_types = sorted(geometry_types.keys(),
                              key=lambda t: type_order.index(t) if t in type_order else len(type_order))

        remaining = max_features
        for gname in sorted_types:
            if remaining <= 0:
                break
            sample_count = max(1, remaining // max(1, len(sorted_types)))
            fids = geometry_types[gname]["fids"][:sample_count]
            for fid in fids:
                feat = layer.GetFeature(fid)
                if feat:
                    layer_info["features"].append(feature_to_dict(feat, defn))
                    remaining -= 1
    else:
        # Uniform geometry: sequential sampling with offset (original behavior)
        layer.ResetReading()
        layer.SetNextByIndex(offset - 1)
        count = 0
        while count < max_features:
            feat = layer.GetNextFeature()
            if feat is None:
                break
            layer_info["features"].append(feature_to_dict(feat, defn))
            count += 1

    return layer_info


def read_vector(file_path, max_features=3, offset=1, layer_index=None):
    ds = ogr.Open(file_path)
    if ds is None:
        raise RuntimeError(f"Cannot open vector file: {file_path}")

    driver = ds.GetDriver().GetName()
    layer_count = ds.GetLayerCount()

    if layer_index is None:
        layer_index = 0

    if layer_index < 0 or layer_index >= layer_count:
        raise RuntimeError(
            f"layer_index {layer_index} out of range. "
            f"This file has {layer_count} layer(s) (valid range: 0-{layer_count - 1})."
        )

    result = {
        "driver": driver,
        "layer_index": layer_index,
    }

    # Multi-layer sources get an overview so the caller can see what else the
    # file holds. (The previous build limited this to GeoPackage; any
    # multi-layer driver benefits, so the condition is on the count alone.)
    if layer_count > 1:
        layers_summary = []
        for i in range(layer_count):
            lyr = ds.GetLayerByIndex(i)
            layers_summary.append({
                "index": i,
                "name": lyr.GetName(),
                "geometry_type": ogr.GeometryTypeToName(lyr.GetGeomType()),
                "feature_count": lyr.GetFeatureCount(),
            })
        result["overview"] = {
            "driver": driver,
            "layer_count": layer_count,
            "layers": layers_summary,
        }

    target_layer = ds.GetLayerByIndex(layer_index)
    result["layer"] = read_layer_detail(target_layer, max_features, offset)

    ds = None
    return result


if __name__ == "__main__":
    try:
        file_path = sys.argv[1]
        max_features = int(sys.argv[2]) if len(sys.argv) > 2 else 3
        offset = int(sys.argv[3]) if len(sys.argv) > 3 else 1
        layer_index = int(sys.argv[4]) if len(sys.argv) > 4 else None
        emit(read_vector(file_path, max_features, offset, layer_index), 0)
    except Exception as e:
        emit({"error": str(e)}, 1)
