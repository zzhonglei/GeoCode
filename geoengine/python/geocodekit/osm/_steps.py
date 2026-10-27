"""What a download tells its tool row as it goes: the step it is on, and how far it has got.
Each is progress, so a download moving on is never stopped for having made none (section 7)."""

from geocodekit import _tool
from geocodekit.osm import _http


def _tell(event):
    _http.progressed()
    if _tool.report:
        _tool.report(event)


def step(name):
    """One of "area", "count", "download", "assemble" and "write", in that order; a download by id has no first two."""
    _tell({"type": "step", "step": name})


def counted(features, parts):
    """How many features there are, None when a count did not answer, and in how many parts they are downloaded."""
    _tell({"type": "counted", "features": features, "parts": parts})


def part(index, parts):
    """How far a download of several parts has got, as the part it would be on were they downloaded one at a time:
    one more than those done, from 1. Several are downloaded at once."""
    _tell({"type": "part", "part": index, "parts": parts})
