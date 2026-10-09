"""GeoCode's helpers for Earth Engine scripts, imported as `import geocode as gc`.

GeoCode sets the module up before the script starts, for the task the run works in: `ee` is initialized, and the task's
folder is projects/<project>/assets/GeoCode/<task>.
"""

from geocode._assets import load, save

__all__ = ["load", "save"]
