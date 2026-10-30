import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { test } from "node:test"
import { Library } from "../../../src/gee/library.ts"

// Guards against the copies of the name rule drifting apart: a name one allows and another refuses, or one longer than
// an export's description has room for, which leaves a running export no longer known by its task.
test("the kernel, GeoEngine and geocodekit hold task and asset names to the same rule", async () => {
  const read = (file: string) => fs.readFile(new URL(file, import.meta.url), "utf8")
  const kernel = await read("../../../../kernel/packages/core/src/geocode/geerun.ts")
  const python = await read("../../../python/geocodekit/gee/_run.py")
  const rule = Library.NAME.source.slice(1, -1)
  assert.equal(kernel.match(/^const TASK_NAME = \/(.+)\/$/m)?.[1], Library.NAME.source)
  assert.equal(python.match(/^NAME = re\.compile\(r"(.+)"\)$/m)?.[1], Library.NAME.source)
  assert.ok(python.match(/^LABEL = re\.compile\(r"(.+)"\)$/m)?.[1].startsWith(`^(${rule}):(${rule}):`))
})
