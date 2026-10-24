"""The files GeoCode's functions write: never over one already there, and named as the workspace shows them."""

import os


def numbered(target):
    """The target, or, when it exists, the first of target_1, target_2, ... that does not."""
    stem, extension = os.path.splitext(target)
    count = 0
    while os.path.exists(target):
        count += 1
        target = "%s_%d%s" % (stem, count, extension)
    return target


def shown(path):
    """A path relative to the workspace when it is in there; os.path.relpath fails across Windows drives."""
    workspace = os.path.join(os.getcwd(), "")
    return path[len(workspace) :] if path.startswith(workspace) else path
