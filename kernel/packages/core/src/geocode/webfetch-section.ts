export * as WebFetchSection from "./webfetch-section.js"

import { Parser } from "htmlparser2"

const HEADING = /^h([1-6])$/

/** An open element; `first` when nothing but whitespace precedes it in its parent. */
type Frame = { readonly name: string; readonly start: number; readonly first: boolean; empty: boolean }

const headingLevel = (name: string) => {
  const match = HEADING.exec(name)
  return match ? Number(match[1]) : undefined
}

/**
 * The part of an HTML page that a `#fragment` names: a heading up to the next heading at its level or above, the
 * element carrying the id, or, for an empty bookmark that opens a block (Sphinx's `<section><span id="…"></span>`),
 * that block. Undefined when nothing carries the id.
 */
export function extract(html: string, anchor: string) {
  const stack: Frame[] = []
  let start: number | undefined
  let end: number | undefined
  // Set while the section is a heading's, which the next heading at this level or above ends.
  let level: number | undefined
  // The element carrying the id, until it closes.
  let target: Frame | undefined
  // The block a bookmark opens, which ends where it closes.
  let enclosing: Frame | undefined
  const parser = new Parser({
    onopentag(name, attributes) {
      const parent = stack.at(-1)
      const frame = { name, start: parser.startIndex, first: parent?.empty ?? false, empty: true }
      if (parent) parent.empty = false
      const heading = headingLevel(name)
      if (level !== undefined && end === undefined && heading !== undefined && heading <= level) end = frame.start
      stack.push(frame)
      if (start !== undefined || attributes.id !== anchor) return
      start = frame.start
      level = heading
      target = heading === undefined ? frame : undefined
    },
    ontext(text) {
      const parent = stack.at(-1)
      if (parent && text.trim()) parent.empty = false
    },
    onclosetag() {
      const frame = stack.pop()
      if (!frame || end !== undefined) return
      if (frame === enclosing) end = parser.endIndex + 1
      if (frame !== target) return
      target = undefined
      if (!frame.empty) {
        end = parser.endIndex + 1
        return
      }
      const parent = stack.at(-1)
      // A bookmark further into a block marks a place in it, not the block.
      if (!parent || !frame.first) {
        start = undefined
        return
      }
      start = parent.start
      level = headingLevel(parent.name)
      enclosing = level === undefined ? parent : undefined
    },
  })
  parser.end(html)
  if (start === undefined) return undefined
  return html.slice(start, end ?? html.length)
}

/** A page's HTML cut down to the section its URL's fragment names, or the whole page, said so, when there is none. */
export function of(url: string, contentType: string, html: string) {
  if (!contentType.includes("text/html")) return html
  const anchor = fragment(url)
  if (!anchor) return html
  return extract(html, anchor) ?? `<p>This page has no section "#${anchor}"; this is the whole page.</p>\n${html}`
}

function fragment(url: string) {
  const hash = new URL(url).hash.slice(1)
  // A malformed escape is matched as written.
  try {
    return decodeURIComponent(hash)
  } catch {
    return hash
  }
}
