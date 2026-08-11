# -*- coding: utf-8 -*-
"""Answer a case list with the rules AS THEY SHIP inside raster_preview.py.

Test glue, not product code, and deliberately not a copy of anything: the two
rule functions are lifted out of the script's own source and executed here, so
what gets answered is the code that runs in production rather than a second
version of it that would need keeping in step.

The script itself needs QGIS's Python to run. These two functions do not --
they take band descriptions and four numbers -- so faking the one GDAL call
they make is enough to run them under any python3, which is what lets the
TypeScript face be compared against them on a machine with no QGIS.

Usage: python3 raster-rule-answer.py <raster_preview.py>   [cases on stdin]
"""

import json
import re
import sys
import types

source = open(sys.argv[1], encoding="utf-8").read()

# Lifted by name, up to the blank-line pair PEP 8 puts between definitions. A
# restructure that defeats this breaks the test loudly, which is the right
# failure: these two are being watched, and going quiet is the one outcome
# worth preventing.
RULES = ("select_bands", "compute_stretch")
lifted = re.findall(r"^def (?:%s)\(.*?(?=\n\n\n)" % "|".join(RULES), source, re.S | re.M)
if len(lifted) != len(RULES):
    raise SystemExit(f"expected to lift {RULES} out of the script, found {len(lifted)}")

namespace = {
    "math": __import__("math"),
    # The colour interpretation makes one round trip through GDAL: an integer
    # out of the band, a name out of the library. The fake band below hands
    # back the name already, so this is the identity.
    "gdal": types.SimpleNamespace(GetColorInterpretationName=lambda value: value),
}
exec("\n\n".join(lifted), namespace)


class Band:
    def __init__(self, colour="Gray", description="", statistics=None):
        self.colour, self.description, self.statistics = colour, description, statistics

    def GetColorInterpretation(self):
        return self.colour

    def GetDescription(self):
        return self.description

    def GetStatistics(self, approximate, force):
        return self.statistics


class Dataset:
    def __init__(self, bands):
        self.bands = bands
        self.RasterCount = len(bands)

    def GetRasterBand(self, index):
        return self.bands[index - 1]


def described_as(raster):
    """`colour` or `colour:description`, space-separated. `_` stands for a space."""
    bands = []
    for part in raster.split(" "):
        colour, _, description = part.partition(":")
        bands.append(Band(colour, description.replace("_", " ")))
    return bands


cases = json.load(sys.stdin)
answers = {"bands": [], "stretch": []}
for raster in cases["bands"]:
    rgb, alpha = namespace["select_bands"](Dataset(described_as(raster)))
    answers["bands"].append({"rgb": list(rgb), "alpha": alpha})
for statistics in cases["stretch"]:
    answers["stretch"].append(list(namespace["compute_stretch"](Band(statistics=statistics))))
print(json.dumps(answers))
