"""GeoCode's functions for Earth Engine scripts, imported as `import geocodekit.gee as gee`.

GeoCode's geerun tool sets the subpackage up before the script starts, for the task the run works in: `ee` is
initialized, and the task's folder is projects/<project>/assets/GeoCode/<task>.
"""

from geocodekit import _tool

# Every function needs what geerun sets up first.
if _tool.name != "geerun":
    raise ImportError(
        "geocodekit.gee works only in a script run by GeoCode's geerun tool, which initializes Earth Engine and sets up"
        " the task for it: run the script with geerun. There is nothing to install."
    )

from geocodekit.gee._assets import load, save
from geocodekit.gee._composite import composite
from geocodekit.gee._images import images
from geocodekit.gee._outputs import download, to_drive
from geocodekit.gee._region import region

__all__ = ["composite", "download", "images", "load", "region", "save", "to_drive"]
