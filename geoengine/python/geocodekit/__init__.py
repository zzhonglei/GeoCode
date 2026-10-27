"""GeoCode's standard functions for geographic work, a subpackage for each capability domain, imported by its
short name, as `import geocodekit.gee as gee`."""

import importlib

# Imported only once used, so that adding a subpackage never slows an import of another.
SUBPACKAGES = ("gee",)

__all__ = list(SUBPACKAGES)


def __getattr__(name):
    if name in SUBPACKAGES:
        return importlib.import_module("%s.%s" % (__name__, name))
    raise AttributeError("module %r has no attribute %r" % (__name__, name))
