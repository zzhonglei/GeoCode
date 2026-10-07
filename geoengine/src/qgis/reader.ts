export * as Reader from "./reader.ts"

import { Schema } from "effect"
import { Python } from "./python.ts"

/**
 * Opens a dataset read-only and leaves nothing beside it; needs `gdal` and `os`. `file` is the file on disk, which a
 * subdataset's target only names.
 */
const OPENING = String.raw`
def untouched(target, flags, file):
    identified = gdal.IdentifyDriverEx(target, flags)
    driver = identified.ShortName if identified is not None else None
    # Without an .xsd the GML driver writes a .gfs beside the data.
    if driver == "GML":
        return ["WRITE_GFS=NO"]
    # SQLite would write a -wal and a -shm beside a GeoPackage in WAL mode. Without a -wal there, the file holds all of
    # its data; with one, another program has it open, and its changes are read too.
    if driver == "GPKG" and not os.path.exists(file + "-wal"):
        return ["IMMUTABLE=YES"]
    return []


def open_dataset(target, flags, options=(), file=None):
    try:
        opening = untouched(target, flags, file or target) + list(options)
        return gdal.OpenEx(target, flags | gdal.OF_READONLY, open_options=opening)
    except Exception:
        return None
`

/**
 * Reads a dataset with QGIS's own GDAL, never starting QGIS itself, and reports the facts as JSON; `Geodata` words
 * them.
 */
export const READ =
  Python.prelude +
  String.raw`
import math
import re
import time

from osgeo import gdal, ogr, osr

gdal.UseExceptions()
request = json.loads(REQUEST)


# JSON has no NaN or infinity, which nodata values and statistics can be; and JavaScript rounds an integer past 2^53,
# as 64-bit identifiers often are.
def clean(value):
    if isinstance(value, float) and not math.isfinite(value):
        return "NaN" if math.isnan(value) else ("Infinity" if value > 0 else "-Infinity")
    if isinstance(value, int) and abs(value) > 2**53:
        return str(value)
    if isinstance(value, dict):
        return {key: clean(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(item) for item in value]
    return value


def done(payload):
    finish(clean(payload))


sys.excepthook = lambda kind, error, trace: done(
    {"kind": "error", "message": str(error), "error": "".join(traceback.format_exception(kind, error, trace))}
)

beat = [time.monotonic()]


# A line now and then, so the task's idle clock does not end a long read.
def heartbeat(*_):
    now = time.monotonic()
    if now - beat[0] >= 2:
        beat[0] = now
        emit({"alive": True})
    return 1


TEXT_LIMIT = 300


def short(text):
    return text if len(text) <= TEXT_LIMIT else text[:TEXT_LIMIT] + "…"


def crs_facts(srs):
    if srs is None:
        return None
    srs = srs.Clone()
    facts = {"name": srs.GetName() or "", "geographic": bool(srs.IsGeographic()), "code": None, "proj": None}
    try:
        srs.AutoIdentifyEPSG()
    except Exception:
        pass
    authority, code = srs.GetAuthorityName(None), srs.GetAuthorityCode(None)
    if authority and code:
        facts["code"] = authority + ":" + code
    else:
        try:
            facts["proj"] = srs.ExportToProj4().strip() or None
        except Exception:
            pass
    facts["unit"] = (srs.GetAngularUnitsName() if srs.IsGeographic() else srs.GetLinearUnitsName()) or None
    facts["metres"] = None if srs.IsGeographic() else srs.GetLinearUnits()
    facts["ellipsoid"] = [srs.GetSemiMajor(), srs.GetInvFlattening()]
    return facts


def lonlat(srs, extent):
    if srs is None or extent is None or srs.IsGeographic():
        return None
    source = srs.Clone()
    source.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    target = osr.SpatialReference()
    target.ImportFromEPSG(4326)
    target.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    try:
        bounds = osr.CoordinateTransformation(source, target).TransformBounds(*extent, 21)
    except Exception:
        return None
    return list(bounds) if all(math.isfinite(value) for value in bounds) else None


path = request["path"]
if not os.path.exists(path):
    done({"kind": "missing"})

` +
  OPENING +
  String.raw`

vector = open_dataset(path, gdal.OF_VECTOR)
raster = open_dataset(path, gdal.OF_RASTER)
if vector is None and raster is None:
    done({"kind": "unopenable", "directory": os.path.isdir(path), "error": gdal.GetLastErrorMsg()})
DRIVER = (vector or raster).GetDriver().LongName

FLAT = {
    ogr.wkbPoint: "Point",
    ogr.wkbLineString: "LineString",
    ogr.wkbPolygon: "Polygon",
    ogr.wkbMultiPoint: "MultiPoint",
    ogr.wkbMultiLineString: "MultiLineString",
    ogr.wkbMultiPolygon: "MultiPolygon",
    ogr.wkbGeometryCollection: "GeometryCollection",
    ogr.wkbCircularString: "CircularString",
    ogr.wkbCompoundCurve: "CompoundCurve",
    ogr.wkbCurvePolygon: "CurvePolygon",
    ogr.wkbMultiCurve: "MultiCurve",
    ogr.wkbMultiSurface: "MultiSurface",
    ogr.wkbTriangle: "Triangle",
    ogr.wkbTIN: "TIN",
    ogr.wkbPolyhedralSurface: "PolyhedralSurface",
}
BASE = {
    ogr.wkbPoint: "point",
    ogr.wkbMultiPoint: "point",
    ogr.wkbLineString: "line",
    ogr.wkbMultiLineString: "line",
    ogr.wkbCircularString: "line",
    ogr.wkbCompoundCurve: "line",
    ogr.wkbMultiCurve: "line",
    ogr.wkbPolygon: "polygon",
    ogr.wkbMultiPolygon: "polygon",
    ogr.wkbCurvePolygon: "polygon",
    ogr.wkbMultiSurface: "polygon",
    ogr.wkbTriangle: "polygon",
    ogr.wkbTIN: "polygon",
    ogr.wkbPolyhedralSurface: "polygon",
}
MULTI = {"Point": "MultiPoint", "LineString": "MultiLineString", "Polygon": "MultiPolygon"}


# As QGIS names geometry types.
def type_name(kind, multi=False):
    name = FLAT.get(ogr.GT_Flatten(kind), "Unknown")
    if multi:
        name = MULTI.get(name, name)
    return name + ("Z" if ogr.GT_HasZ(kind) else "") + ("M" if ogr.GT_HasM(kind) else "")


def shapefile(layer):
    return layer.GetDataset().GetDriver().ShortName == "ESRI Shapefile"


def declared(layer):
    kind = layer.GetGeomType()
    if ogr.GT_Flatten(kind) == ogr.wkbNone:
        return None
    # A shapefile does not record whether a line or polygon has one part or several; QGIS reads them as multipart.
    return type_name(kind, shapefile(layer) and ogr.GT_Flatten(kind) in (ogr.wkbLineString, ogr.wkbPolygon))


def vector_layers():
    if vector is None:
        return []
    layers = [vector.GetLayerByIndex(index) for index in range(vector.GetLayerCount())]
    # QGIS keeps its styles and projects in tables of a GeoPackage, and does not list them as layers.
    if vector.GetDriver().ShortName == "GPKG":
        return [layer for layer in layers if layer.GetName() not in ("layer_styles", "qgis_projects")]
    return layers


def subdataset_name(name):
    for spelled in ('"' + path + '"', path):
        at = name.find(spelled + ":")
        if at >= 0:
            return name[at + len(spelled) + 1 :]
    return name.rsplit(":", 1)[-1]


# Each raster in the file, by name, with what opens it.
def raster_layers():
    if raster is None:
        return []
    subdatasets = raster.GetMetadata("SUBDATASETS") or {}
    found = []
    while subdatasets.get("SUBDATASET_%d_NAME" % (len(found) + 1)):
        full = subdatasets["SUBDATASET_%d_NAME" % (len(found) + 1)]
        found.append((subdataset_name(full), full, []))
    if found:
        return found
    if raster.RasterCount == 0:
        return []
    # The one raster table of a GeoPackage, named as QGIS names it; the file opens to it.
    table = raster.GetMetadataItem("IDENTIFIER") if raster.GetDriver().ShortName == "GPKG" else None
    return [(table, path, [])]


def listed():
    entries = []
    for layer in vector_layers():
        entry = {"name": layer.GetName(), "count": layer.GetFeatureCount()}
        if ogr.GT_Flatten(layer.GetGeomType()) == ogr.wkbNone:
            entry["kind"] = "table"
        else:
            entry.update({"kind": "vector", "geometry": declared(layer), "crs": crs_facts(layer.GetSpatialRef())})
        entries.append(entry)
    for name, target, options in raster_layers():
        dataset = open_dataset(target, gdal.OF_RASTER, options, path)
        if dataset is not None:
            entries.append(
                {
                    "name": name,
                    "kind": "raster",
                    "width": dataset.RasterXSize,
                    "height": dataset.RasterYSize,
                    "bands": dataset.RasterCount,
                    "crs": crs_facts(dataset.GetSpatialRef()),
                }
            )
    return entries


layers = listed()
wanted = request.get("layer")
if wanted is None and len(layers) != 1:
    done({"kind": "layers", "driver": DRIVER, "layers": layers})
chosen = layers[0] if wanted is None else next((entry for entry in layers if entry["name"] == wanted), None)
if chosen is None:
    done({"kind": "no-layer", "driver": DRIVER, "layer": wanted, "layers": layers})
common = {"driver": DRIVER, "layer": chosen["name"], "layers": len(layers)}


def refuse(reason, **details):
    done(dict({"kind": "refused", "reason": reason}, **details))


# Shapefile text: the encoding the file declares, else UTF-8 when it is valid, else the likeliest of those used in
# GeoCode's regions.
CANDIDATES = {"utf_8": "UTF-8", "gb18030": "GB18030", "cp950": "CP950", "cp1252": "CP1252"}
# Below this many bytes outside ASCII, a detected encoding is a guess.
WEAK = 32


def reopened(encoding):
    dataset = gdal.OpenEx(path, gdal.OF_VECTOR | gdal.OF_READONLY, open_options=["ENCODING=" + encoding])
    return dataset, dataset.GetLayerByName(chosen["name"])


def raw_text(layer):
    defn = layer.GetLayerDefn()
    strings = [i for i in range(defn.GetFieldCount()) if defn.GetFieldDefn(i).GetType() == ogr.OFTString]
    # Field names too: a table of numbers can still name its fields in Chinese.
    text = bytearray()
    for i in range(defn.GetFieldCount()):
        text += defn.GetFieldDefn(i).GetName().encode("utf-8", "surrogateescape") + b"\n"
    layer.ResetReading()
    for feature in layer:
        heartbeat()
        for i in strings:
            if feature.IsFieldSetAndNotNull(i):
                text += feature.GetFieldAsString(i).encode("utf-8", "surrogateescape") + b"\n"
        if len(text) > 4 * 1024 * 1024:
            break
    return bytes(text)


def encoding_of(layer):
    given = request.get("encoding")
    if given:
        dataset, layer = reopened(given)
        # GDAL ignores an encoding it does not know, rather than refusing it.
        if not (layer.GetMetadata_Dict("SHAPEFILE") or {}).get("SOURCE_ENCODING"):
            refuse("encoding", encoding=given)
        return dataset, layer, {"name": given, "source": "given"}
    declared_encoding = layer.GetMetadata_Dict("SHAPEFILE") or {}
    claimed = declared_encoding.get("SOURCE_ENCODING")
    source = "cpg" if declared_encoding.get("ENCODING_FROM_CPG") else "ldid"
    # A .cpg that says UTF-8 is checked: tools write one for text they never converted, and other text is rarely valid
    # UTF-8. Any other encoding decodes any bytes, so cannot be checked.
    checked = source == "cpg" and claimed and claimed.replace("-", "").upper() == "UTF8"
    if claimed and not checked:
        return None, layer, {"name": claimed, "source": source}
    text = raw_text(layer)
    try:
        text.decode("utf-8")
        return None, layer, {"name": claimed, "source": "cpg"} if claimed else {"name": "UTF-8", "source": "utf-8"}
    except UnicodeDecodeError:
        pass
    import charset_normalizer

    best = charset_normalizer.from_bytes(text, cp_isolation=list(CANDIDATES)).best()
    name = CANDIDATES.get(best.encoding if best is not None else "gb18030", "GB18030")
    dataset, layer = reopened(name)
    weak = sum(1 for byte in text if byte > 127) < WEAK
    facts = {"name": name, "source": "detected", "weak": weak}
    if claimed:
        facts["cpg"] = claimed
    return dataset, layer, facts


HIGH_CARDINALITY = 100000
# An integer field with this many distinct values or fewer is counted like text; with more, it is measured.
CATEGORIES = 32
TOP = 10
COUNTED = ("text", "json", "integer")
NESTED = object()


def field_kinds(defn):
    kinds = []
    for i in range(defn.GetFieldCount()):
        field = defn.GetFieldDefn(i)
        kind, subtype = field.GetType(), field.GetSubType()
        if subtype == ogr.OFSTJSON:
            role, label = "json", "JSON"
        elif subtype == ogr.OFSTBoolean:
            role, label = "text", "Boolean"
        elif kind == ogr.OFTString:
            role, label = "text", "String"
        elif kind in (ogr.OFTInteger, ogr.OFTInteger64):
            role, label = "integer", field.GetTypeName()
        elif kind == ogr.OFTReal:
            role, label = "real", "Real"
        elif kind in (ogr.OFTDate, ogr.OFTTime, ogr.OFTDateTime):
            role, label = "time", field.GetTypeName()
        else:
            role, label = "other", field.GetTypeName()
        kinds.append({"name": field.GetName(), "type": label, "role": role})
    return kinds


class Stat:
    def __init__(self, role):
        self.role = role
        self.present = 0
        self.counts = {} if role in COUNTED else None
        self.low = None
        self.high = None
        self.total = 0.0
        self.measured = 0

    def capped(self):
        limit = CATEGORIES if self.role == "integer" else HIGH_CARDINALITY
        if self.counts is not None and len(self.counts) > limit:
            self.counts = None

    def bound(self, value):
        if self.low is None or value < self.low:
            self.low = value
        if self.high is None or value > self.high:
            self.high = value

    def add(self, value):
        self.present += 1
        # Objects and lists are not values to count.
        if value is NESTED:
            self.counts = None
            return
        if self.counts is not None:
            self.counts[value] = self.counts.get(value, 0) + 1
            self.capped()
        # NaN is neither less nor greater than anything, and would stand for the whole field.
        if isinstance(value, float) and not math.isfinite(value):
            return
        if self.role in ("integer", "real", "time"):
            self.bound(value)
        if self.role in ("integer", "real"):
            self.total += value
            self.measured += 1

    def merge(self, other):
        self.present += other.present
        if self.counts is not None and other.counts is not None:
            for value, count in other.counts.items():
                self.counts[value] = self.counts.get(value, 0) + count
            self.capped()
        elif other.present:
            self.counts = None
        for value in (other.low, other.high):
            if value is not None:
                self.bound(value)
        self.total += other.total
        self.measured += other.measured

    def facts(self, kind):
        entry = {"name": kind["name"], "type": kind["type"], "present": self.present}
        if self.present == 0 or self.role == "other":
            return entry
        if self.counts is not None:
            ranked = sorted(self.counts.items(), key=lambda item: (-item[1], str(item[0])))
            entry["distinct"] = len(self.counts)
            entry["values"] = [
                [short(value) if isinstance(value, str) else value, count] for value, count in ranked[:TOP]
            ]
        elif self.role in ("integer", "real"):
            if self.measured:
                entry.update({"min": self.low, "max": self.high, "mean": self.total / self.measured})
        elif self.role == "time":
            entry.update({"min": self.low, "max": self.high})
        elif self.role == "text":
            entry["distinct"] = None
        return entry


# A number GDAL had to keep as text carries every digit of its binary value, 17 significant digits; the shortest
# spelling is the one written. Shorter text, such as "007" or "1.50", is as written.
def restored(text):
    digits = re.split("[eE]", text)[0].lstrip("+-").replace(".", "").lstrip("0")
    if len(digits) < 16 or not digits.isdigit():
        return text
    try:
        number = float(text)
    except ValueError:
        return text
    if not math.isfinite(number):
        return text
    shortest = repr(number)
    if shortest.endswith(".0") and "." not in text:
        shortest = shortest[:-2]
    return shortest if float(shortest) == number else text


def value_of(feature, index, role):
    if role == "time":
        return feature.GetFieldAsISO8601DateTime(index)
    if role == "json":
        text = feature.GetFieldAsString(index)
        return NESTED if text.lstrip()[:1] in ("{", "[") else restored(text)
    value = feature.GetField(index)
    return value if isinstance(value, (str, int, float)) else str(value)


def attribute(feature, index, kind):
    if feature.GetFieldDefnRef(index).GetType() == ogr.OFTBinary:
        return "<%d bytes of binary data>" % len(feature.GetFieldAsBinary(index))
    if kind["role"] == "json":
        text = feature.GetFieldAsString(index)
        try:
            parsed = json.loads(text)
        except ValueError:
            return short(text)
        if not isinstance(parsed, (dict, list)):
            return short(restored(text))
        # Whole while short; a long one is cut as text, as long text is.
        return parsed if len(text) <= TEXT_LIMIT else short(text)
    if kind["role"] == "time":
        return feature.GetFieldAsISO8601DateTime(index)
    value = feature.GetField(index)
    if isinstance(value, list):
        text = json.dumps(value, default=str, ensure_ascii=False)
        return value if len(text) <= TEXT_LIMIT else short(text)
    return short(value) if isinstance(value, str) else value


def geometry_facts(geometry):
    if geometry is None or geometry.IsEmpty():
        return None
    kind = geometry.GetGeometryType()
    facts = {"type": type_name(kind)}
    if ogr.GT_Flatten(kind) == ogr.wkbPoint:
        facts["point"] = [geometry.GetX(), geometry.GetY()]
        return facts
    xmin, xmax, ymin, ymax = geometry.GetEnvelope()
    facts["bbox"] = [xmin, ymin, xmax, ymax]
    base = BASE.get(ogr.GT_Flatten(kind))
    if base == "polygon":
        facts["area"] = geometry.GetArea()
    elif base == "line":
        facts["length"] = geometry.Length()
    return facts


def sample_of(feature, kinds, position):
    attributes = {}
    for index, kind in enumerate(kinds):
        if feature.IsFieldSetAndNotNull(index):
            attributes[kind["name"]] = attribute(feature, index, kind)
    return {"position": position, "attributes": attributes, "geometry": geometry_facts(feature.GetGeometryRef())}


def sequential(layer, kinds, offset, limit):
    layer.ResetReading()
    if offset > 1:
        layer.SetNextByIndex(offset - 1)
    samples = []
    while len(samples) < limit:
        feature = layer.GetNextFeature()
        if feature is None:
            break
        samples.append(sample_of(feature, kinds, offset + len(samples)))
    return samples


def read_vector():
    layer = next(layer for layer in vector_layers() if layer.GetName() == chosen["name"])
    # Held, so the layer reopened in another encoding stays open.
    dataset, encoding = None, None
    if shapefile(layer):
        dataset, layer, encoding = encoding_of(layer)
    kinds = field_kinds(layer.GetLayerDefn())
    offset = request.get("offset") or 1
    limit = request.get("limit") or 3
    # A layer that declares no single geometry type is surveyed feature by feature, and sampled by type.
    census = ogr.GT_Flatten(layer.GetGeomType()) == ogr.wkbUnknown
    groups = {}
    if not census:
        layer.SetIgnoredFields(["OGR_GEOMETRY"])
    layer.ResetReading()
    for feature in layer:
        heartbeat()
        name, kind = "all", None
        if census:
            geometry = feature.GetGeometryRef()
            if geometry is None or geometry.IsEmpty():
                name = "none"
            else:
                kind = geometry.GetGeometryType()
                name = BASE.get(ogr.GT_Flatten(kind), "collection")
        if name not in groups:
            groups[name] = {"count": 0, "stats": [Stat(entry["role"]) for entry in kinds], "fids": [], "types": set()}
        group = groups[name]
        group["count"] += 1
        if kind is not None:
            group["types"].add(kind)
        if census and offset <= group["count"] < offset + limit:
            group["fids"].append(feature.GetFID())
        for index, stat in enumerate(group["stats"]):
            if feature.IsFieldSetAndNotNull(index):
                stat.add(value_of(feature, index, kinds[index]["role"]))
    layer.SetIgnoredFields([])

    bases = [name for name in groups if name not in ("all", "none")]
    if len(bases) > 1:
        sections = []
        for name in ("point", "line", "polygon", "collection", "none"):
            if name in groups:
                group = groups[name]
                samples = [sample_of(layer.GetFeature(fid), kinds, offset + i) for i, fid in enumerate(group["fids"])]
                sections.append((name, group, samples))
        return vector_done(layer, kinds, encoding, None, sections, offset, limit, True)
    geometry = declared(layer)
    if census:
        # One kind of geometry, perhaps beside features without any; multipart if any feature is, as QGIS types it,
        # and with Z or M if any feature has them, which the highest code carries.
        types = set().union(*(group["types"] for group in groups.values())) if groups else set()
        names = {FLAT.get(ogr.GT_Flatten(kind), "") for kind in types}
        geometry = type_name(max(types), any(name.startswith("Multi") for name in names)) if types else None
    merged = {"count": 0, "stats": [Stat(entry["role"]) for entry in kinds]}
    for group in groups.values():
        merged["count"] += group["count"]
        for into, stat in zip(merged["stats"], group["stats"]):
            into.merge(stat)
    # GDAL fails to move past the last feature rather than reading none.
    samples = sequential(layer, kinds, offset, limit) if offset <= merged["count"] else []
    placed = not census or geometry is not None
    vector_done(layer, kinds, encoding, geometry, [("all", merged, samples)], offset, limit, placed)


# placed: false for a surveyed layer in which no feature has a geometry, whose extent GDAL gives as zeros.
def vector_done(layer, kinds, encoding, geometry, sections, offset, limit, placed):
    count = sum(group["count"] for _, group, _ in sections)
    extent = None
    if count and placed and ogr.GT_Flatten(layer.GetGeomType()) != ogr.wkbNone:
        try:
            xmin, xmax, ymin, ymax = layer.GetExtent()
            extent = [xmin, ymin, xmax, ymax]
        except Exception:
            pass
    done(
        dict(
            common,
            kind="table" if ogr.GT_Flatten(layer.GetGeomType()) == ogr.wkbNone else "vector",
            geometry=geometry,
            shapefile=shapefile(layer),
            count=count,
            crs=crs_facts(layer.GetSpatialRef()),
            extent=extent,
            lonlat=lonlat(layer.GetSpatialRef(), extent),
            encoding=encoding,
            offset=offset,
            limit=limit,
            groups=[
                {
                    "type": name,
                    "count": group["count"],
                    "fields": [stat.facts(kind) for stat, kind in zip(group["stats"], kinds)],
                    "samples": samples,
                }
                for name, group, samples in sections
            ],
        )
    )


def georeferencing(dataset):
    transform = dataset.GetGeoTransform(can_return_null=True)
    # GDAL hands back this identity for a raster that has no transform.
    if transform is not None and tuple(transform) != (0.0, 1.0, 0.0, 0.0, 0.0, 1.0) and transform[1] and transform[5]:
        return "transform"
    if dataset.GetGCPCount() > 0:
        return "gcp"
    if dataset.GetMetadata("RPC"):
        return "rpc"
    if dataset.GetMetadata("GEOLOCATION"):
        return "geolocation"
    if dataset.GetSpatialRef() is not None:
        return "crs-only"
    return "none"


INTEGERS = {gdal.GDT_Byte, gdal.GDT_UInt16, gdal.GDT_Int16, gdal.GDT_UInt32, gdal.GDT_Int32}
INTEGERS |= {getattr(gdal, name) for name in ("GDT_Int8", "GDT_UInt64", "GDT_Int64") if hasattr(gdal, name)}


def band_facts(band):
    names = band.GetCategoryNames() or []
    facts = {
        "index": band.GetBand(),
        "name": band.GetDescription() or None,
        "type": gdal.GetDataTypeName(band.DataType),
        "nodata": band.GetNoDataValue(),
        "unit": band.GetUnitType() or None,
        "scale": band.GetScale() if band.GetScale() not in (None, 1.0) else None,
        "offset": band.GetOffset() if band.GetOffset() not in (None, 0.0) else None,
        "colors": band.GetColorTable() is not None,
        "names": {str(value): name for value, name in enumerate(names) if name},
    }
    return facts


def measure(target, options, bands):
    # From every pixel, worked out afresh: a .aux.xml may hold approximate statistics, and GDAL would save these in one.
    gdal.SetConfigOption("GDAL_PAM_ENABLED", "NO")
    dataset = gdal.OpenEx(
        target, gdal.OF_RASTER | gdal.OF_READONLY, open_options=untouched(target, gdal.OF_RASTER, path) + options
    )
    pixels = dataset.RasterXSize * dataset.RasterYSize
    for facts in bands:
        band = dataset.GetRasterBand(facts["index"])
        # Nodata kept in the .aux.xml, which this dataset no longer reads.
        if facts["nodata"] is not None and band.GetNoDataValue() != facts["nodata"]:
            band.SetNoDataValue(facts["nodata"])
        try:
            low, high, mean, deviation = band.ComputeStatistics(False, callback=heartbeat)
        except Exception:
            facts["valid"] = 0
            continue
        facts["stats"] = {"min": low, "max": high, "mean": mean, "std": deviation}
        percent = band.GetMetadataItem("STATISTICS_VALID_PERCENT")
        facts["valid"] = float(percent) / 100 if percent is not None else None
        if band.DataType not in INTEGERS or high - low > 65535:
            continue
        histogram = band.GetHistogram(low - 0.5, high + 0.5, int(high - low) + 1, 0, 0, callback=heartbeat)
        present = [[int(low) + i, count] for i, count in enumerate(histogram) if count]
        if facts["valid"] is None and pixels:
            facts["valid"] = sum(count for _, count in present) / pixels
        if facts["colors"] or facts["names"] or len(present) <= CATEGORIES:
            facts["categories"] = sorted(present, key=lambda item: -item[1])


def raster_dataset():
    for name, target, options in raster_layers():
        if name == chosen["name"]:
            return target, options
    return path, []


def read_raster():
    target, options = raster_dataset()
    dataset = open_dataset(target, gdal.OF_RASTER, options, path)
    verdict = georeferencing(dataset)
    if verdict == "none":
        done(dict(common, kind="not-geographic"))
    bands = [band_facts(dataset.GetRasterBand(i + 1)) for i in range(dataset.RasterCount)]
    if request.get("preview"):
        preview(dataset, bands)
    width, height = dataset.RasterXSize, dataset.RasterYSize
    transform = list(dataset.GetGeoTransform())
    extent = None
    if verdict == "transform":
        corners = [(0, 0), (width, 0), (0, height), (width, height)]
        xs = [transform[0] + transform[1] * col + transform[2] * row for col, row in corners]
        ys = [transform[3] + transform[4] * col + transform[5] * row for col, row in corners]
        extent = [min(xs), min(ys), max(xs), max(ys)]
    measure(target, options, bands)
    done(
        dict(
            common,
            kind="raster",
            width=width,
            height=height,
            crs=crs_facts(dataset.GetSpatialRef()),
            georeferencing=verdict,
            transform=transform if verdict == "transform" else None,
            extent=extent,
            lonlat=lonlat(dataset.GetSpatialRef(), extent),
            bands=bands,
        )
    )


# QGIS's default contrast enhancement: each band stretched between these percentiles of its values.
CUT = (2, 98)
PREVIEW_SIDE = 2000
# As many values as a colour table usually holds; a band with more is shown in grey, its legend too long to read.
LEGEND = 256
# For categories without a colour table: distinct colours, named so the legend can say which is which.
PALETTE = [
    ("red", (230, 25, 75)),
    ("green", (60, 180, 75)),
    ("yellow", (255, 225, 25)),
    ("blue", (0, 130, 200)),
    ("orange", (245, 130, 48)),
    ("purple", (145, 30, 180)),
    ("cyan", (70, 240, 240)),
    ("magenta", (240, 50, 230)),
    ("lime", (210, 245, 60)),
    ("pink", (250, 190, 212)),
    ("teal", (0, 128, 128)),
    ("lavender", (220, 190, 255)),
    ("brown", (170, 110, 40)),
    ("beige", (255, 250, 200)),
    ("maroon", (128, 0, 0)),
    ("mint", (170, 255, 195)),
    ("olive", (128, 128, 0)),
    ("apricot", (255, 215, 180)),
    ("navy", (0, 0, 128)),
    ("grey", (128, 128, 128)),
    ("white", (255, 255, 255)),
    ("black", (0, 0, 0)),
    ("dark green", (0, 90, 30)),
    ("sky blue", (135, 206, 250)),
    ("gold", (200, 160, 0)),
    ("dark red", (90, 0, 20)),
    ("light green", (180, 230, 140)),
    ("violet", (100, 60, 160)),
    ("salmon", (250, 128, 114)),
    ("dark blue", (20, 40, 90)),
    ("tan", (210, 180, 140)),
    ("dark grey", (64, 64, 64)),
]


def preview(dataset, bands):
    import base64

    import numpy

    count = dataset.RasterCount
    asked = request.get("bands")
    if asked:
        if len(asked) not in (1, 3) or any(not 1 <= index <= count for index in asked):
            refuse("bands", bands=asked, count=count)
        shown = list(asked)
    else:
        colors = [
            gdal.GetColorInterpretationName(dataset.GetRasterBand(index).GetColorInterpretation()).lower()
            for index in range(1, count + 1)
        ]
        rgb = ("red", "green", "blue")
        shown = [colors.index(color) + 1 for color in rgb] if set(rgb) <= set(colors) else [1]
    width, height = dataset.RasterXSize, dataset.RasterYSize
    scale = min(1.0, PREVIEW_SIDE / max(width, height))
    columns, rows = max(1, round(width * scale)), max(1, round(height * scale))

    def read(index):
        band = dataset.GetRasterBand(index)
        # A large raster without overviews is read whole to be scaled down.
        data = band.ReadAsArray(buf_xsize=columns, buf_ysize=rows, callback=heartbeat).astype("float64")
        valid = numpy.isfinite(data)
        if band.GetNoDataValue() is not None:
            valid &= data != band.GetNoDataValue()
        flags = band.GetMaskFlags()
        if not flags & (gdal.GMF_ALL_VALID | gdal.GMF_NODATA):
            mask = band.GetMaskBand().ReadAsArray(buf_xsize=columns, buf_ysize=rows, callback=heartbeat)
            valid &= mask > 0
        return band, data, valid

    image = numpy.zeros((4, rows, columns), dtype="uint8")
    legend, ranges = None, []
    if len(shown) == 3:
        mode = "rgb"
        opaque = numpy.ones((rows, columns), dtype=bool)
        for channel, index in enumerate(shown):
            _, data, valid = read(index)
            low, high = cut(numpy, data[valid])
            ranges.append([low, high])
            image[channel] = stretch(numpy, data, low, high)
            opaque &= valid
        image[3][opaque] = 255
    else:
        band, data, valid = read(shown[0])
        facts = bands[shown[0] - 1]
        values = numpy.unique(data[valid]).tolist() if band.DataType in INTEGERS else None
        named = facts["colors"] or facts["names"]
        if values is not None and (len(values) <= CATEGORIES or named and len(values) <= LEGEND):
            mode = "categories"
            table = band.GetColorTable()
            legend = []
            for position, value in enumerate(int(value) for value in values):
                if table is not None and 0 <= value < table.GetCount():
                    color = tuple(table.GetColorEntry(value))[:3]
                    label = "rgb(%d, %d, %d)" % color
                else:
                    label, color = PALETTE[position % len(PALETTE)]
                hit = valid & (data == value)
                for channel in range(3):
                    image[channel][hit] = color[channel]
                legend.append([value, label])
        else:
            mode = "gray"
            low, high = cut(numpy, data[valid])
            ranges.append([low, high])
            grey = stretch(numpy, data, low, high)
            for channel in range(3):
                image[channel] = grey
        image[3][valid] = 255
    if not image[3].any():
        refuse("empty", bands=shown, size=[columns, rows] if scale < 1 else None)
    memory = gdal.GetDriverByName("MEM").Create("", columns, rows, 4, gdal.GDT_Byte)
    for channel in range(4):
        memory.GetRasterBand(channel + 1).WriteArray(image[channel])
    name = "/vsimem/geocode-preview.png"
    gdal.GetDriverByName("PNG").CreateCopy(name, memory)
    png = gdal.VSIGetMemFileBuffer_unsafe(name)
    done(
        dict(
            common,
            kind="preview",
            width=columns,
            height=rows,
            original=[width, height],
            count=count,
            bands=[{"index": index, "name": bands[index - 1]["name"]} for index in shown],
            mode=mode,
            ranges=ranges,
            legend=legend,
            png=base64.b64encode(bytes(png)).decode("ascii"),
        )
    )


def cut(numpy, values):
    if values.size == 0:
        return [0.0, 0.0]
    low, high = numpy.percentile(values, CUT)
    return [float(low), float(high)]


def stretch(numpy, data, low, high):
    if high <= low:
        return numpy.full(data.shape, 128, dtype="uint8")
    return numpy.clip(numpy.nan_to_num((data - low) / (high - low) * 255), 0, 255).astype("uint8")


if chosen["kind"] == "raster":
    read_raster()
if request.get("preview"):
    refuse("preview-vector")
read_vector()
`

const Num = Schema.Union([Schema.Number, Schema.Literals(["NaN", "Infinity", "-Infinity"])])

const Crs = Schema.NullOr(
  Schema.Struct({
    name: Schema.String,
    geographic: Schema.Boolean,
    code: Schema.NullOr(Schema.String),
    proj: Schema.NullOr(Schema.String),
    unit: Schema.NullOr(Schema.String),
    /** Metres per unit of a projected CRS. */
    metres: Schema.NullOr(Schema.Number),
    /** Semi-major axis and inverse flattening, 0 for a sphere. */
    ellipsoid: Schema.Tuple([Schema.Number, Schema.Number]),
  }),
)
export type Crs = typeof Crs.Type

const Box = Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number])

const Layer = Schema.Union([
  Schema.Struct({
    name: Schema.String,
    kind: Schema.Literal("vector"),
    count: Schema.Number,
    geometry: Schema.NullOr(Schema.String),
    crs: Crs,
  }),
  Schema.Struct({ name: Schema.String, kind: Schema.Literal("table"), count: Schema.Number }),
  Schema.Struct({
    name: Schema.NullOr(Schema.String),
    kind: Schema.Literal("raster"),
    width: Schema.Number,
    height: Schema.Number,
    bands: Schema.Number,
    crs: Crs,
  }),
])
export type Layer = typeof Layer.Type

const Field = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  present: Schema.Number,
  /** Null when there are too many to count. */
  distinct: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  values: Schema.optionalKey(Schema.Array(Schema.Tuple([Schema.Unknown, Schema.Number]))),
  min: Schema.optionalKey(Schema.Unknown),
  max: Schema.optionalKey(Schema.Unknown),
  mean: Schema.optionalKey(Num),
})
export type Field = typeof Field.Type

const Sample = Schema.Struct({
  position: Schema.Number,
  attributes: Schema.Record(Schema.String, Schema.Unknown),
  geometry: Schema.NullOr(
    Schema.Struct({
      type: Schema.String,
      point: Schema.optionalKey(Schema.Tuple([Schema.Number, Schema.Number])),
      bbox: Schema.optionalKey(Box),
      area: Schema.optionalKey(Schema.Number),
      length: Schema.optionalKey(Schema.Number),
    }),
  ),
})
export type Sample = typeof Sample.Type

const Group = Schema.Struct({
  type: Schema.Literals(["all", "point", "line", "polygon", "collection", "none"]),
  count: Schema.Number,
  fields: Schema.Array(Field),
  samples: Schema.Array(Sample),
})
export type Group = typeof Group.Type

const Located = {
  driver: Schema.String,
  layer: Schema.NullOr(Schema.String),
  /** How many layers the file holds. */
  layers: Schema.Number,
}

const Vector = Schema.Struct({
  ...Located,
  kind: Schema.Literals(["vector", "table"]),
  /** Null when the geometry is mixed, or there is none. */
  geometry: Schema.NullOr(Schema.String),
  shapefile: Schema.Boolean,
  count: Schema.Number,
  crs: Crs,
  extent: Schema.NullOr(Box),
  lonlat: Schema.NullOr(Box),
  encoding: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      source: Schema.Literals(["cpg", "ldid", "utf-8", "detected", "given"]),
      weak: Schema.optionalKey(Schema.Boolean),
      /** What a .cpg file says, when the text proved it wrong. */
      cpg: Schema.optionalKey(Schema.String),
    }),
  ),
  offset: Schema.Number,
  /** How many features each group was to show. */
  limit: Schema.Number,
  groups: Schema.Array(Group),
})
export type Vector = typeof Vector.Type

const Band = Schema.Struct({
  index: Schema.Number,
  name: Schema.NullOr(Schema.String),
  type: Schema.String,
  nodata: Schema.NullOr(Num),
  unit: Schema.NullOr(Schema.String),
  scale: Schema.NullOr(Schema.Number),
  offset: Schema.NullOr(Schema.Number),
  colors: Schema.Boolean,
  names: Schema.Record(Schema.String, Schema.String),
  valid: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  stats: Schema.optionalKey(Schema.Struct({ min: Num, max: Num, mean: Num, std: Num })),
  /** Each value with its pixel count, most common first; a value past 2^53 comes as its digits. */
  categories: Schema.optionalKey(
    Schema.Array(Schema.Tuple([Schema.Union([Schema.Number, Schema.String]), Schema.Number])),
  ),
})
export type Band = typeof Band.Type

const Raster = Schema.Struct({
  ...Located,
  kind: Schema.Literal("raster"),
  width: Schema.Number,
  height: Schema.Number,
  crs: Crs,
  georeferencing: Schema.Literals(["transform", "gcp", "rpc", "geolocation", "crs-only"]),
  transform: Schema.NullOr(Schema.Array(Schema.Number)),
  extent: Schema.NullOr(Box),
  lonlat: Schema.NullOr(Box),
  bands: Schema.Array(Band),
})
export type Raster = typeof Raster.Type

const Preview = Schema.Struct({
  ...Located,
  kind: Schema.Literal("preview"),
  width: Schema.Number,
  height: Schema.Number,
  original: Schema.Tuple([Schema.Number, Schema.Number]),
  /** How many bands the raster has. */
  count: Schema.Number,
  bands: Schema.Array(Schema.Struct({ index: Schema.Number, name: Schema.NullOr(Schema.String) })),
  mode: Schema.Literals(["gray", "rgb", "categories"]),
  ranges: Schema.Array(Schema.Tuple([Schema.Number, Schema.Number])),
  legend: Schema.NullOr(Schema.Array(Schema.Tuple([Schema.Number, Schema.String]))),
  png: Schema.String,
})
export type Preview = typeof Preview.Type

/** What the read script reports. */
export const Report = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("missing") }),
  Schema.Struct({ kind: Schema.Literal("unopenable"), directory: Schema.Boolean, error: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("layers"), driver: Schema.String, layers: Schema.Array(Layer) }),
  Schema.Struct({
    kind: Schema.Literal("no-layer"),
    driver: Schema.String,
    layer: Schema.String,
    layers: Schema.Array(Layer),
  }),
  Schema.Struct({ ...Located, kind: Schema.Literal("not-geographic") }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals(["encoding", "bands", "preview-vector", "empty"]),
    encoding: Schema.optionalKey(Schema.String),
    count: Schema.optionalKey(Schema.Number),
    bands: Schema.optionalKey(Schema.Array(Schema.Number)),
    /** The size of a preview scaled down, in which no pixel was valid; null when it was not scaled. */
    size: Schema.optionalKey(Schema.NullOr(Schema.Tuple([Schema.Number, Schema.Number]))),
  }),
  Schema.Struct({ kind: Schema.Literal("error"), message: Schema.String, error: Schema.String }),
  Vector,
  Raster,
  Preview,
])
export type Report = typeof Report.Type

/**
 * What a run checks in the data before it asks: the kinds of geometry in each layer that declares no single type, and
 * the tables of each GeoPackage an output adds a table to. Never starts QGIS itself.
 */
export const INSPECT =
  Python.prelude +
  String.raw`
import time

from osgeo import gdal, ogr

gdal.UseExceptions()
request = json.loads(REQUEST)
` +
  OPENING +
  String.raw`

beat = [time.monotonic()]


# A line now and then, so the task's idle clock does not end a long survey.
def heartbeat():
    now = time.monotonic()
    if now - beat[0] >= 2:
        beat[0] = now
        emit({"alive": True})


def kind(geometry):
    flat = ogr.GT_Flatten(geometry.GetGeometryType())
    if flat in (ogr.wkbPoint, ogr.wkbMultiPoint):
        return "point"
    if ogr.GT_IsCurve(flat) or ogr.GT_IsSubClassOf(flat, ogr.wkbMultiCurve):
        return "line"
    if ogr.GT_IsSurface(flat) or ogr.GT_IsSubClassOf(flat, ogr.wkbMultiSurface):
        return "polygon"
    return "collection"


# The layer QGIS takes for the path: the one named or numbered after it, otherwise the first.
def kinds(entry):
    dataset = open_dataset(entry["path"], gdal.OF_VECTOR)
    if dataset is None or dataset.GetLayerCount() == 0:
        return None
    if "name" in entry:
        layer = dataset.GetLayerByName(entry["name"])
    elif "id" in entry:
        layer = dataset.GetLayer(entry["id"]) if 0 <= entry["id"] < dataset.GetLayerCount() else None
    else:
        layer = dataset.GetLayer(0)
    if layer is None or ogr.GT_Flatten(layer.GetGeomType()) != ogr.wkbUnknown:
        return None
    definition = layer.GetLayerDefn()
    layer.SetIgnoredFields([definition.GetFieldDefn(index).GetName() for index in range(definition.GetFieldCount())])
    found = set()
    for feature in layer:
        heartbeat()
        geometry = feature.GetGeometryRef()
        if geometry is not None and not geometry.IsEmpty():
            found.add(kind(geometry))
            if len(found) == 4:
                break
    return sorted(found)


def tables(target):
    dataset = open_dataset(target, gdal.OF_VECTOR)
    if dataset is None:
        return None
    return [dataset.GetLayer(index).GetName() for index in range(dataset.GetLayerCount())]


# Data GDAL cannot read through is left unknown: QGIS says what is wrong with it when it runs.
def surveyed(survey, item):
    try:
        return survey(item)
    except Exception:
        return None


finish(
    {
        "layers": [surveyed(kinds, entry) for entry in request["layers"]],
        "tables": [surveyed(tables, target) for target in request["tables"]],
    }
)
`

/** What the inspect script reports, in the order asked; null where the data could not be opened or needs no survey. */
export const Inspection = Schema.Struct({
  layers: Schema.Array(Schema.NullOr(Schema.Array(Schema.Literals(["collection", "line", "point", "polygon"])))),
  tables: Schema.Array(Schema.NullOr(Schema.Array(Schema.String))),
})
export type Inspection = typeof Inspection.Type
