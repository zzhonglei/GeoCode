# -*- coding: utf-8 -*-
"""GeoCode built-in utilities for GEE scripts.

Usage in GEE scripts:
    from geocode import init_gee, load_region, export_image, download_image, check_coverage, heartbeat
"""

import threading
import time
import os


class _Heartbeat:
    """Background thread that prints periodic status to keep the process alive."""

    def __init__(self, message, interval=30):
        self._message = message
        self._interval = interval
        self._start = time.time()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        while not self._stop.wait(self._interval):
            elapsed = int(time.time() - self._start)
            print(f"[{elapsed}s] {self._message}", flush=True)

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=1)

    def elapsed(self):
        return int(time.time() - self._start)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.stop()


class _FileHeartbeat:
    """Background thread that monitors a file's size and prints download progress."""

    def __init__(self, message, filepath, interval=30):
        self._message = message
        self._filepath = filepath
        self._interval = interval
        self._start = time.time()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _format_size(self, size_bytes):
        if size_bytes < 1024 * 1024:
            return f"{size_bytes / 1024:.0f} KB"
        return f"{size_bytes / (1024 * 1024):.1f} MB"

    def _run(self):
        while not self._stop.wait(self._interval):
            elapsed = int(time.time() - self._start)
            try:
                size = os.path.getsize(self._filepath)
                if size > 0:
                    print(f"[{elapsed}s] {self._message} ({self._format_size(size)})", flush=True)
                else:
                    print(f"[{elapsed}s] {self._message}", flush=True)
            except OSError:
                print(f"[{elapsed}s] {self._message}", flush=True)

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=1)

    def elapsed(self):
        return int(time.time() - self._start)


class _GeedimProgressHeartbeat:
    """Capture geedim/tqdm stderr progress and print clean stdout heartbeats."""

    def __init__(self, message, original_stderr, interval=30):
        self._message = message
        self._stderr = original_stderr
        self._interval = interval
        self._start = time.time()
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._latest = None
        self._buffer = ""
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _parse_progress(self, line):
        import re

        clean = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", line.strip())
        match = re.search(
            r"([0-9.]+[KMGT]?)/([0-9.]+[KMGT]?).*?\[\s*([0-9.]+)%\].*?\(eta:\s*([^)]+)\)",
            clean,
        )
        if not match:
            return None
        return {
            "done": match.group(1),
            "total": match.group(2),
            "pct": match.group(3),
            "eta": match.group(4).strip(),
        }

    def _process_line(self, line):
        progress = self._parse_progress(line)
        if progress:
            with self._lock:
                self._latest = progress
            return
        if line.strip():
            self._stderr.write(line + "\n")
            self._stderr.flush()

    def write(self, text):
        if not isinstance(text, str):
            text = str(text)
        self._buffer += text.replace("\r", "\n")
        parts = self._buffer.split("\n")
        self._buffer = parts[-1]
        for line in parts[:-1]:
            self._process_line(line)
        if self._parse_progress(self._buffer):
            self._process_line(self._buffer)
        return len(text)

    def flush(self):
        if self._parse_progress(self._buffer):
            self._process_line(self._buffer)
        self._stderr.flush()

    def _run(self):
        while not self._stop.wait(self._interval):
            elapsed = int(time.time() - self._start)
            with self._lock:
                latest = self._latest
            if latest:
                print(
                    f"[{elapsed}s] {self._message} "
                    f"({latest['done']}/{latest['total']}, {latest['pct']}%, eta {latest['eta']})",
                    flush=True,
                )
            else:
                print(f"[{elapsed}s] {self._message}", flush=True)

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=1)
        tail = self._buffer.strip()
        if tail and not self._parse_progress(tail):
            self._stderr.write(tail + "\n")
            self._stderr.flush()

    def elapsed(self):
        return int(time.time() - self._start)


def heartbeat(message, interval=30):
    """Start a background heartbeat that prints status every `interval` seconds.

    Use as a context manager around long-running operations:

        with heartbeat("Computing NDVI statistics"):
            stats = image.reduceRegion(...).getInfo()

    Args:
        message: Status message to print periodically.
        interval: Seconds between prints (default: 30).

    Returns:
        A context manager that stops automatically when the block exits.
    """
    print(f"{message}...", flush=True)
    return _Heartbeat(message, interval)


def init_gee(project_id=None):
    """Initialize Google Earth Engine.

    Reads project ID from the GEE_PROJECT env var (set by GeoCode from
    machine.json's gee.project) when not passed explicitly. Callers
    almost never need to pass project_id — it exists only as an override.

    Single-shot Initialize: there's no in-script re-auth. If Initialize
    fails because credentials are missing or stale, the user must run
    `earthengine authenticate` in the terminal where they can complete
    the browser flow — the sidecar can't drive a browser OAuth handoff
    itself, and an in-script ee.Authenticate(quiet=True) call doesn't
    reliably help here either (its behaviour in non-interactive contexts
    is ambiguous across versions).

    Safe to call multiple times within one script — ee handles repeated
    Initialize internally.
    """
    import ee
    import inspect

    if project_id is None:
        project_id = os.environ.get("GEE_PROJECT")
    if not project_id:
        raise RuntimeError(
            "GEE project ID is not set. Configure gee.project in machine.json, "
            "or pass project_id=... explicitly."
        )

    print(f"Initializing GEE (project: {project_id})...", flush=True)
    try:
        ee.Initialize(project=project_id)
    except Exception as e:
        # Initialize can fail for several reasons: invalid/expired
        # credentials, project ID typo, EE API not enabled on the GCP
        # project, IAM access revoked, or transient network issues. We
        # surface the raw error verbatim plus a pointer to the only
        # actionable in-terminal step (re-auth), since the sidecar can't
        # complete an OAuth browser flow on the user's behalf.
        raise RuntimeError(
            f"GEE Initialize failed: {e}\n"
            f"  Project: {project_id}\n"
            "If credentials look stale or missing, re-authenticate in a\n"
            "terminal that can complete the browser flow:\n"
            "  earthengine authenticate\n"
            "Then retry the script. Otherwise verify the project ID in\n"
            "machine.json matches a GCP project that has Earth Engine\n"
            "API enabled and that your account has access to it."
        ) from e

    # Silent safety net: drop `ee` into the caller's module globals so a
    # script that forgot `import ee` still works after init_gee() returns.
    # Common Agent oversight — kept undocumented in tool/parameter prompts
    # on purpose, so the Agent keeps generating the explicit `import ee`
    # most of the time. The setdefault-style assignment is idempotent
    # because `ee` is a module singleton — re-running init_gee() or
    # importing ee yourself produces the same object.
    caller_frame = inspect.currentframe().f_back
    try:
        caller_frame.f_globals.setdefault("ee", ee)
    finally:
        # Explicit del to avoid the documented frame-reference cycle
        # (https://docs.python.org/3/library/inspect.html#inspect.currentframe).
        del caller_frame

    print(f"GEE ready (earthengine-api {ee.__version__})", flush=True)


def load_region(file_path):
    """Load a local single-feature vector file as an ee.FeatureCollection.

    Reprojects to EPSG:4326 ourselves (rather than relying on geemap's
    version-dependent vector_to_ee, which can silently treat CRS-less
    files as already-WGS84 and pass UTM coordinate values to EE as if
    they were lon/lat). Enforces:
      - File exists.
      - File has CRS metadata.
      - Exactly one feature — a "region" semantically represents one
        study-area boundary, so multi-feature input is rejected to
        avoid the ambiguity of "union or first?".

    Args:
        file_path: Path to a vector file (.shp, .geojson, .gpkg, .kml, ...)
                   containing exactly one feature.

    Returns:
        ee.FeatureCollection holding the single feature in EPSG:4326. Use
        `fc.geometry()` to extract the bare ee.Geometry if a downstream
        API needs it.
    """
    import sys
    import ee
    # Defence-in-depth: probe should already report missing geopandas via
    # GEE_RUNTIME_DEPS, but if the manifest ever drifts out of sync with
    # this module's actual imports, raise a hand-actionable error pointing
    # at the exact interpreter that just failed — `sys.executable` resolves
    # to the same python the user configured in machine.json.
    try:
        import geopandas as gpd
    except ImportError as e:
        raise RuntimeError(
            "load_region() requires geopandas, which is not installed.\n"
            f"  Install with: {sys.executable} -m pip install geopandas\n"
            "  On conda envs, prefer: conda install -c conda-forge geopandas\n"
            "  (geopandas pulls fiona/pyogrio which are GDAL-bound — conda-forge\n"
            "   avoids ABI mismatches with conda's bundled GDAL.)\n"
            "  After installing, retry the script — the new package\n"
            "  will be available immediately, no restart needed."
        ) from e
    import json

    # Front-load a friendly error rather than letting fiona/GDAL throw a
    # multi-line "DriverError: ... not recognized" stack a few lines later.
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Region file not found: {file_path}")

    name = os.path.basename(file_path)
    print(f"Loading region: {name}", flush=True)
    hb = _Heartbeat(f"Loading {name}")
    try:
        gdf = gpd.read_file(file_path)

        if gdf.crs is None:
            raise ValueError(
                f"Vector file has no CRS metadata: {file_path}\n"
                f"Shapefile needs a .prj sidecar; GeoPackage/GeoJSON needs "
                f"embedded CRS info. Without CRS we can't safely reproject "
                f"to WGS84."
            )

        if len(gdf) != 1:
            raise ValueError(
                f"load_region expects exactly one feature, got {len(gdf)}: "
                f"{file_path}\n"
                f"A region represents a single study-area boundary, not a "
                f"collection. Dissolve the multi-feature file first via the "
                f"QGIS algorithm `native:dissolve` (in QGIS UI: Vector → "
                f"Geoprocessing Tools → Dissolve), then point load_region "
                f"at the dissolved output."
            )

        src_crs = gdf.crs
        try:
            src_epsg = src_crs.to_epsg()
        except Exception:
            src_epsg = None
        if src_epsg != 4326:
            print(f"Reprojecting from {src_crs} to EPSG:4326", flush=True)
            try:
                gdf = gdf.to_crs(4326)
            except Exception as e:
                # The vector file has CRS metadata, but pyproj couldn't build
                # a working transform — most often a custom / partial CRS
                # definition (incomplete WKT2, ESRI custom projection without
                # an EPSG counterpart, malformed PROJ string). Surface a
                # friendly explanation rather than the raw pyproj traceback.
                raise ValueError(
                    f"Could not reproject region to EPSG:4326: {file_path}\n"
                    f"Source CRS: {src_crs}\n"
                    "The vector has CRS metadata, but pyproj could not build a "
                    "valid transform. Reproject the file manually to WGS84/"
                    "EPSG:4326 in QGIS (Vector → Save As → CRS: EPSG:4326) "
                    "and retry."
                ) from e

        # Validate the single feature's geometry before sending it through
        # the JSON round-trip + ee.FeatureCollection. ee silently accepts
        # empty / null / self-intersecting polygons and the failure surfaces
        # later as cryptic GEE errors or — worse — wrong area calculations.
        # Refusing dirty data here forces the user to fix it explicitly in
        # GIS rather than having `load_region` smuggle silent repairs in.
        geometry = gdf.geometry.iloc[0]
        if geometry is None:
            raise ValueError(
                f"Region feature has no geometry: {file_path}\n"
                "Check that the vector file's single feature actually has a "
                "drawn polygon — null geometry usually means the digitizing "
                "step was interrupted or the conversion stripped it."
            )
        if geometry.is_empty:
            raise ValueError(
                f"Region geometry is empty: {file_path}\n"
                "The feature exists but its geometry has no coordinates "
                "(POLYGON EMPTY). Re-export the region from your GIS with a "
                "real boundary."
            )
        if not geometry.is_valid:
            from shapely.validation import explain_validity

            raise ValueError(
                f"Region geometry is invalid: {file_path}\n"
                f"Reason: {explain_validity(geometry)}\n"
                "Common causes: self-intersecting rings, duplicate vertices, "
                "unclosed rings. Repair the geometry in your GIS — for "
                "example the QGIS algorithm `native:fixgeometries` "
                "(UI: Vector → Geometry Tools → Fix Geometries), or "
                "`native:buffer` with distance=0 for self-intersecting "
                "polygons. (PostGIS `ST_MakeValid`, Shapely `make_valid`, "
                "and `ogr2ogr -makevalid` work too.) Then point load_region "
                "at the fixed output."
            )

        # Drop everything except the geometry column before the JSON
        # round-trip. load_region's contract is "give me the study-area
        # boundary" — the caller uses fc.geometry() and never touches
        # feature properties. Stripping them avoids JSON-serialization
        # grief on common attribute types like pandas Timestamp / NaT /
        # tz-aware datetimes / Period that geopandas to_json can't handle
        # uniformly across versions, and keeps the FeatureCollection
        # focused on what's actually consumed downstream.
        gdf = gdf[[gdf.geometry.name]]

        # Round-trip through GeoJSON: geopandas serialises in the gdf's
        # current CRS (now WGS84) and ee.FeatureCollection happily accepts
        # the resulting list of Feature dicts.
        geojson = json.loads(gdf.to_json())
        fc = ee.FeatureCollection(geojson["features"])
    finally:
        hb.stop()

    print(f"Region loaded: 1 feature ({hb.elapsed()}s)", flush=True)
    return fc


def export_image(
    image,
    description,
    region,
    folder="GEE_Exports",
    file_name_prefix=None,
    scale=10,
    max_pixels=1e13,
    file_format="GeoTIFF",
    poll_interval=10,
):
    """Export an ee.Image to Google Drive and wait for completion.

    Submits an export task, polls until finished, and prints real-time status.

    Args:
        image: ee.Image to export.
        description: Task description (also used as file_name_prefix if not set).
        region: ee.Geometry, export region.
        folder: Google Drive folder name (default: "GEE_Exports").
        file_name_prefix: Output filename prefix (default: same as description).
        scale: Spatial resolution in meters (default: 10).
        max_pixels: Maximum number of pixels (default: 1e13).
        file_format: Export format, e.g. "GeoTIFF" (default).
        poll_interval: Seconds between status checks (default: 10).

    Returns:
        dict with final task status.
    """
    import ee

    if file_name_prefix is None:
        file_name_prefix = description

    task = ee.batch.Export.image.toDrive(
        image=image,
        description=description,
        folder=folder,
        fileNamePrefix=file_name_prefix,
        region=region,
        scale=scale,
        maxPixels=max_pixels,
        fileFormat=file_format,
    )

    task.start()
    start_time = time.time()
    print(f"Export started: {description} -> Drive/{folder}/{file_name_prefix}", flush=True)
    # GEE service-side task continues even if this script is killed (Ctrl-C,
    # idle timeout, sidecar crash). Print the task id so the user can monitor
    # / cancel via the Earth Engine Code Editor's Tasks panel.
    print(f"Task ID: {task.id} (monitor or cancel via GEE Code Editor)", flush=True)

    # State changes are rare on long-running tasks (often just RUNNING for
    # hours then COMPLETED) — printing every poll_interval would generate
    # hundreds of duplicate "RUNNING" lines. Only print on state change,
    # use a 30s heartbeat to keep the spawn-util idle watchdog (60s) happy.
    last_state = None
    hb = _Heartbeat(f"Exporting {description}", interval=30)
    try:
        while task.active():
            state = task.status().get("state", "UNKNOWN")
            if state != last_state:
                elapsed = int(time.time() - start_time)
                print(f"[{elapsed}s] {state}", flush=True)
                last_state = state
            time.sleep(poll_interval)
    finally:
        hb.stop()

    elapsed = int(time.time() - start_time)
    final_status = task.status()
    final_state = final_status.get("state", "UNKNOWN")

    if final_state == "COMPLETED":
        print(f"Export completed ({elapsed}s) -> Drive/{folder}/{file_name_prefix}", flush=True)
    elif final_state == "FAILED":
        error = final_status.get("error_message", "unknown error")
        print(f"Export failed ({elapsed}s): {error}", flush=True)
    elif final_state == "CANCELLED":
        print(f"Export cancelled ({elapsed}s)", flush=True)
    else:
        print(f"Export ended ({elapsed}s): {final_state}", flush=True)

    return final_status


def check_coverage(image, roi, band=None, scale=30):
    """Check valid-pixel coverage of a composite image within the ROI.

    Performs a fast scan to evaluate data completeness. Use after compositing
    (before downloading) to decide whether the result is usable or needs
    parameter adjustment.

    Args:
        image: ee.Image, the composite to check.
        roi: ee.Geometry, the study area boundary.
        band: Band name to check (default: first band).
        scale: Resolution in meters for the scan (default: 30).

    Returns:
        float in [0.0, 1.0]: valid_pixels / total_pixels.
    """
    import ee

    # Preflight band membership when an explicit name was given. One
    # bandNames() round-trip up front beats waiting 30+ seconds for a
    # reduceRegion to fail with an opaque "Pattern X did not match any
    # bands" deep in EE's evaluator. Skip the preflight when band is None
    # — index-0 selection always works as long as the image has any band.
    if band:
        band_names = image.bandNames().getInfo()
        if band not in band_names:
            available = ", ".join(band_names) if band_names else "(none)"
            raise ValueError(
                f"check_coverage(): band {band!r} not found in image.\n"
                f"Available bands: {available}"
            )
        check_band = image.select([band])
    else:
        check_band = image.select([0])

    # valid_img: 1 where the band has data, 0 where it's masked.
    valid_img = check_band.mask().unmask(0).gt(0).rename("valid")
    # all_img: 1 everywhere within the ROI, in the SAME projection as
    # valid_img so reduceRegion samples both bands on identical pixel
    # grids. The previous derivation (`valid_img.gte(0)`) inherited the
    # *image footprint* — when the image didn't fully cover the ROI
    # (single Sentinel scene, Landsat path edge), `total_pixels` was the
    # image's pixel count rather than the ROI's, and partial coverage
    # silently reported as 100%. Using a constant-1 image reprojected to
    # valid_img's projection fixes the denominator to the ROI extent
    # (which reduceRegion's geometry=roi argument enforces below),
    # without introducing a grid mismatch — EE doesn't interpolate a
    # constant image during reproject so there's no resampling artifact.
    all_img = ee.Image.constant(1).rename("all").reproject(valid_img.projection())

    print("Checking coverage...", flush=True)
    hb = _Heartbeat("Checking coverage")
    try:
        # Single reduceRegion call over a 2-band image. Reducer.sum()
        # broadcasts across bands automatically, returning one entry per
        # band — guaranteeing both numerators come from the same pixel
        # sampling pass (same projection, same scale, same iteration).
        stats = (
            valid_img.addBands(all_img)
            .reduceRegion(
                reducer=ee.Reducer.sum(),
                geometry=roi,
                scale=scale,
                maxPixels=1e13,
            )
            .getInfo()
        )
    finally:
        hb.stop()

    valid_pixels = int(stats.get("valid") or 0)
    total_pixels = int(stats.get("all") or 0)
    coverage = valid_pixels / total_pixels if total_pixels > 0 else 0

    print(f"Coverage: {coverage:.1%} | valid: {valid_pixels}/{total_pixels}", flush=True)
    return round(coverage, 4)


def download_image(image, filename, region, scale=10, crs="EPSG:4326", dtype=None):
    """Download an ee.Image directly to a local GeoTIFF file.

    Uses geemap.download_ee_image() which downloads via tiled requests —
    no Google Drive needed. Supports large images through automatic tiling.
    Downloads to a temporary file first, then moves to the target path on
    completion to avoid exposing incomplete files to the user.

    Args:
        image: ee.Image to download.
        filename: Local output file path (e.g. "/path/to/output.tif").
        region: ee.Geometry, download region.
        scale: Spatial resolution in meters (default: 10).
        crs: Coordinate reference system (default: "EPSG:4326").
        dtype: Output data type (e.g. "float32", "int16"). None = auto.

    Returns:
        The filename path.
    """
    import sys
    import shutil
    import tempfile
    # Defence-in-depth — see load_region's geopandas guard for rationale.
    # Probe should catch this at config time, but a friendly raise here
    # keeps the user moving even if the manifest drifts.
    try:
        import geemap
    except ImportError as e:
        raise RuntimeError(
            "download_image() requires geemap, which is not installed.\n"
            f"  Install with: {sys.executable} -m pip install geemap\n"
            "  After installing, retry the script — the new package\n"
            "  will be available immediately, no restart needed."
        ) from e
    # Eager import for geedim: geemap.download_ee_image() uses it under the
    # hood for tile-based GeoTIFF downloads, but geemap lists it as an
    # optional extra — `pip install geemap` doesn't pull it. Without this
    # eager check the user would hit a confusing ImportError deep inside
    # geemap's call stack on Windows installs that didn't bundle geedim.
    try:
        import geedim  # noqa: F401
    except ImportError as e:
        raise RuntimeError(
            "download_image() requires geedim, which is not installed.\n"
            "  geemap.download_ee_image() uses geedim internally for tile-based\n"
            "  GeoTIFF downloads, but geemap declares it as an optional extra —\n"
            "  pip install geemap does NOT pull it in.\n"
            f"  Install with: {sys.executable} -m pip install geedim\n"
            "  After installing, retry the script — the new package\n"
            "  will be available immediately, no restart needed."
        ) from e

    # Normalize and pre-check the target path BEFORE spending time on the
    # tile-based download. The actual move-into-place happens at the end,
    # so missing parent dirs would otherwise fail only after several
    # minutes of GEE traffic. Expand ~ and resolve to an absolute path so
    # the printed messages and return value are unambiguous regardless of
    # whatever the sidecar's cwd happens to be.
    filename = os.path.abspath(os.path.expanduser(filename))
    if os.path.isdir(filename):
        raise IsADirectoryError(
            f"Download target is a directory, not a file: {filename}\n"
            "Provide a full path including the filename, e.g. "
            f"{os.path.join(filename, 'output.tif')}"
        )
    if not os.path.splitext(filename)[1]:
        raise ValueError(
            f"Download target must include a file extension: {filename}\n"
            "The extension tells GeoCode and the agent what output type to "
            "expect (for example, .tif for GeoTIFF). GeoCode does not "
            "auto-append extensions because the agent will later look for the "
            "exact path it requested."
        )
    parent = os.path.dirname(filename)
    if not os.path.isdir(parent):
        raise FileNotFoundError(
            f"Download parent directory does not exist: {parent}\n"
            "Create it explicitly (e.g. via mkdir -p) and retry. Auto-creating "
            "directories from a download helper is intentionally avoided so "
            "typos don't silently scatter files in unexpected places."
        )

    name = os.path.basename(filename)
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".tif")
    os.close(tmp_fd)

    print(f"Downloading: {name} -> {filename} (scale={scale}, crs={crs})", flush=True)
    import contextlib

    if os.name == "nt":
        hb = _GeedimProgressHeartbeat(f"Downloading {name}", sys.stderr)
        download_context = contextlib.redirect_stderr(hb)
    else:
        hb = _FileHeartbeat(f"Downloading {name}", tmp_path)
        download_context = contextlib.nullcontext()
    try:
        with download_context:
            geemap.download_ee_image(
                image,
                filename=tmp_path,
                region=region,
                scale=scale,
                crs=crs,
                dtype=dtype,
            )
    except BaseException:
        # Clean up temp file on failure
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise
    finally:
        hb.stop()

    # shutil.move can fail too — across-filesystem move is copy+delete,
    # so a full target disk / missing parent dir / permission denied on
    # the target raises here even though the download itself succeeded.
    # Clean tmp on failure so we don't leave a fully-downloaded GB file
    # orphaned in /tmp.
    try:
        shutil.move(tmp_path, filename)
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise
    size_mb = os.path.getsize(filename) / (1024 * 1024)
    print(f"Download completed: {filename} ({size_mb:.1f} MB, {hb.elapsed()}s)", flush=True)
    return filename
