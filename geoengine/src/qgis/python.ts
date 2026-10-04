export * as Python from "./python.ts"

/** Prefixes every structured line: QGIS and its libraries also write to stdout, so only these lines are parsed. */
export const MARKER = "__GEOCODE_QGIS__"

// Embedded, since the engine is bundled into one file. String.raw keeps Python's backslashes, so the Python must not
// contain a backtick or "${" of its own.
const prelude = String.raw`
import faulthandler
import json
import os
import sys
import traceback

# Before any QGIS or GDAL import: a broken install crashes while loading libraries, where no except clause runs.
faulthandler.enable(file=sys.stderr)

MARKER = "${MARKER}"


# ASCII only: a file name that is not valid UTF-8 would otherwise fail to encode, and inside a Qt slot that aborts.
def emit(payload):
    sys.stdout.write(MARKER + json.dumps(payload, default=str) + "\n")
    sys.stdout.flush()


def finish(payload):
    emit(payload)
    sys.stderr.flush()
    # Skips QGIS's teardown, which crashes on some versions after the work has succeeded.
    os._exit(0)


application = None


def start_qgis():
    global application
    from qgis.core import QgsApplication

    # Held for the life of the process: once collected, the algorithm registry it owns is empty.
    application = QgsApplication([], False)
    application.initQgis()
    sys.path.append(os.path.join(QgsApplication.pkgDataPath(), "python", "plugins"))
    from processing.core.Processing import Processing

    Processing.initialize()
`

/** Checks, in order, what running an algorithm depends on; the first failure ends the probe. */
export const PROBE =
  prelude +
  String.raw`
report = {"python": sys.version.split()[0]}


def fail(step):
    report["failed"] = step
    report["error"] = traceback.format_exc()
    finish(report)


try:
    from osgeo import gdal, osr

    report["gdal"] = gdal.__version__
except Exception:
    fail("gdal")

# A real transform: the projection library imports fine with its database missing.
try:
    osr.UseExceptions()
    source = osr.SpatialReference()
    source.ImportFromProj4("+proj=lcc +lat_1=25 +lat_2=47 +lat_0=0 +lon_0=105 +datum=WGS84 +units=m +no_defs")
    target = osr.SpatialReference()
    target.ImportFromEPSG(4326)
    target.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    lon, lat, _ = osr.CoordinateTransformation(source, target).TransformPoint(500000.0, 4000000.0)
    if not (abs(lon) <= 180 and abs(lat) <= 90):
        raise RuntimeError(f"the transform returned {lon}, {lat}")
except Exception:
    fail("proj")

try:
    from qgis.core import Qgis

    report["qgis"] = Qgis.version()
except Exception:
    fail("core")

try:
    start_qgis()
    from qgis.core import QgsApplication

    report["algorithms"] = len(QgsApplication.processingRegistry().algorithms())
    if report["algorithms"] == 0:
        raise RuntimeError("Processing started with no algorithms")
except Exception:
    fail("processing")

finish(report)
`

/** Runs one algorithm; the request arrives as JSON in the first argument. */
export const RUN =
  prelude +
  String.raw`
request = json.loads(sys.argv[1])

try:
    start_qgis()
    from qgis.core import QgsProcessingException, QgsProcessingFeedback
    import processing
except Exception:
    finish({"type": "result", "ok": False, "stage": "start", "error": traceback.format_exc()})


class Feedback(QgsProcessingFeedback):
    def pushInfo(self, info):
        emit({"type": "message", "level": "info", "text": info})

    def pushWarning(self, warning):
        emit({"type": "message", "level": "warning", "text": warning})

    def reportError(self, error, fatalError=False):
        emit({"type": "message", "level": "error", "text": error})

    def pushCommandInfo(self, info):
        emit({"type": "message", "level": "command", "text": info})

    def pushConsoleInfo(self, info):
        emit({"type": "message", "level": "console", "text": info})

    # QGIS 3.32 and later report some messages here; earlier releases never call it.
    def pushFormattedMessage(self, html, text):
        emit({"type": "message", "level": "info", "text": text})


feedback = Feedback()
reported = [-1]


# Many algorithms report once per feature; a line per whole percent is enough to show progress and keep a task alive.
def progress(percent):
    if int(percent) != reported[0]:
        reported[0] = int(percent)
        emit({"type": "progress", "percent": reported[0]})


feedback.progressChanged.connect(progress)

try:
    outputs = processing.run(request["algorithm"], request["parameters"], feedback=feedback)
    finish({"type": "result", "ok": True, "outputs": outputs})
except QgsProcessingException as error:
    finish({"type": "result", "ok": False, "stage": "run", "error": str(error)})
except Exception:
    finish({"type": "result", "ok": False, "stage": "run", "error": traceback.format_exc()})
`

/** The payloads of the marked lines in some output, in order; a line that does not parse is left out. */
export function marked(output: string): unknown[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const at = line.indexOf(MARKER)
    if (at < 0) return []
    try {
      return [JSON.parse(line.slice(at + MARKER.length))]
    } catch {
      return []
    }
  })
}
