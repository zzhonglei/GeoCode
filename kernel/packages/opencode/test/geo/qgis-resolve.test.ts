import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import type { GeoRuntime } from "@/geo/runtime"
import { QgisDiagnostics } from "@/geo/qgis/diagnostics"
import { QgisMacOS } from "@/geo/qgis/macos"
import { QgisProbe } from "@/geo/qgis/probe"
import { QgisResolve } from "@/geo/qgis/resolve"
import { QgisWindows } from "@/geo/qgis/windows"

/* QGIS environment resolution (docs/GEOKERNEL.md §4.3–§4.6, §4.10), on a synthetic bundle carrying the traps of a
 * real 3.44 install and on `path.win32` for the Windows logic, which is pure. */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "geo-qgis-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

/** A synthetic bundle reproducing the 3.44 layout, traps included. */
function makeBundle(name = "QGIS.app"): string {
  const bundle = path.join(root, name)
  const macos = path.join(bundle, "Contents", "MacOS")
  const resources = path.join(bundle, "Contents", "Resources")
  fs.mkdirSync(macos, { recursive: true })
  // The marker that separates a QGIS bundle from any other application.
  fs.writeFileSync(path.join(macos, "qgis_process"), "")
  // Newer layout: versioned interpreter at the prefix root, no bin/.
  fs.writeFileSync(path.join(macos, "python3.12"), "")
  // The first trap: the standard library directory's name does not match the interpreter's version.
  const stdlib = path.join(resources, "python3.11")
  fs.mkdirSync(path.join(stdlib, "encodings"), { recursive: true })
  fs.writeFileSync(path.join(stdlib, "encodings", "__init__.py"), "")
  fs.mkdirSync(path.join(stdlib, "site-packages", "qgis"), { recursive: true })
  fs.writeFileSync(path.join(stdlib, "site-packages", "qgis", "__init__.py"), "")
  // Resources nested one level deeper than the older layout — the second trap.
  fs.mkdirSync(path.join(resources, "qgis", "proj"), { recursive: true })
  fs.writeFileSync(path.join(resources, "qgis", "proj", "proj.db"), "")
  fs.mkdirSync(path.join(resources, "qgis", "gdal"), { recursive: true })
  fs.mkdirSync(path.join(resources, "qgis", "python", "plugins"), { recursive: true })
  return bundle
}

describe("qgis macos resolution", () => {
  const bundle = makeBundle()
  const prefix = path.join(bundle, "Contents", "MacOS")

  test("every hint shape converges on the same prefix", () => {
    for (const hint of [
      bundle,
      prefix,
      path.join(prefix, "python3.12"),
      path.join(prefix, "bin", "python3"), // older-layout shape on a newer install
      path.join(bundle, "Contents", "Resources", "qgis", "gdal"),
    ]) {
      const resolved = QgisMacOS.resolvePrefix(hint)
      expect(resolved.prefix).toBe(prefix)
      expect(resolved.verified).toBe(true)
    }
  })

  test("a bundle without the marker is a definite not-qgis, not a guess", () => {
    const impostor = path.join(root, "Notes.app", "Contents", "MacOS")
    fs.mkdirSync(impostor, { recursive: true })
    const resolved = QgisMacOS.resolvePrefix(path.join(root, "Notes.app"))
    expect(resolved.notQgis).toBe(true)
    expect(resolved.prefix).toBeUndefined()
  })

  test("the non-bundle fallback is explicitly unverified", () => {
    // The reachability precheck refuses a level 3 answer on this flag, so setting it here lets a nonexistent hint
    // through to come back as a spawn error wearing the probe script (§4.3 principle 10).
    const resolved = QgisMacOS.resolvePrefix("/nonexistent/place/python3")
    expect(resolved.verified).toBe(false)
  })

  test("the standard library is found by content, not by version match", () => {
    const resources = path.join(bundle, "Contents", "Resources")
    expect(QgisMacOS.findStandardLibrary(resources)).toBe(path.join(resources, "python3.11"))
  })

  test("assembly finds the nested resources and validates the projection payload", () => {
    const interpreter = path.join(prefix, "python3.12")
    const { env, choices } = QgisMacOS.assemble(prefix, interpreter)

    const resources = path.join(bundle, "Contents", "Resources")
    expect(env.PROJ_LIB).toBe(path.join(resources, "qgis", "proj"))
    expect(env.PROJ_DATA).toBe(env.PROJ_LIB)
    expect(env.GDAL_DATA).toBe(path.join(resources, "qgis", "gdal"))
    // Plugins included, because the algorithm framework initialises before QGIS would append that directory.
    expect(env.PYTHONPATH).toContain(path.join(resources, "qgis", "python"))
    expect(env.PYTHONPATH).toContain(path.join(resources, "qgis", "python", "plugins"))
    expect(env.PYTHONPATH).toContain(path.join(resources, "python3.11", "site-packages"))
    expect(env.PYTHONHOME).toBeTruthy()
    const link = path.join(env.PYTHONHOME!, "lib", "python3.12")
    expect(fs.readlinkSync(link)).toBe(path.join(resources, "python3.11"))
    // Every track sets the encoding trio (§4.13 constraint 2).
    expect(env.PYTHONUTF8).toBe("1")
    expect(env.PYTHONIOENCODING).toBe("UTF-8")
    expect(env.GDAL_FILENAME_IS_UTF8).toBe("YES")
    // Choices carry the alternatives, not just the winners (§4.10).
    expect(choices.projection!.candidates.length).toBeGreaterThan(1)
  })

  test("the link farm is idempotent and follows a moved install", () => {
    const resources = path.join(bundle, "Contents", "Resources")
    const stdlib = path.join(resources, "python3.11")
    const interpreter = path.join(prefix, "python3.12")

    const first = QgisMacOS.ensurePythonHome(interpreter, stdlib)
    const second = QgisMacOS.ensurePythonHome(interpreter, stdlib)
    expect(second).toBe(first!)

    // The user reinstalls somewhere else: the link must follow, not linger.
    const moved = makeBundle("QGIS-LTR.app")
    const movedStdlib = path.join(moved, "Contents", "Resources", "python3.11")
    QgisMacOS.ensurePythonHome(interpreter, movedStdlib)
    expect(fs.readlinkSync(path.join(first!, "lib", "python3.12"))).toBe(movedStdlib)
  })
})

describe("qgis windows pure logic", () => {
  const win = path.win32

  test("sub-prefix preference is fixed, not filesystem-order", () => {
    // §4.3 principle 3: long-term support > current > development > variants.
    const ranked = [
      "C:\\OSGeo4W\\apps\\somethingelse",
      "C:\\OSGeo4W\\apps\\qgis-dev",
      "C:\\OSGeo4W\\apps\\qgis-ltr-test",
      "C:\\OSGeo4W\\apps\\qgis",
      "C:\\OSGeo4W\\apps\\qgis-ltr",
    ].sort((a, b) => QgisWindows.subPrefixRank(a) - QgisWindows.subPrefixRank(b))
    expect(ranked.map((p) => win.basename(p))).toEqual([
      "qgis-ltr",
      "qgis",
      "qgis-dev",
      "qgis-ltr-test",
      "somethingelse",
    ])
  })

  test("projection ranking prefers the conventional locations", () => {
    const root = "C:\\OSGeo4W"
    const sub = "C:\\OSGeo4W\\apps\\qgis-ltr"
    const conventional = QgisWindows.projectionRank("C:\\OSGeo4W\\share\\proj", root, sub)
    const pattern = QgisWindows.projectionRank("D:\\elsewhere\\share\\proj", root, sub)
    const unknown = QgisWindows.projectionRank("D:\\random\\data", root, sub)
    expect(conventional).toBeLessThan(pattern)
    expect(pattern).toBeLessThan(unknown)
  })

  test("only the QGIS prefix variable gets forward slashes", () => {
    expect(QgisWindows.toQgisPath("C:\\OSGeo4W\\apps\\qgis-ltr")).toBe("C:/OSGeo4W/apps/qgis-ltr")
    expect(QgisWindows.toNativeSep("C:/OSGeo4W/apps/qgis-ltr")).toBe("C:\\OSGeo4W\\apps\\qgis-ltr")
  })

  test("the launcher dump script is one line of pure ASCII", () => {
    // Either property lost mangles the script in a system language the command interpreter handles differently,
    // which silently forces the manual fallback (§4.5).
    expect(QgisWindows.ENV_DUMP_SCRIPT).not.toContain("\n")
    expect([...QgisWindows.ENV_DUMP_SCRIPT].every((ch) => ch.charCodeAt(0) < 128)).toBe(true)
  })

  test("a dump missing any critical key is rejected whole", () => {
    // PATH is the one that must not be waved through: this track registers no library directories and rides
    // entirely on the adopted search path, so an empty one passes the probe and fails on first real use (§4.5).
    const base = {
      QGIS_PREFIX_PATH: "C:/OSGeo4W/apps/qgis-ltr",
      PYTHONHOME: "C:\\OSGeo4W\\apps\\Python312",
      PATH: "C:\\OSGeo4W\\bin",
    }
    expect(QgisWindows.adoptBridgeDump({ ...base, PATH: "" }, "C:\\OSGeo4W")).toBeUndefined()
    expect(QgisWindows.adoptBridgeDump({ ...base, PYTHONHOME: "" }, "C:\\OSGeo4W")).toBeUndefined()

    const adopted = QgisWindows.adoptBridgeDump(base, "C:\\OSGeo4W")!
    // The launcher is the authority on the interpreter; the hint stops mattering.
    expect(adopted.interpreter).toBe("C:\\OSGeo4W\\apps\\Python312\\python.exe")
    // The prefix comes back in native separators for our own bookkeeping.
    expect(adopted.prefix).toBe("C:\\OSGeo4W\\apps\\qgis-ltr")
    // Overlay 1: the encoding trio a launcher built for interactive use never sets.
    expect(adopted.env.PYTHONUTF8).toBe("1")
    expect(adopted.env.PYTHONIOENCODING).toBe("UTF-8")
    // Adoption is complete, not filtered: unlisted variables survive (§4.3 p8).
    expect(
      QgisWindows.adoptBridgeDump({ ...base, SOME_QGIS_INTERNAL: "kept" }, "C:\\OSGeo4W")!.env.SOME_QGIS_INTERNAL,
    ).toBe("kept")
  })
})

describe("qgis probe grading", () => {
  /** A runtime whose subprocess "runs" are scripted per call. */
  function stubRuntime(results: Partial<GeoRuntime.Result>[]): GeoRuntime.Interface {
    let call = 0
    return {
      run: () => {
        const result = results[Math.min(call++, results.length - 1)]!
        return Effect.succeed({
          code: 0,
          reason: "exit",
          stdout: "",
          stderr: "",
          durationMs: 1,
          truncated: false,
          drainIncomplete: false,
          ...result,
        } satisfies GeoRuntime.Result)
      },
      start: () => Effect.die("not used") as never,
      list: () => Effect.succeed([]),
      terminateAll: () => Effect.void,
      killAllSync: () => {},
    }
  }

  const marked = (payload: object) => `noise before\n${QgisProbe.MARKER}${JSON.stringify(payload)}\nteardown noise`

  test("a full report grades as success despite surrounding noise", async () => {
    const runtime = stubRuntime([
      {
        stdout: marked({
          pythonVersion: "3.12.11",
          gdalVersion: "3.12.0",
          projTransformReady: true,
          qgisVersion: "3.44.9",
          processingReady: true,
        }),
      },
    ])
    const outcome = await Effect.runPromise(QgisProbe.run(runtime, "python", {}, []))
    expect(outcome.ok).toBe(true)
  })

  test("each failing step names its own failure", async () => {
    const cases: [object, string][] = [
      [{ pythonVersion: "3", gdalVersion: "", gdalTraceback: "ImportError: osgeo" }, "gdal-missing"],
      [
        { pythonVersion: "3", gdalVersion: "3.12", projTransformReady: false, projTransformError: "no proj.db" },
        "proj-broken",
      ],
      [
        {
          pythonVersion: "3",
          gdalVersion: "3.12",
          projTransformReady: true,
          qgisVersion: "",
          qgisTraceback: "DLL load failed",
        },
        "core-missing",
      ],
    ]
    for (const [payload, failure] of cases) {
      const outcome = await Effect.runPromise(
        QgisProbe.run(stubRuntime([{ stdout: marked(payload) }]), "python", {}, []),
      )
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.failure).toBe(failure as never)
    }
  })

  test("no marker means startup crash, and the raw output IS the diagnosis", async () => {
    const runtime = stubRuntime([
      { code: 1, stdout: "Could not find platform independent libraries <prefix>", stderr: "init_fs_encoding failed" },
    ])
    const outcome = await Effect.runPromise(QgisProbe.run(runtime, "python", {}, []))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.failure).toBe("probe-failed")
      expect(outcome.startupCrash).toBe(true)
      // §4.6: the script never reached its emit, so what the interpreter printed is the only evidence there is.
      expect(outcome.detail).toContain("platform independent libraries")
      expect(outcome.detail).toContain("init_fs_encoding")
    }
  })

  test("a marker that will not parse is not called a startup crash", async () => {
    // Grading this as a startup crash drops the parse error and trips resolve.ts's unknown-layout retry, which is
    // keyed on exactly that flag (§4.6 keeps 无标记 and 标记内容非法 apart).
    const runtime = stubRuntime([{ stdout: `${QgisProbe.MARKER}{definitely not json` }])
    const outcome = await Effect.runPromise(QgisProbe.run(runtime, "python", {}, []))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.failure).toBe("probe-failed")
      expect(outcome.startupCrash).toBe(false)
      expect(outcome.detail).toContain("would not parse")
    }
  })

  test("a timeout is its own failure, not a generic one", async () => {
    const outcome = await Effect.runPromise(
      QgisProbe.run(stubRuntime([{ reason: "timeout", code: null }]), "python", {}, []),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.failure).toBe("probe-timeout")
  })
})

describe("qgis resolve orchestration", () => {
  /** A runtime that scripts each probe call and records the env it was given. */
  function recordingRuntime(results: Partial<GeoRuntime.Result>[]) {
    const seen: Record<string, string>[] = []
    const runtime: GeoRuntime.Interface = {
      run: (options) => {
        seen.push(options.env ?? {})
        const result = results[Math.min(seen.length - 1, results.length - 1)]!
        return Effect.succeed({
          code: 0,
          reason: "exit",
          stdout: "",
          stderr: "",
          durationMs: 1,
          truncated: false,
          drainIncomplete: false,
          ...result,
        } satisfies GeoRuntime.Result)
      },
      start: () => Effect.die("not used") as never,
      list: () => Effect.succeed([]),
      terminateAll: () => Effect.void,
      killAllSync: () => {},
    }
    return { runtime, seen }
  }

  const success = `${QgisProbe.MARKER}${JSON.stringify({
    pythonVersion: "3.12.11",
    gdalVersion: "3.12.0",
    projTransformReady: true,
    qgisVersion: "3.44.9",
    processingReady: true,
  })}`

  test.skipIf(process.platform === "win32")(
    "an unknown layout is rescued by the deep search and one retry",
    async () => {
      // The standard library sits deeper than Resources/python3.NN, so layout detection misses it, assembly sets
      // no PYTHONHOME and the first probe dies at startup — the only road left is the §4.6 fallback.
      const bundle = path.join(root, "QGIS-Unknown.app")
      const macos = path.join(bundle, "Contents", "MacOS")
      fs.mkdirSync(macos, { recursive: true })
      fs.writeFileSync(path.join(macos, "qgis_process"), "")
      fs.writeFileSync(path.join(macos, "python3.12"), "")
      const hidden = path.join(bundle, "Contents", "Resources", "lib", "cpython")
      fs.mkdirSync(path.join(hidden, "encodings"), { recursive: true })
      fs.writeFileSync(path.join(hidden, "encodings", "__init__.py"), "")

      const { runtime, seen } = recordingRuntime([
        // First probe: interpreter startup crash — no marker, raw complaint.
        { code: 1, stdout: "Could not find platform independent libraries <prefix>" },
        // Second probe, after the link structure exists: full success.
        { stdout: success },
      ])

      const resolution = await Effect.runPromise(QgisResolve.resolve(bundle, runtime))

      expect(resolution.ok).toBe(true)
      expect(seen).toHaveLength(2)
      // The first attempt ran without a home — that is what made it crash.
      expect(seen[0]!.PYTHONHOME).toBeUndefined()
      expect(seen[1]!.PYTHONHOME).toBeTruthy()
      const link = path.join(seen[1]!.PYTHONHOME!, "lib", "python3.12")
      expect(fs.readlinkSync(link)).toBe(hidden)
      if (resolution.ok) expect(resolution.environment.env.PYTHONHOME).toBe(seen[1]!.PYTHONHOME!)
    },
  )

  test.skipIf(process.platform === "win32")("a real interpreter outranks a missing marker", async () => {
    // A missing `qgis_process` must not veto a hint that names an interpreter, since for a pruned or renamed
    // build the probe is the only honest judge (§4.3 principle 10).
    const bundle = path.join(root, "Derived.app")
    const macos = path.join(bundle, "Contents", "MacOS")
    fs.mkdirSync(macos, { recursive: true })
    fs.writeFileSync(path.join(macos, "python3.12"), "") // no qgis_process, no QGIS

    const { runtime, seen } = recordingRuntime([{ stdout: success }])
    const viaInterpreter = await Effect.runPromise(QgisResolve.resolve(path.join(macos, "python3.12"), runtime))
    expect(viaInterpreter.ok).toBe(true)
    expect(seen).toHaveLength(1)

    // The bundle ROOT is not an interpreter: no escape hatch, clean verdict.
    const viaRoot = await Effect.runPromise(QgisResolve.resolve(bundle, runtime))
    expect(viaRoot.ok).toBe(false)
    if (!viaRoot.ok) expect(viaRoot.failure).toBe("not-qgis")
  })

  test.skipIf(process.platform === "win32")("a startup crash with no rescue keeps the raw output", async () => {
    const bundle = path.join(root, "QGIS-Bare.app")
    const macos = path.join(bundle, "Contents", "MacOS")
    fs.mkdirSync(macos, { recursive: true })
    fs.writeFileSync(path.join(macos, "qgis_process"), "")
    fs.writeFileSync(path.join(macos, "python3.12"), "")
    // No encodings anywhere: the deep search comes up empty, no retry happens.

    const { runtime, seen } = recordingRuntime([{ code: 1, stdout: "init_fs_encoding: failed to import encodings" }])
    const resolution = await Effect.runPromise(QgisResolve.resolve(bundle, runtime))

    expect(seen).toHaveLength(1)
    expect(resolution.ok).toBe(false)
    if (!resolution.ok) {
      expect(resolution.failure).toBe("probe-failed")
      // §4.6: the script never spoke, so `diagnostics.output` carries the interpreter's own complaint intact.
      expect(resolution.diagnostics.output).toContain("init_fs_encoding")
    }
  })
})

describe("qgis diagnostics", () => {
  test("the display environment admits nothing that was not listed", () => {
    const filtered = QgisDiagnostics.displayEnv({
      QGIS_PREFIX_PATH: "/x",
      PROJ_LIB: "/y",
      PATH: "/bin",
      PYTHONHOME: "/home",
      ANTHROPIC_API_KEY: "secret",
      GH_TOKEN: "secret",
      SOME_RANDOM: "value",
    })
    expect(filtered.QGIS_PREFIX_PATH).toBe("/x")
    expect(filtered.PATH).toBe("/bin")
    expect(filtered.PYTHONHOME).toBe("/home")
    expect(filtered.ANTHROPIC_API_KEY).toBeUndefined()
    expect(filtered.GH_TOKEN).toBeUndefined()
    expect(filtered.SOME_RANDOM).toBeUndefined()
  })

  test("checks validate the projection payload, not the directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geo-proj-"))
    try {
      // Directory exists, database does not — the §4.3 principle 4 case.
      const checks = QgisDiagnostics.pathChecks({
        prefix: "/nowhere",
        env: { PROJ_LIB: dir },
        dllDirectories: [],
        platform: "darwin",
      })
      expect(checks[path.join(dir, "proj.db")]).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the python package is one finding, not a cross per module-path entry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geo-pythonpath-"))
    try {
      const good = path.join(dir, "python")
      const plugins = path.join(good, "plugins")
      fs.mkdirSync(path.join(good, "qgis"), { recursive: true })
      fs.writeFileSync(path.join(good, "qgis", "__init__.py"), "")
      fs.mkdirSync(path.join(plugins, "processing"), { recursive: true })
      fs.writeFileSync(path.join(plugins, "processing", "__init__.py"), "")
      const inherited = path.join(dir, "my-own-libs")

      const checks = QgisDiagnostics.pathChecks({
        prefix: "/nowhere",
        // The real shape: module directory, plugins directory, and whatever the user's own PYTHONPATH added.
        env: { PYTHONPATH: [good, plugins, inherited].join(":") },
        dllDirectories: [],
        platform: "darwin",
      })

      // One entry per module path would put two guaranteed crosses on a healthy install, since neither the
      // plugins nor the inherited directory is supposed to carry the package.
      expect(checks[path.join(good, "qgis", "__init__.py")]).toBe(true)
      expect(checks[path.join(plugins, "qgis", "__init__.py")]).toBeUndefined()
      expect(checks[path.join(inherited, "qgis", "__init__.py")]).toBeUndefined()
      // The plugins entry gets the check that belongs to it instead.
      expect(checks[path.join(plugins, "processing", "__init__.py")]).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a python package found nowhere makes the candidates the diagnosis", () => {
    const checks = QgisDiagnostics.pathChecks({
      prefix: "/nowhere",
      env: { PYTHONPATH: "/gone/python:/gone/other" },
      dllDirectories: [],
      platform: "darwin",
    })
    expect(checks[path.join("/gone/python", "qgis", "__init__.py")]).toBe(false)
    expect(checks[path.join("/gone/other", "qgis", "__init__.py")]).toBe(false)
  })
})
