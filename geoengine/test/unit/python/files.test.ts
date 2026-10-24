import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { Environment } from "../../../src/python/index.ts"
import { python3, VERSION, bundle, exists, settle, sitePackages, steps, temporary } from "../../support/python.ts"

const posix = process.platform !== "win32"

/** Every file under a folder, with what tells a file written again from one left alone. */
const stamps = async (folder: string) => {
  const found: Record<string, string> = {}
  for (const entry of await fs.readdir(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    const stats = await fs.stat(file)
    found[file] = `${stats.ino}:${stats.mtimeMs}`
  }
  return found
}

test(
  "geocodekit is written into the base environment with a dist-info Python reads, at GeoCode's version",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    try {
      const where = Environment.layout(path.join(directory, "data"))
      const { last } = await settle(directory, await bundle(directory, "one"))
      assert.equal(last.status, "ready")
      const site = sitePackages(where)
      const app = path.resolve(import.meta.dirname, "../../../../desktop/packages/electron/package.json")
      const version = JSON.parse(await fs.readFile(app, "utf-8")).build.extraMetadata.version
      // Guards against a dist-info Python does not read, or whose record does not match the files it lists.
      const script = [
        "import base64, hashlib, importlib.metadata, json, sys",
        "found = [d for d in importlib.metadata.distributions(path=[sys.argv[1]]) if d.metadata['Name'] == 'geocodekit']",
        "checked = {}",
        "for listed in found[0].files:",
        "    data = listed.locate().read_bytes()",
        "    if listed.hash is None:",
        "        continue",
        "    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode()",
        "    checked[str(listed)] = digest == listed.hash.value and len(data) == listed.size",
        "print(json.dumps({'count': len(found), 'version': found[0].version, 'checked': checked}))",
      ].join("\n")
      const read = JSON.parse(execFileSync(python3!, ["-I", "-c", script, site], { encoding: "utf-8" }))
      assert.equal(read.count, 1)
      assert.equal(read.version, version)
      // Guards against pyproject.toml naming the package otherwise than the dist-info GeoEngine writes.
      const project = await fs.readFile(path.resolve(import.meta.dirname, "../../../python/pyproject.toml"), "utf-8")
      assert.match(project, /^name = "geocodekit"$/m)
      assert.ok(read.checked["geocodekit/__init__.py"])
      assert.ok(read.checked["geocodekit/gee/_run.py"])
      assert.ok(Object.values(read.checked).every(Boolean), JSON.stringify(read.checked))
      // Guards against a package written from another place than geoengine/python, or with files left out.
      const source = path.resolve(import.meta.dirname, "../../../python/geocodekit/gee/_assets.py")
      assert.equal(
        await fs.readFile(path.join(site, "geocodekit", "gee", "_assets.py"), "utf-8"),
        await fs.readFile(source, "utf-8"),
      )
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

test("a later start with nothing changed writes nothing into the base environment", { skip: !python3 }, async () => {
  const directory = await temporary()
  try {
    const where = Environment.layout(path.join(directory, "data"))
    const bundled = await bundle(directory, "one")
    await settle(directory, bundled)
    const before = await stamps(where.base)

    const { last } = await settle(directory, bundled)
    assert.equal(last.status, "ready")
    // Guards against a file pulled from under a Python of another GeoCode, or of a run not yet ended, using it.
    assert.deepEqual(await stamps(where.base), before)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test(
  "what differs of GeoEngine's own files is put right without installing the environment again",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    try {
      const where = Environment.layout(path.join(directory, "data"))
      const bundled = await bundle(directory, "one")
      await settle(directory, bundled)
      const site = sitePackages(where)
      const kit = path.join(site, "geocodekit")
      // As an older GeoCode, or a start cut short, leaves them: another startup file; a module half written, one
      // missing, and a module and a subpackage this GeoCode does not have; another version's dist-info; and a marker
      // with a field this GeoCode does not write.
      await fs.writeFile(path.join(site, "_geocode_environment.py"), "# an older startup file\n")
      await fs.rm(path.join(site, "_geocode_environment.pth"))
      await fs.rm(path.join(path.dirname(site), "EXTERNALLY-MANAGED"))
      await fs.writeFile(path.join(kit, "gee", "_run.py"), "half a fi")
      await fs.rm(path.join(kit, "_tool.py"))
      await fs.writeFile(path.join(kit, "gee", "_older.py"), "")
      await fs.mkdir(path.join(kit, "older", "__pycache__"), { recursive: true })
      await fs.writeFile(path.join(kit, "older", "__init__.py"), "")
      await fs.writeFile(path.join(kit, "older", "__pycache__", "__init__.cpython-313.pyc"), "")
      await fs.mkdir(path.join(site, "geocodekit-0.9.0.dist-info"))
      await fs.writeFile(path.join(site, "geocodekit-0.9.0.dist-info", "METADATA"), "Name: geocodekit\n")
      // Python's own, kept.
      await fs.mkdir(path.join(kit, "__pycache__"))
      await fs.writeFile(path.join(kit, "__pycache__", "__init__.cpython-313.pyc"), "")
      const marker = JSON.parse(await fs.readFile(where.marker, "utf-8"))
      await fs.writeFile(where.marker, JSON.stringify({ ...marker, written: "an older GeoCode's" }))
      // A file a start cut short left before moving it into place.
      await fs.writeFile(path.join(where.root, ".writing-cut"), "half")

      const { last, states } = await settle(directory, bundled)
      assert.equal(last.status, "ready")
      assert.ok(!steps(states).includes("installing"))
      // Guards against keeping any file another GeoCode wrote, or a module or subpackage it had and this one has not.
      const { write, remove } = await Environment.compare(where, VERSION)
      assert.deepEqual([...write, ...remove], [])
      assert.ok(!(await exists(path.join(kit, "gee", "_older.py"))))
      assert.ok(!(await exists(path.join(kit, "older"))))
      assert.ok(!(await exists(path.join(site, "geocodekit-0.9.0.dist-info"))))
      assert.ok(await exists(path.join(kit, "__pycache__", "__init__.cpython-313.pyc")))
      assert.ok(!(await exists(path.join(where.root, ".writing-cut"))))
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

test(
  "a base environment GeoEngine cannot write its own files into is not ready, and is put right later",
  { skip: !python3 || !posix },
  async () => {
    const directory = await temporary()
    const where = Environment.layout(path.join(directory, "data"))
    const gee = path.join(sitePackages(where), "geocodekit", "gee")
    try {
      const bundled = await bundle(directory, "one")
      await settle(directory, bundled)
      await fs.writeFile(path.join(gee, "_run.py"), "# another GeoCode's\n")
      await fs.chmod(gee, 0o555)

      const { last } = await settle(directory, bundled)
      assert.equal(last.status, "failed")
      assert.equal(last.status === "failed" && last.diagnostics.step, "files")

      await fs.chmod(gee, 0o755)
      const back = await settle(directory, bundled)
      assert.equal(back.last.status, "ready")
      assert.deepEqual((await Environment.compare(where, VERSION)).write, [])
    } finally {
      await fs.chmod(gee, 0o755).catch(() => undefined)
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)
