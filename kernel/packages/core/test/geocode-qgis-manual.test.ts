import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { QgisManual } from "@opencode/core/geocode/qgis-manual"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Image } from "@opencode/core/image"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { WebFetchTool } from "@opencode/core/tool/plugin/webfetch"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

// Shaped like a page of the QGIS manual, which Sphinx builds.
const ARTICLE = `<div role="main" class="document">
<section id="vector-geometry"><h1>Vector geometry</h1>
<section id="buffer">
<span id="qgisbuffer"></span><span id="index-0"></span><h2>Buffer</h2>
<p>Computes a buffer area.</p>
<section id="parameters"><h3>Parameters</h3><table><tr><td><code>INPUT</code></td></tr></table></section>
<p><strong>Algorithm ID</strong>: <code>native:buffer</code></p>
</section>
<section id="centroids">
<span id="qgiscentroids"></span><h2>Centroids</h2>
<p>Creates centroids.<img src="c.png" id="figure"></p>
</section>
</section>
</div>`
const PAGE = `<html><body><nav><a href="#buffer">Buffer</a></nav>
${ARTICLE}
<footer>Next: Vector overlay</footer></body></html>`
const BUFFER = PAGE.slice(PAGE.indexOf('<section id="buffer">'), PAGE.indexOf('<section id="centroids">')).trimEnd()
const MANUAL = "https://docs.qgis.org/4.2/en/docs/user_manual/processing_algs/qgis/vectorgeometry.html"

const byId = (id: string) => (attributes: Record<string, string>) => attributes.id === id

describe("GeoCode: a page of the QGIS manual", () => {
  test("gives the block an id or any bookmark opening it names, nested sections and all", () => {
    expect(QgisManual.extract(PAGE, byId("buffer"))).toBe(BUFFER)
    expect(QgisManual.extract(PAGE, byId("qgisbuffer"))).toBe(BUFFER)
    // Guards against only the first of the bookmarks Sphinx puts at the head of a section being taken for it.
    expect(QgisManual.extract(PAGE, byId("index-0"))).toBe(BUFFER)
  })

  // Guards against taking a whole block for a bookmark inside it, or nothing for an element without content.
  test("gives nothing for a bookmark that does not open its block, and absent ids", () => {
    expect(QgisManual.extract(`<div><p>text</p><span id="mark"></span><p>more</p></div>`, byId("mark"))).toBeUndefined()
    expect(QgisManual.extract(PAGE, byId("figure"))).toBeUndefined()
    expect(QgisManual.extract(PAGE, byId("missing"))).toBeUndefined()
  })

  test("is cut down to its article, or to the section its fragment names, and says so when there is none", () => {
    expect(QgisManual.of(MANUAL, "text/html; charset=utf-8", PAGE)).toBe(ARTICLE)
    expect(QgisManual.of(`${MANUAL}#buffer`, "text/html", PAGE)).toBe(BUFFER)
    expect(QgisManual.of(`${MANUAL}#missing`, "text/html", PAGE)).toBe(
      `<p>This page has no section "#missing"; this is the whole page.</p>\n${ARTICLE}`,
    )
  })

  // Guards against webfetch changing any other site, or anything but HTML.
  test("leaves every other site and anything but HTML whole", () => {
    expect(QgisManual.of("https://docs.example/vectorgeometry.html#buffer", "text/html", PAGE)).toBe(PAGE)
    expect(QgisManual.of("https://qgis.org/vectorgeometry.html#buffer", "text/html", PAGE)).toBe(PAGE)
    expect(QgisManual.of(`${MANUAL}#buffer`, "text/plain", PAGE)).toBe(PAGE)
  })
})

const webFetchToolNode = makeLocationNode({
  name: "test/geocode-webfetch-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(WebFetchTool.Plugin)),
  deps: [Tool.node, Permission.node, LayerNodePlatform.httpClient],
})
const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }),
      ),
    ),
  ),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, webFetchToolNode]), [
    Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
    Image.node.replace(imagePassthrough),
    LayerNodePlatform.httpClient.replace(http),
  ]),
)

const fetchPage = (url: string, format: "markdown" | "text" | "html") =>
  Effect.gen(function* () {
    const result = yield* executeTool(yield* Tool.Service, {
      sessionID: Session.ID.make("ses_geocode_webfetch_test"),
      ...toolIdentity,
      call: { type: "tool-call" as const, id: "call-webfetch", name: "webfetch", input: { url, format } },
    })
    expect(result.status).toBe("completed")
    return (result.content ?? []).flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
  })

describe("GeoCode: webfetch", () => {
  // Guards against the manual being cut down in one format only, or another site being cut down at all.
  it.effect("hands on only the QGIS manual's section or article, in every format", () =>
    Effect.gen(function* () {
      const markdown = yield* fetchPage(`${MANUAL}#buffer`, "markdown")
      expect(markdown).toBe(WebFetchTool.convertHTMLToMarkdown(BUFFER))
      expect(markdown).toContain("native:buffer")
      expect(markdown).not.toContain("Centroids")
      expect(yield* fetchPage(`${MANUAL}#buffer`, "text")).toBe(WebFetchTool.extractTextFromHTML(BUFFER))
      expect(yield* fetchPage(`${MANUAL}#buffer`, "html")).toBe(BUFFER)
      expect(yield* fetchPage(MANUAL, "markdown")).toBe(WebFetchTool.convertHTMLToMarkdown(ARTICLE))
      expect(yield* fetchPage("https://docs.example/vectorgeometry.html#buffer", "markdown")).toBe(
        WebFetchTool.convertHTMLToMarkdown(PAGE),
      )
    }),
  )
})
