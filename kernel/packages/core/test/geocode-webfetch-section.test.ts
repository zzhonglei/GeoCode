import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { WebFetchSection } from "@opencode/core/geocode/webfetch-section"
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
const SPHINX = `<html><body><nav><a href="#buffer">Buffer</a></nav>
<section id="vector-geometry"><h1>Vector geometry</h1>
<section id="buffer">
<span id="qgisbuffer"></span><h2>Buffer</h2>
<p>Computes a buffer area.</p>
<section id="parameters"><h3>Parameters</h3><table><tr><td><code>INPUT</code></td></tr></table></section>
<p><strong>Algorithm ID</strong>: <code>native:buffer</code></p>
</section>
<section id="centroids">
<span id="qgiscentroids"></span><h2>Centroids</h2>
<p>Creates centroids.<img src="c.png" id="figure"></p>
</section>
</section></body></html>`

const BUFFER = SPHINX.slice(
  SPHINX.indexOf('<section id="buffer">'),
  SPHINX.indexOf('<section id="centroids">'),
).trimEnd()

describe("GeoCode: the section a #fragment names", () => {
  test("is the block an id or the bookmark opening it names, nested sections and all", () => {
    expect(WebFetchSection.extract(SPHINX, "buffer")).toBe(BUFFER)
    expect(WebFetchSection.extract(SPHINX, "qgisbuffer")).toBe(BUFFER)
  })

  test("runs from a heading to the next heading at its level or above", () => {
    const html = `<h2 id="a">A</h2><p>one</p><h3>A.1</h3><p>two</p><h2>B</h2><p>three</p>`
    expect(WebFetchSection.extract(html, "a")).toBe(`<h2 id="a">A</h2><p>one</p><h3>A.1</h3><p>two</p>`)
    expect(WebFetchSection.extract(`<h2><a id="b"></a>B</h2><p>b</p><h1>C</h1>`, "b")).toBe(
      `<h2><a id="b"></a>B</h2><p>b</p>`,
    )
  })

  // Guards against taking a whole block for a bookmark inside it, or nothing for an element without content.
  test("is undefined for a bookmark that does not open its block, and absent ids", () => {
    expect(WebFetchSection.extract(`<div><p>text</p><span id="mark"></span><p>more</p></div>`, "mark")).toBeUndefined()
    expect(WebFetchSection.extract(SPHINX, "figure")).toBeUndefined()
    expect(WebFetchSection.extract(SPHINX, "missing")).toBeUndefined()
  })

  test("leaves a page whole without a fragment or HTML, and says so when the fragment names nothing", () => {
    expect(WebFetchSection.of("https://docs.example/page.html", "text/html", SPHINX)).toBe(SPHINX)
    expect(WebFetchSection.of("https://docs.example/page.txt#buffer", "text/plain", SPHINX)).toBe(SPHINX)
    expect(
      WebFetchSection.of("https://docs.example/page.html#Joined%20name", "text/html", `<p id="Joined name">x</p>`),
    ).toBe(`<p id="Joined name">x</p>`)
    expect(WebFetchSection.of("https://docs.example/page.html#missing", "text/html", SPHINX)).toBe(
      `<p>This page has no section "#missing"; this is the whole page.</p>\n${SPHINX}`,
    )
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
        new Response(SPHINX, { headers: { "content-type": "text/html; charset=utf-8" } }),
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
  // Guards against the section being cut from one format only, or a page without a fragment being changed.
  it.effect("returns only the section a #fragment names, in every format", () =>
    Effect.gen(function* () {
      const markdown = yield* fetchPage("https://docs.example/vectorgeometry.html#buffer", "markdown")
      expect(markdown).toBe(WebFetchTool.convertHTMLToMarkdown(BUFFER))
      expect(markdown).toContain("native:buffer")
      expect(markdown).not.toContain("Centroids")
      expect(yield* fetchPage("https://docs.example/vectorgeometry.html#buffer", "text")).toBe(
        WebFetchTool.extractTextFromHTML(BUFFER),
      )
      expect(yield* fetchPage("https://docs.example/vectorgeometry.html#buffer", "html")).toBe(BUFFER)
      expect(yield* fetchPage("https://docs.example/vectorgeometry.html", "markdown")).toBe(
        WebFetchTool.convertHTMLToMarkdown(SPHINX),
      )
    }),
  )
})
