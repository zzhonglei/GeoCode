import React from 'react';
import { z } from 'zod';

import { useI18nStore, type Locale } from '@/lib/i18n';

import { readGeoFeatures, readGeoGrid, type GeoGrid, type PageRefusal } from '../preview/previewClient';
import { previewText } from '../preview/previewText';

/**
 * Maps in the pages an agent shows with geocode_render: a page that names `maplibregl`, `geocode.vector` or
 * `geocode.raster` gets MapLibre and those two before its own scripts (pageMapKit.ts), and the chat reads the data the
 * page asks for through the preview's routes, which the page, sandboxed, cannot reach.
 */

const USES_MAP = /\bmaplibregl\b|\bgeocode\.(?:vector|raster)\b/;

/** The titles of the line a map page shows what went wrong in, by where it went wrong. */
type KitText = { data: string; map: string; script: string };

const TEXT: { en: KitText } & Partial<Record<Locale, KitText>> = {
  en: { data: 'Map data could not be read', map: 'The map could not be drawn', script: "The page's script failed" },
  'zh-CN': { data: '地图数据读取失败', map: '地图绘制出错', script: '页面脚本出错' },
  'zh-TW': { data: '地圖資料讀取失敗', map: '地圖繪製出錯', script: '頁面腳本出錯' },
};

// The kit once loaded; null once it could not be, when a page is drawn as it is: its own scripts then say what failed,
// rather than the page waiting for good.
let loadedKit: string | null | undefined;

/** The page with the map kit before its scripts; null while the kit loads. A page without a map is left as it is. */
export function useGeoPageHtml(html: string | null): string | null {
  const wanted = html !== null && USES_MAP.test(html);
  const locale = useI18nStore((state) => state.locale);
  const [kit, setKit] = React.useState(loadedKit);
  React.useEffect(() => {
    if (!wanted || kit !== undefined) return;
    let live = true;
    void import('./pageMapKit')
      .then((module) => module.pageMapKit())
      .catch(() => null)
      .then((made) => {
        loadedKit = made;
        if (live) setKit(made);
      });
    return () => {
      live = false;
    };
  }, [kit, wanted]);
  const injected = React.useMemo(() => {
    if (html === null || kit === undefined) return null;
    if (kit === null) return html;
    // As JSON a script can hold: no `<`, which could close it.
    const text = JSON.stringify(TEXT[locale] ?? TEXT.en).replaceAll('<', '\\u003c');
    return withKit(html, `<script>self.geocodeKitText=${text}</script>${kit}`);
  }, [html, kit, locale]);
  if (!wanted) return html;
  return injected;
}

/**
 * As buildHtmlRenderDocument in components/chat/message/parts/htmlRender.ts places its own scripts: first in the
 * head, which a page without one is given, with the doctype that function gives a bare page. Unlike it, this does not
 * look past comments and scripts, so a `<head>` written in one before the real head would take the kit.
 */
const withKit = (html: string, kit: string): string => {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + kit + html.slice(head.index + head[0].length);
  const root = /<html(?:\s[^>]*)?>/i.exec(html) ?? /^\s*<!doctype[^>]*>/i.exec(html);
  if (root) return `${html.slice(0, root.index + root[0].length)}<head>${kit}</head>${html.slice(root.index + root[0].length)}`;
  return `<!doctype html><head>${kit}</head>${html}`;
};

const target = { id: z.number(), path: z.string(), layer: z.string().optional() };
const geoRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('geocode/vector'), ...target, fields: z.array(z.string()) }),
  z.object({ type: z.literal('geocode/raster'), ...target, bands: z.array(z.number().int()) }),
]);

/** What a page's read failed for, in the words its line shows. */
type Refused = { error: string };

type Answer = { bytes: ArrayBuffer; grid?: GeoGrid } | Refused;

/** As much of a page's frame as answering it takes: what the page is, and the window it is answered in. */
export type PageFrame = { readonly srcdoc: string; readonly contentWindow: Pick<Window, 'postMessage'> | null };

/**
 * A refusal as the user reads it in the page: in the preview's words where it has some for the code, with the reader's
 * own beside them when they say more. Those of the page's own reads (which layer, field or band) stay as they are.
 */
const refused = (refusal: PageRefusal): Refused => {
  const worded = refusal.code ? previewText(useI18nStore.getState().locale).unshown[refusal.code] : undefined;
  if (!worded) return { error: refusal.message };
  return { error: refusal.message === refusal.code ? worded : `${worded} (${refusal.message})` };
};

/**
 * Answers a page's `geocode.vector` and `geocode.raster`, true when the message was one. The page reads only data it
 * names in full: the path must stand in its document, as a local image must, so a page cannot read any file it builds
 * a path to.
 */
export const answerGeoPage = (event: MessageEvent, frame: PageFrame): boolean => {
  const asked = geoRequest.safeParse(event.data);
  if (!asked.success) return false;
  const request = asked.data;
  const { id, path, layer } = request;
  const reply = (answer: Answer) =>
    frame.contentWindow?.postMessage({ type: 'geocode/result', id, ...answer }, '*', 'bytes' in answer ? [answer.bytes] : []);
  // A Windows path in a script string has its backslashes doubled.
  const named = [path, path.replaceAll('\\', '\\\\'), path.replaceAll('\\', '/')].some((written) => frame.srcdoc.includes(written));
  if (!named) {
    reply({ error: `${path} is not written in full in the page` });
    return true;
  }
  const answer: Promise<Answer> =
    request.type === 'geocode/vector'
      ? readGeoFeatures({ path, layer }, request.fields).then((read) => (read.ok ? { bytes: read.body } : refused(read)))
      : readGeoGrid({ path, layer }, request.bands).then((read) => (read.ok ? { bytes: read.bytes, grid: read.grid } : refused(read)));
  // Every request is answered: a page left waiting would show neither its map nor what went wrong.
  void answer.catch(() => ({ error: 'the data could not be read' })).then(reply);
  return true;
};
