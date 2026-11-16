import assert from "node:assert/strict"
import { test } from "node:test"
import { Basemap } from "../../../src/basemap/index.ts"
import DARK from "../../../src/basemap/dark.json" with { type: "json" }
import LIBERTY from "../../../src/basemap/liberty.json" with { type: "json" }

type Layer = { id: string; layout?: { "text-field"?: unknown } }

const FIRST = { en: "name:en", "zh-CN": "name:zh-Hans", "zh-TW": "name:zh-Hant" } as const

// Guards against a style taken from OpenFreeMap again leaving a label in its own language, or drawing something the
// archives do not hold: the maps would show it silently.
test("every label that names a place shows the interface's language, from the bundled files alone", () => {
  for (const [theme, base] of [
    ["light", LIBERTY],
    ["dark", DARK],
  ] as const) {
    for (const locale of ["en", "zh-CN", "zh-TW"] as const) {
      const style = Basemap.style(theme, locale)
      const named = (style.layers as Layer[]).filter((layer) =>
        JSON.stringify(layer.layout?.["text-field"] ?? null).includes('"name'),
      )
      assert.ok(named.length > 5, `${theme} has place labels`)
      for (const layer of named) {
        assert.deepEqual((layer.layout?.["text-field"] as unknown[])[1], ["get", FIRST[locale]], `${theme} ${layer.id}`)
      }
      // Every layer kept, borders among them.
      assert.deepEqual(
        (style.layers as Layer[]).map((layer) => layer.id),
        (base.layers as Layer[]).map((layer) => layer.id),
      )
      assert.ok(!("glyphs" in style), "no glyphs to fetch")
      const urls = [style.sprite, ...Object.values(style.sources).flatMap((source) => source.tiles)]
      assert.ok(urls.every((url) => url.startsWith("geocode-basemap://")), urls.join(" "))
    }
  }
})
