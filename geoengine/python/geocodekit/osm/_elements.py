"""OSM elements as the tools name them, R123 for a relation, W123 for a way and N123 for a node, and the Overpass
statements that select them."""

import re

REF = re.compile(r"^\s*([NWRnwr])(\d+)\s*$")
TYPES = {"N": "node", "W": "way", "R": "relation"}
LETTERS = {"node": "N", "way": "W", "relation": "R"}
STATEMENTS = {"node": "node", "way": "way", "relation": "rel"}


class Invalid(ValueError):
    """A request written wrong, said so that the caller can write it right."""


def parse(text):
    found = REF.match(text)
    if not found:
        raise Invalid('"%s" is not an OSM id: write R123 for a relation, W123 for a way or N123 for a node' % text)
    return TYPES[found.group(1).upper()], int(found.group(2))


def name(ref):
    """An element's id as the tools write it, from its type and number."""
    kind, number = ref
    return "%s%d" % (LETTERS[kind], number)


def ref(element):
    return name((element["type"], element["id"]))


def select(refs):
    """The Overpass union selecting the elements, to end with ";" or to put in a set."""
    statements = []
    for kind in ("node", "way", "relation"):
        ids = [str(number) for found, number in refs if found == kind]
        if ids:
            statements.append("%s(id:%s);" % (STATEMENTS[kind], ",".join(ids)))
    return "(%s)" % "".join(statements)
