# -*- coding: utf-8 -*-
"""Answer what `export_image` does at each terminal state, running the SHIPPING module.

Test glue, not product code. `geocode.py` imports only threading/time/os at
module level and does `import ee` inside the function, so a fake in sys.modules
is enough to execute the real function under any python3 — no Earth Engine
account, no credentials, no network. That is what makes the one contract this
library owes the tool layer checkable at all: the runtime library had zero
execution coverage, and "did it raise" is not a question string assertions can
answer.

The task never goes active, so no polling and no sleeping happens.

Usage: python3 gee-export-answer.py <geocode.py>   [answers on stdout as JSON]
"""

import importlib.util
import json
import sys
import types

# Before the import below, which is what writes it: loading a module by path
# drops a __pycache__ next to the SOURCE file, inside the shipping tree. It has
# been committed by accident once already.
sys.dont_write_bytecode = True

STATES = ["COMPLETED", "FAILED", "CANCELLED", "UNKNOWN"]


class Task:
    def __init__(self, state):
        self._state = state
        self.id = "T-fake"

    def start(self):
        pass

    def active(self):
        return False

    def status(self):
        payload = {"state": self._state}
        if self._state == "FAILED":
            payload["error_message"] = "quota exhausted"
        return payload


def fake_ee(state):
    module = types.ModuleType("ee")
    image = types.SimpleNamespace(toDrive=lambda **kwargs: Task(state))
    module.batch = types.SimpleNamespace(Export=types.SimpleNamespace(image=image))
    return module


spec = importlib.util.spec_from_file_location("geocode_under_test", sys.argv[1])
geocode = importlib.util.module_from_spec(spec)
spec.loader.exec_module(geocode)

answers = {}
for state in STATES:
    sys.modules["ee"] = fake_ee(state)
    try:
        geocode.export_image(image=None, description="scene", region=None)
        answers[state] = {"outcome": "returned"}
    except Exception as error:
        answers[state] = {"outcome": "raised", "message": str(error)}

print(json.dumps(answers))
