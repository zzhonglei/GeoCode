import { describe, expect, test } from "bun:test"
import { GeoShell } from "../src/geocode/shell"

const activation = {
  path: ["/env/bin", "/base/bin"],
  set: { GDAL_DATA: "/base/share/gdal", PYTHONNOUSERSITE: "1" },
  fallback: { SSL_CERT_FILE: "/base/ssl/cacert.pem" },
  remove: ["PYTHONPATH", "PYTHONHOME"],
}

describe("GeoCode: activating GeoAgent's shell", () => {
  test("puts the environment's folders first and its variables in place of the user's", () => {
    const env: Record<string, string | undefined> = {
      PATH: "/base/bin:/opt/homebrew/bin:/usr/bin",
      GDAL_DATA: "/the/user's/gdal",
      PYTHONPATH: "/the/user's/packages",
      SSL_CERT_FILE: "/the/user's/certificates.pem",
      HOME: "/home",
    }
    GeoShell.apply(env, activation, "darwin")
    expect(env).toEqual({
      // Guards against the user's python found before the environment's, and a folder listed twice.
      PATH: "/env/bin:/base/bin:/opt/homebrew/bin:/usr/bin",
      GDAL_DATA: "/base/share/gdal",
      PYTHONNOUSERSITE: "1",
      SSL_CERT_FILE: "/the/user's/certificates.pem",
      HOME: "/home",
    })
  })

  test("on Windows, replaces a variable whatever case the user's environment spells it in", () => {
    const env: Record<string, string | undefined> = {
      Path: "C:\\Windows;C:\\Users\\me\\conda",
      PythonPath: "C:\\Users\\me\\packages",
      gdal_data: "C:\\the user's\\gdal",
      ssl_cert_file: "C:\\the user's\\certificates.pem",
    }
    GeoShell.apply(env, activation, "win32")
    // Guards against a second PATH or GDAL_DATA beside the user's, of which a child process takes either, and the
    // user's PYTHONPATH or certificates read past for their case.
    expect(env).toEqual({
      PATH: "/env/bin;/base/bin;C:\\Windows;C:\\Users\\me\\conda",
      GDAL_DATA: "/base/share/gdal",
      PYTHONNOUSERSITE: "1",
      ssl_cert_file: "C:\\the user's\\certificates.pem",
    })
  })
})
