import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { Environment } from "../../../src/python/index.ts"
import { python3, bundle, calls, settle, temporary } from "../../support/python.ts"

test(
  "the Python is run isolated, with the network's variables and HOME of the engine's environment alone",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    process.env.https_proxy = "http://proxy.test:3128"
    process.env.ALL_PROXY = "socks5://proxy.test:1080"
    process.env.GDAL_DATA = "/the/user's/gdal"
    process.env.GEOENGINE_TEST_USER_ONLY = "the user's"
    try {
      await settle(directory, await bundle(directory, "one"))
      const pythons = (await calls(directory)).filter((call) => call.program === "PYTHON")
      assert.ok(pythons.length > 0)
      for (const { args, env } of pythons) {
        assert.deepEqual(args.slice(0, 4), ["-I", "-X", "utf8", "-u"])
        assert.equal(env.get("https_proxy"), "http://proxy.test:3128")
        assert.equal(env.get("HOME"), process.env.HOME)
        // Guards against a proxy the kernel's model requests do not follow.
        assert.ok(!env.has("ALL_PROXY"))
        assert.ok(!env.has("GDAL_DATA"))
        assert.ok(!env.has("GEOENGINE_TEST_USER_ONLY"))
      }
    } finally {
      delete process.env.https_proxy
      delete process.env.ALL_PROXY
      delete process.env.GDAL_DATA
      delete process.env.GEOENGINE_TEST_USER_ONLY
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

test(
  "every Python of the environment sets the environment's own variables as it starts, in place of the user's",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    try {
      const where = Environment.layout(path.join(directory, "data"))
      await settle(directory, await bundle(directory, "one"))
      const site = path.join(where.stdlib("3.13.16"), "site-packages")
      // Guards against a Python started outside GeoEngine, as in GeoAgent's shell, finding its data by the user's
      // GDAL_DATA and PROJ_DATA, or not finding it at all.
      const names = [
        "GDAL_DATA",
        "GDAL_DRIVER_PATH",
        "PROJ_DATA",
        "PROJ_NETWORK",
        "PROJ_USER_WRITABLE_DIRECTORY",
        "GDAL_CONFIG_FILE",
      ]
      const script = [
        "import json, os, site, sys",
        `site.addsitedir(${JSON.stringify(site)})`,
        `print(json.dumps([sys.base_prefix, {name: os.environ.get(name) for name in ${JSON.stringify(names)}}]))`,
      ].join("\n")
      const output = execFileSync(python3!, ["-I", "-c", script], {
        encoding: "utf-8",
        env: Object.fromEntries(names.map((name) => [name, "the user's"])),
      })
      const [base, variables] = JSON.parse(output) as [string, Record<string, string>]
      assert.deepEqual(variables, {
        GDAL_DATA: path.join(base, "share", "gdal"),
        GDAL_DRIVER_PATH: path.join(base, "lib", "gdalplugins"),
        PROJ_DATA: path.join(base, "share", "proj"),
        PROJ_NETWORK: "ON",
        PROJ_USER_WRITABLE_DIRECTORY: path.join(path.dirname(base), "proj"),
        GDAL_CONFIG_FILE: path.join(base, "gdalrc"),
      })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

test(
  "every Python of the environment takes its proxy from the proxy variables alone, as the kernel does",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    try {
      const where = Environment.layout(path.join(directory, "data"))
      await settle(directory, await bundle(directory, "one"))
      const site = path.join(where.stdlib("3.13.16"), "site-packages")
      // Stand-ins for the system's proxy settings as macOS gives them to urllib, and for aiohttp's session.
      const stubs = path.join(directory, "stubs")
      await fs.mkdir(path.join(stubs, "aiohttp"), { recursive: true })
      await fs.writeFile(
        path.join(stubs, "_scproxy.py"),
        [
          "def _get_proxies():",
          '    return {"http": "http://system.test:8080", "https": "http://system.test:8080"}',
          "def _get_proxy_settings():",
          '    return {"exclude_simple": True, "exceptions": ["direct.test"]}',
        ].join("\n") + "\n",
      )
      await fs.writeFile(path.join(stubs, "aiohttp", "__init__.py"), "from .client import ClientSession\n")
      await fs.writeFile(
        path.join(stubs, "aiohttp", "client.py"),
        [
          "class ClientSession:",
          "    def __init__(self, base_url=None, *, trust_env=False):",
          "        self.trust_env = trust_env",
        ].join("\n") + "\n",
      )
      const names = ["http_proxy", "no_proxy", "NO_PROXY", "ALL_PROXY", "all_proxy"]
      const found = (env: Record<string, string>, startup = true) => {
        const script = [
          "import json, os, site, sys",
          `sys.path.insert(0, ${JSON.stringify(stubs)})`,
          startup ? `site.addsitedir(${JSON.stringify(site)})` : "",
          "import urllib.request, aiohttp",
          "print(json.dumps({",
          '    "proxies": urllib.request.getproxies(),',
          '    "bypassed": [',
          '        host for host in ["localhost", "[::1]:8000", "direct.test", "listed.test"]',
          "        if urllib.request.proxy_bypass(host)",
          "    ],",
          '    "trusting": aiohttp.ClientSession().trust_env,',
          '    "told": aiohttp.ClientSession(trust_env=False).trust_env,',
          `    "variables": {name: os.environ.get(name) for name in ${JSON.stringify(names)}},`,
          "}))",
        ].join("\n")
        return JSON.parse(execFileSync(python3!, ["-I", "-c", script], { encoding: "utf-8", env }))
      }

      const loopback = "listed.test,localhost,127.0.0.1,::1,[::1]"
      // Guards against a Python started outside GeoEngine, as in GeoAgent's shell, taking another proxy than the
      // kernel's model requests: lowercase first, never ALL_PROXY, loopback direct; libcurl reads http_proxy alone.
      assert.deepEqual(
        found({
          HTTP_PROXY: "http://upper.test:1",
          https_proxy: "http://lower.test:2",
          HTTPS_PROXY: "http://upper.test:3",
          NO_PROXY: "listed.test",
          ALL_PROXY: "socks5://all.test:4",
          all_proxy: "socks5://all.test:4",
        }),
        {
          proxies: { http: "http://upper.test:1", https: "http://lower.test:2", no: loopback },
          // As urllib names an IPv6 host it requests.
          bypassed: ["localhost", "[::1]:8000", "listed.test"],
          trusting: true,
          told: false,
          variables: {
            http_proxy: "http://upper.test:1",
            no_proxy: loopback,
            NO_PROXY: loopback,
            ALL_PROXY: null,
            all_proxy: null,
          },
        },
      )
      // Guards against "*" losing its meaning, every host direct, once loopback is added to it.
      const everything = found({ HTTPS_PROXY: "http://upper.test:3", NO_PROXY: "*" })
      assert.deepEqual(everything.bypassed, ["localhost", "[::1]:8000", "direct.test", "listed.test"])
      // Guards against the system's proxy settings standing in when no variable is set; GeoCode's other parts never
      // read them.
      const unset = found({})
      assert.deepEqual([unset.proxies, unset.bypassed], [{}, []])
      // Guards against stand-ins that prove nothing: without the startup file, urllib takes their settings and aiohttp
      // reads no variable.
      const plain = found({}, false)
      if (process.platform === "darwin") {
        assert.deepEqual(
          [plain.proxies, plain.bypassed],
          [
            { http: "http://system.test:8080", https: "http://system.test:8080" },
            ["localhost", "[::1]:8000", "direct.test"],
          ],
        )
      }
      assert.equal(plain.trusting, false)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

test(
  "on Windows the environment's folders come first in PATH, and its certificates stand in for the user's empty ones",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    try {
      const where = Environment.layout(path.join(directory, "data"))
      await settle(directory, await bundle(directory, "one"))
      const module = path.join(where.stdlib("3.13.16"), "site-packages", "_geocode_environment.py")
      // The written module run as on Windows: Windows's paths, and a base of its own.
      const base = "C:\\Users\\me\\.local\\share\\geocode\\python\\base"
      const script = [
        "import json, ntpath, os, sys",
        'sys.platform = "win32"',
        "os.path = ntpath",
        'os.pathsep = ";"',
        `sys.base_prefix = ${JSON.stringify(base)}`,
        `exec(open(${JSON.stringify(module)}, encoding="utf-8").read(), {"__name__": "_geocode_environment"})`,
        'print(json.dumps({name: os.environ.get(name) for name in ["PATH", "SSL_CERT_FILE", "SSL_CERT_DIR"]}))',
      ].join("\n")
      const library = path.win32.join(base, "Library")
      const user = "C:\\Program Files\\QGIS\\bin"
      const output = execFileSync(python3!, ["-I", "-c", script], {
        encoding: "utf-8",
        // The base already in PATH, as a Python started from another of the environment leaves it.
        env: { PATH: [base, user].join(";"), SSL_CERT_FILE: "", SSL_CERT_DIR: "C:\\the user's\\certs" },
      })
      assert.deepEqual(JSON.parse(output), {
        PATH: [
          base,
          path.win32.join(library, "mingw-w64", "bin"),
          path.win32.join(library, "usr", "bin"),
          path.win32.join(library, "bin"),
          path.win32.join(base, "Scripts"),
          path.win32.join(base, "bin"),
          user,
        ].join(";"),
        SSL_CERT_FILE: path.win32.join(library, "ssl", "cacert.pem"),
        SSL_CERT_DIR: "C:\\the user's\\certs",
      })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)
