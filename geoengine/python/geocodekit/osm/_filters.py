"""The tag filters the OSM tools take (docs/OSM.md, section 5): a list of alternatives, any of which a feature may meet;
each is one condition, or several in brackets that must all hold, as Overpass writes them."""

import re

from geocodekit.osm._elements import Invalid

# A key, then an operator and a value, or the key alone; "!~" before "~", which it contains.
CONDITION = re.compile(r"^\s*([^=~!\[\]\"]+?)\s*(?:(!~|~|=)\s*(.*?))?\s*$")
BRACKETED = re.compile(r"\s*\[([^\]]*)\]\s*")


def _unquoted(text):
    return text[1:-1] if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'" else text


def _condition(text, whole):
    found = CONDITION.match(text)
    if not found:
        raise Invalid('"%s" is not a tag condition: write key=value, key, key~regex or key!~regex' % whole)
    key, operator, value = _unquoted(found.group(1).strip()), found.group(2), found.group(3)
    if operator is None:
        return (key, None, None)
    value = _unquoted(value.strip())
    if value == "":
        raise Invalid('"%s" has no value after %s' % (whole, operator))
    return (key, operator, value)


def parse(text):
    """One alternative: a tuple of (key, operator, value) conditions, operator and value None for a key alone."""
    text = text.strip()
    if not text.startswith("["):
        return (_condition(text, text),)
    parts = []
    at = 0
    while at < len(text):
        found = BRACKETED.match(text, at)
        if not found:
            raise Invalid('"%s" mixes bracketed conditions with something else; write [key=value][key2=value2]' % text)
        parts.append(_condition(found.group(1), text))
        at = found.end()
    return tuple(parts)


def parse_all(texts):
    if not texts:
        raise Invalid("tags lists no filter")
    return [parse(text) for text in texts]


def quoted(text):
    """A string as Overpass's query language writes one."""
    return '"%s"' % text.replace("\\", "\\\\").replace('"', '\\"')


def clause(alternative):
    """The Overpass filter for an alternative; key!~regex holds only where the key is there."""
    written = []
    for key, operator, value in alternative:
        if operator is None:
            written.append("[%s]" % quoted(key))
        elif operator == "!~":
            written.append("[%s][%s!~%s]" % (quoted(key), quoted(key), quoted(value)))
        else:
            written.append("[%s%s%s]" % (quoted(key), operator, quoted(value)))
    return "".join(written)


def meets(alternative, tags):
    """Whether tags meet an alternative, as Overpass would judge them."""
    for key, operator, value in alternative:
        if key not in tags:
            return False
        if operator == "=" and tags[key] != value:
            return False
        if operator == "~" and not re.search(value, tags[key]):
            return False
        if operator == "!~" and re.search(value, tags[key]):
            return False
    return True


def text(alternative):
    """An alternative as the tools write one back: a single condition plainly, several in brackets."""
    written = ["%s%s%s" % (key, operator or "", value or "") for key, operator, value in alternative]
    return written[0] if len(written) == 1 else "".join("[%s]" % part for part in written)


def keys(alternatives):
    """The keys the filters name, in the order they first appear."""
    found = []
    for alternative in alternatives:
        for key, _operator, _value in alternative:
            if key not in found:
                found.append(key)
    return found


def exact(alternative):
    """The tags an alternative names exactly, a key alone as "*", for finding its preset; None when one is a regex."""
    if any(operator not in (None, "=") for _key, operator, _value in alternative):
        return None
    return {key: value if operator else "*" for key, operator, value in alternative}
