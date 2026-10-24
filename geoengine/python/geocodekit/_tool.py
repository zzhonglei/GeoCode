"""What the GeoCode tool running the script sets up before it starts: which tool it is, and how a status reaches the
tool row. A script that no tool runs, such as one GeoAgent runs in its shell, has neither, and statuses go nowhere."""

import contextlib
import itertools
import os
import threading

# Set by the tool's run script: the tool's name, as "geerun", and how it takes an event, such as a status.
name = None
report = None

# What the script is doing now, innermost last: a function's stages within the function's own.
doing = []
# Numbers each status, so the tool row can tell one it missed from one it showed; taken as it is sent, so the numbers
# keep the order of the statuses even when a download's thread tells one.
seq = itertools.count(1)
telling = threading.Lock()


@contextlib.contextmanager
def stage(text, progress=None):
    """Tells the tool row what the script is doing until the block ends: a short English text, with the share done
    when it is known."""
    doing.append({"text": text, "progress": progress})
    try:
        tell()
        yield
    finally:
        doing.pop()
        tell()


def update(text=None, progress=None):
    """Changes what the innermost stage says, with its share done if known, or only its share done."""
    if text is not None:
        doing[-1] = {"text": text, "progress": progress}
    else:
        doing[-1]["progress"] = progress
    tell()


def tell():
    with telling:
        now = doing[-1] if doing else {"text": None, "progress": None}
        status = {"type": "status", "seq": next(seq), "text": now["text"]}
        if now["progress"] is not None:
            status["progress"] = now["progress"]
        if report:
            report(status)


def partial(path):
    """Tells the tool of a file that only a finished write moves into place: a run ended before then cannot remove it
    itself, so the tool does once the run's process is gone."""
    if report:
        report({"type": "partial", "path": os.path.abspath(path)})
