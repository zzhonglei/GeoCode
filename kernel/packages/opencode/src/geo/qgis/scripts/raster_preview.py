# -*- coding: utf-8 -*-
"""Render a raster file as a downscaled PNG preview (base64-encoded).

Output is TWO parts (GEOKERNEL.md section 4.13): a marker-tagged JSON metadata
line, then the base64 image on its own line. The image payload can run to tens
of megabytes -- the reader's collection cap is sized to the preview's upper
bound precisely because an overrun here truncates the marker line and
masquerades as an unattributable "no marker" failure.

The semantic rules (band selection, stretch, alpha and nodata handling) are
shared with the GDAL module's preview (section 7.9 dual engines): both sides
implement the same definitions, locked by shared test cases.
"""

import faulthandler
import sys

# Before ANY osgeo/numpy import: a broken install segfaults during
# dynamic-library load, where no except block can see it (section 4.13
# constraint 4).
faulthandler.enable(file=sys.stderr)

import base64
import json
import math
import os

import numpy as np
from osgeo import gdal

MARKER = "__GEOCODE_READ_JSON__"


def emit_error(payload):
    sys.stdout.write(MARKER + json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(1)


gdal.UseExceptions()

# HALF the GDAL face's cap, and deliberately so -- do not "fix" the two to
# agree (gdal/raster.ts, section 7.9). That preview goes onto a map the user
# zooms into, so it is drawn at 4096; this one becomes an attachment in a model's
# context, which is the one place a pixel costs something per read. Quartering
# the pixels quarters the payload, and nothing downstream reads the difference.
MAX_SIDE = 2048


# ---------------------------------------------------------------------------
# Containers -- files that hold variables rather than bands
# ---------------------------------------------------------------------------

def container_subdatasets(ds):
    """The variables a container holds, or an empty list for an ordinary raster.

    A netCDF, HDF4 or HDF5 file carrying several variables is not a raster at
    all. GDAL opens it anyway and answers with RasterCount 0, a placeholder
    512x512 size and no georeferencing, so every fact read off it afterwards is
    fiction. The variables themselves are named in metadata, and handing those
    names back is the whole difference between a dead end and a next call:
    MODIS, Sentinel and ERA5 scenes all arrive this way.

    GRIB is NOT one of them, though it is the format most often listed beside
    them. Measured on GDAL 3.12: a GRIB2 file of three messages answers with
    RasterCount 3 and no SUBDATASETS at all, because the driver exposes each
    message as a band. So this returns an empty list for GRIB, correctly, and
    naming it here would have described a branch it can never take.

    ReadGeoData cannot reach this today either way: its format list
    (`tool/geo-handoff.ts`) deliberately admits only the extensions the reader
    scripts were validated against, and .nc/.hdf are not among them. What is
    live is the guard this feeds -- an ordinary raster that reports no bands
    would otherwise index an empty list -- and the answer is kept whole so that
    opening the format list later needs no second implementation.
    """
    if ds.RasterCount > 0:
        return []
    metadata = ds.GetMetadata("SUBDATASETS") or {}
    names = []
    index = 1
    while True:
        name = metadata.get(f"SUBDATASET_{index}_NAME")
        if not name:
            break
        names.append(name)
        index += 1
    return names


# ---------------------------------------------------------------------------
# Band selection
# ---------------------------------------------------------------------------

def select_bands(ds):
    """Return (rgb, alpha) where rgb is a 3-tuple of 1-based band indices."""
    band_count = ds.RasterCount
    bands = []
    for i in range(1, band_count + 1):
        band = ds.GetRasterBand(i)
        color = gdal.GetColorInterpretationName(band.GetColorInterpretation()).lower()
        desc = (band.GetDescription() or "").upper().strip()
        bands.append({"idx": i, "color": color, "description": desc})

    alpha = next((b["idx"] for b in bands if b["color"] == "alpha"), None)

    def pick(n):
        for b in bands:
            if not b["description"]:
                continue
            if b["description"] in (f"B{n}", f"B0{n}", f"BAND {n}"):
                return b["idx"]
        return None

    # Single band. `bands` is empty for a container, which render_preview
    # refuses before it ever reaches here -- the guard is what keeps this
    # function's answer defined anyway, and equal to the TypeScript face's
    # `bands[0]?.color` rather than an IndexError (section 7.9 dual engines).
    grey_pair = band_count <= 2 and len(bands) > 0 and bands[0]["color"] == "gray"
    single = (band_count == 1) or grey_pair
    if single:
        a = alpha if alpha else (2 if band_count >= 2 else None)
        return (1, 1, 1), a

    # Explicit R/G/B color interpretation
    red = next((b["idx"] for b in bands if b["color"] == "red"), None)
    green = next((b["idx"] for b in bands if b["color"] == "green"), None)
    blue = next((b["idx"] for b in bands if b["color"] == "blue"), None)
    if red and green and blue:
        return (red, green, blue), alpha

    # Description-based: B4/B3/B2
    b4, b3, b2 = pick(4), pick(3), pick(2)
    if b4 and b3 and b2:
        return (b4, b3, b2), alpha

    # Fallback by band count
    if band_count >= 4:
        return (4, 3, 2), alpha
    if band_count >= 3:
        return (1, 2, 3), alpha
    if band_count == 2:
        return (1, 1, 1), 2

    return (1, 1, 1), None


# ---------------------------------------------------------------------------
# Stretch -- mean +/- 1.8 * stddev
# ---------------------------------------------------------------------------

def compute_stretch(band):
    """Return (low, high) for linear stretch to 0-255."""
    stats = band.GetStatistics(True, True)
    bmin, bmax, mean, stddev = stats[0], stats[1], stats[2], stats[3]

    if not math.isfinite(bmin) or not math.isfinite(bmax) or bmax <= bmin:
        return 0.0, 255.0

    if not math.isfinite(mean) or not math.isfinite(stddev) or stddev <= 0:
        return bmin, bmax

    low = max(bmin, mean - stddev * 1.8)
    high = min(bmax, mean + stddev * 1.8)
    if high <= low:
        return bmin, bmax
    return low, high


# ---------------------------------------------------------------------------
# Preview size -- max side, maintain aspect ratio, never upscale
# ---------------------------------------------------------------------------

def preview_size(width, height):
    """Return (out_w, out_h). Never upscales."""
    side = max(width, height)
    if side <= MAX_SIDE:
        return width, height
    ratio = MAX_SIDE / side
    return max(1, round(width * ratio)), max(1, round(height * ratio))


# ---------------------------------------------------------------------------
# Georeferencing -- byte-for-byte the same function raster_read.py carries
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Main render
# ---------------------------------------------------------------------------

def render_preview(file_path):
    ds = gdal.Open(file_path)
    if ds is None:
        raise RuntimeError(f"Cannot open raster file: {file_path}")

    # Before a single fact is read off it. A container has no bands to draw, and
    # the size and georeferencing it does report are GDAL's placeholders. The
    # variable names are the way forward, so they are what the failure carries --
    # without them this is a dead end wearing the costume of a broken file.
    subdatasets = container_subdatasets(ds)
    if subdatasets:
        raise RuntimeError(
            f"This file holds {len(subdatasets)} subdatasets rather than bands, so there is nothing"
            f" to preview here. Open one of them instead: {', '.join(subdatasets)}"
        )

    # Taken while the dataset is still open; it is closed before encoding.
    georeferencing = georeferencing_facts(ds)

    width = ds.RasterXSize
    height = ds.RasterYSize
    out_w, out_h = preview_size(width, height)

    rgb_indices, alpha_idx = select_bands(ds)

    # Read and stretch each RGB band
    channels = []
    for band_idx in rgb_indices:
        band = ds.GetRasterBand(band_idx)
        nodata = band.GetNoDataValue()
        low, high = compute_stretch(band)

        data = band.ReadAsArray(buf_xsize=out_w, buf_ysize=out_h).astype(np.float64)

        # Build nodata mask
        if nodata is not None:
            if math.isfinite(nodata):
                mask = data == nodata
            elif math.isnan(nodata):
                mask = np.isnan(data)
            elif math.isinf(nodata):
                if nodata > 0:
                    mask = np.isposinf(data)
                else:
                    mask = np.isneginf(data)
            else:
                mask = np.zeros_like(data, dtype=bool)
        else:
            mask = np.isnan(data)

        # Linear stretch to 0-255
        if high > low:
            stretched = (data - low) / (high - low) * 255.0
        else:
            stretched = np.full_like(data, 128.0)

        stretched = np.clip(stretched, 0, 255).astype(np.uint8)
        channels.append((stretched, mask))

    # Build alpha channel
    # Combine nodata masks from all RGB bands
    combined_mask = channels[0][1]
    for _, m in channels[1:]:
        combined_mask = combined_mask | m

    if alpha_idx:
        alpha_band = ds.GetRasterBand(alpha_idx)
        alpha_data = alpha_band.ReadAsArray(buf_xsize=out_w, buf_ysize=out_h).astype(np.float64)
        # Normalize alpha to 0-255
        amin, amax = float(alpha_data.min()), float(alpha_data.max())
        if amax > amin:
            alpha_arr = ((alpha_data - amin) / (amax - amin) * 255.0).astype(np.uint8)
        else:
            alpha_arr = np.full((out_h, out_w), 255, dtype=np.uint8)
    else:
        alpha_arr = np.full((out_h, out_w), 255, dtype=np.uint8)

    # Apply nodata mask to alpha
    alpha_arr[combined_mask] = 0

    ds = None

    # Compose RGBA image using GDAL MEM driver -> PNG. The alpha channel MUST
    # survive: nodata transparency is the difference between a usable preview
    # and a black frame around every clipped raster.
    mem_drv = gdal.GetDriverByName("MEM")
    out_ds = mem_drv.Create("", out_w, out_h, 4, gdal.GDT_Byte)

    for i, (ch, _) in enumerate(channels):
        out_ds.GetRasterBand(i + 1).WriteArray(ch)
    out_ds.GetRasterBand(4).WriteArray(alpha_arr)

    # Write PNG to memory via /vsimem/
    png_path = "/vsimem/preview.png"
    png_drv = gdal.GetDriverByName("PNG")
    png_drv.CreateCopy(png_path, out_ds)
    out_ds = None

    # Read the virtual file into bytes
    vsi_file = gdal.VSIFOpenL(png_path, "rb")
    gdal.VSIFSeekL(vsi_file, 0, 2)
    size = gdal.VSIFTellL(vsi_file)
    gdal.VSIFSeekL(vsi_file, 0, 0)
    png_bytes = gdal.VSIFReadL(1, size, vsi_file)
    gdal.VSIFCloseL(vsi_file)
    gdal.Unlink(png_path)

    encoded = base64.b64encode(png_bytes).decode("ascii")

    return {
        "width": out_w,
        "height": out_h,
        "original_width": width,
        "original_height": height,
        "bands": list(rgb_indices),
        "bytes": len(png_bytes),
        "georeferencing": georeferencing,
    }, encoded


if __name__ == "__main__":
    try:
        meta, content = render_preview(sys.argv[1])
        # Two-part output: marker + metadata line, then the base64 image on
        # its own line. Then leave without interpreter teardown -- nothing may
        # follow the payload (section 4.13 constraint 3).
        sys.stdout.write(MARKER + json.dumps(meta, ensure_ascii=False) + "\n")
        sys.stdout.write(content + "\n")
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(0)
    except Exception as e:
        emit_error({"error": str(e)})
