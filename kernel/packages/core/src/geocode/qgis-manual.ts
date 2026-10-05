export * as QgisManual from "./qgis-manual.js"

import { Parser } from "htmlparser2"

const HOST = "docs.qgis.org"

/**
 * An open element; `empty` while it holds nothing but whitespace and empty elements, and `first` when its parent was
 * still empty as it opened. Sphinx opens a section with a run of empty bookmarks, each of which stands for it.
 */
type Frame = { readonly start: number; readonly first: boolean; empty: boolean }

/**
 * The first element whose attributes match, or, for an empty bookmark that opens a block (Sphinx's
 * `<section><span id="…"></span>`), that block. Undefined when nothing matches.
 */
export function extract(html: string, matches: (attributes: Record<string, string>) => boolean) {
  const stack: Frame[] = []
  let start: number | undefined
  let end: number | undefined
  // The matching element, until it closes.
  let target: Frame | undefined
  // The block a bookmark opens, which ends where it closes.
  let enclosing: Frame | undefined
  const parser = new Parser({
    onopentag(_name, attributes) {
      const parent = stack.at(-1)
      const frame = { start: parser.startIndex, first: parent?.empty ?? false, empty: true }
      stack.push(frame)
      if (start !== undefined || !matches(attributes)) return
      start = frame.start
      target = frame
    },
    ontext(text) {
      const parent = stack.at(-1)
      if (parent && text.trim()) parent.empty = false
    },
    onclosetag() {
      const frame = stack.pop()
      if (!frame) return
      const parent = stack.at(-1)
      if (parent && !frame.empty) parent.empty = false
      if (end !== undefined) return
      if (frame === enclosing) end = parser.endIndex + 1
      if (frame !== target) return
      target = undefined
      if (!frame.empty) {
        end = parser.endIndex + 1
        return
      }
      // A bookmark further into a block marks a place in it, not the block.
      if (!parent || !frame.first) {
        start = undefined
        return
      }
      start = parent.start
      enclosing = parent
    },
  })
  parser.end(html)
  if (start === undefined) return undefined
  return html.slice(start, end ?? html.length)
}

/**
 * A page of the QGIS manual as webfetch should hand it on: the section its URL's fragment names, or else the page's
 * article without the site's navigation, said so when the fragment names nothing. Any other page is left whole.
 */
export function of(url: string, contentType: string, html: string) {
  const parsed = new URL(url)
  if (parsed.hostname !== HOST || !contentType.includes("text/html")) return html
  // The manual's ids are ASCII slugs, so the fragment is matched as written.
  const anchor = parsed.hash.slice(1)
  const section = anchor ? extract(html, (attributes) => attributes.id === anchor) : undefined
  if (section !== undefined) return section
  const article = extract(html, (attributes) => attributes.role === "main") ?? html
  return anchor ? `<p>This page has no section "#${anchor}"; this is the whole page.</p>\n${article}` : article
}
