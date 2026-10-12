import { afterEach, describe, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { Window } from 'happy-dom';
import { pathToFileURL } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { getPermissionToolPresentation } from '@/components/chat/permissionToolPresentation';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import type { Metadata, SyntheticMessage, ToolPart, ToolState } from '@/lib/opencode/model';
import { getDefaultTheme } from '@/lib/theme/themes';
import { applyDirectoryEvent } from '@/sync/event-reducer';
import { INITIAL_STATE } from '@/sync/types';
import type { PermissionRequest } from '@/types/permission';

import { firstShown, geeRunNotice, geeRunView, nextShown, rowStatus, STATUS_MS } from './geeRun';

// As the upstream tests do: Bun does not implement Vite's worker asset-query imports, which the card's code reaches.
plugin({
  name: 'geerun-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const { geoPermissionContent } = await import('./geoPermission');
const { excerptOf } = await import('./geoTools');

const english = useI18nStore.getState().locale;
afterEach(() => useI18nStore.setState({ locale: english }));

const unexpected = (): never => {
  throw new Error('Rendering must not change the theme');
};
const theme = getDefaultTheme(false);
const themes: ThemeContextValue = {
  currentTheme: theme,
  availableThemes: [theme],
  setTheme: unexpected,
  customThemesLoading: false,
  reloadCustomThemes: unexpected,
  importTheme: unexpected,
  deleteImportedTheme: unexpected,
  customThemeIds: [],
  isSystemPreference: false,
  setSystemPreference: unexpected,
  themeMode: 'light',
  setThemeMode: unexpected,
  lightThemeId: theme.metadata.id,
  darkThemeId: getDefaultTheme(true).metadata.id,
  setLightThemePreference: unexpected,
  setDarkThemePreference: unexpected,
};

const asking = (metadata: PermissionRequest['metadata']): PermissionRequest => ({
  id: 'per_geerun',
  sessionID: 'ses_geerun',
  action: 'geerun',
  resources: ['*'],
  metadata,
});

/**
 * The text a card shows, rendered in a DOM as upstream's tests render tool rows: the highlighter paints its code in a
 * layout effect, which a server render never runs.
 */
const shown = async (permission: PermissionRequest) => {
  const window = new Window({ url: 'http://localhost' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ThemeSystemContext.Provider value={themes}>
          <I18nProvider>{geoPermissionContent(permission)}</I18nProvider>
        </ThemeSystemContext.Provider>,
      ),
    );
    return container.textContent;
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await window.happyDOM.close();
  }
};

const SCRIPT = [
  '',
  '  ',
  'aoi = ee.FeatureCollection("projects/p/assets/county")',
  'images = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterBounds(aoi)',
  'images = images.filterDate("2024-06-01", "2024-09-01")',
  'print(images.size().getInfo())',
  'composite = images.median()',
  'print(composite.bandNames().getInfo())',
  '',
].join('\r\n');

describe('GeoCode: geerun in the interface', () => {
  test('asks under the Earth Engine logo, to run a script', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    const tool = getPermissionToolPresentation(asking({}));
    expect(tool.name).toBe('请求执行 Earth Engine 脚本');
    expect(renderToStaticMarkup(<>{tool.icon}</>)).toContain('gee-logo');
  });

  // Guards against a long script taking over the card: only its first lines show, and the rest is counted.
  test('shows a script by its first lines, past blank ones, and counts the rest', () => {
    expect(excerptOf(SCRIPT)).toEqual({
      shown: [
        'aoi = ee.FeatureCollection("projects/p/assets/county")',
        'images = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterBounds(aoi)',
        'images = images.filterDate("2024-06-01", "2024-09-01")',
        'print(images.size().getInfo())',
      ].join('\n'),
      rest: 2,
    });
    expect(excerptOf('print(1)\n')).toEqual({ shown: 'print(1)', rest: 0 });
  });

  test('a card says why, then the first lines of the script and how many are left out, or the file it runs', async () => {
    useI18nStore.setState({ locale: 'en' });
    expect(await shown(asking({ description: '统计夏季影像', script: SCRIPT }))).toBe(
      [
        'Reason: 统计夏季影像aoi = ee.FeatureCollection("projects/p/assets/county")',
        'images = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterBounds(aoi)',
        'images = images.filterDate("2024-06-01", "2024-09-01")',
        'print(images.size().getInfo())… 2 more lines',
      ].join('\n'),
    );
    expect(await shown(asking({ script: 'print(1)' }))).toBe('print(1)');
    expect(await shown(asking({ description: '批量统计', script: ' \n' }))).toBe('Reason: 批量统计');
    expect(await shown(asking({ description: '批量统计', path: '/data/scripts/ndvi.py' }))).toBe(
      'Reason: 批量统计Script file/data/scripts/ndvi.py',
    );
  });
});

const call = (state: ToolState): ToolPart => ({
  id: 'call_gee',
  sessionID: 'ses_1',
  messageID: 'msg_a',
  type: 'tool',
  callID: 'call_gee',
  tool: 'geerun',
  state,
});

const INPUT = { description: '下载台北真彩色影像', task: 'taipei-rgb-20261012', script: 'print(1)' };

/** The kernel's answer to a call whose run went on in the background. */
const backgrounded = (metadata: Metadata = {}) =>
  call({
    status: 'completed',
    input: INPUT,
    output: 'Task taipei-rgb-20261012 is running in the background.',
    metadata: { started: 1000, statuses: [], log: '', status: 'running', ...metadata },
    time: { start: 900, end: 1500 },
  });

/** As the kernel's `notification` puts the end of a run in the background into the conversation. */
const notice = (metadata: Metadata, text: string): SyntheticMessage => ({
  id: 'msg_notice',
  sessionID: 'ses_1',
  role: 'synthetic',
  time: { created: 9000 },
  text: `<geerun task="taipei-rgb-20261012" state="${String(metadata.state)}" description="NDVI > 0.3">\n${text}\n</geerun>`,
  metadata: { source: 'geerun', callID: 'call_gee', ...metadata },
});

describe("GeoCode: geerun's row", () => {
  // Guards against statuses that come and go within a moment never being read, a share done queueing up, and a burst
  // of statuses leaving the row far behind the run.
  test('shows each status long enough, shorter when many wait their turn, and updates a share done in place', () => {
    const told = [
      { seq: 1, text: 'Loading composite' },
      { seq: 2, text: null },
      { seq: 3, text: 'Downloading rgb.tif', progress: 0 },
      { seq: 4, text: 'Downloading rgb.tif', progress: 0.4 },
    ];
    let row = nextShown(firstShown([], 0), told, 0);
    expect(row.current).toEqual({ text: 'Loading composite', progress: undefined });
    row = nextShown(row, told, STATUS_MS - 1);
    expect(row.current?.text).toBe('Loading composite');
    row = nextShown(row, told, STATUS_MS);
    expect(row.current).toEqual({ text: 'Downloading rgb.tif', progress: 0.4 });
    row = nextShown(row, [...told, { seq: 5, text: 'Downloading rgb.tif', progress: 0.9 }], STATUS_MS + 10);
    expect([row.current?.progress, row.queue]).toEqual([0.9, []]);
    // No function doing anything any more: the last status stays a while after, for a wait to take over, then goes;
    // however long it was row before.
    row = nextShown(row, [{ seq: 6, text: null }], 60000);
    expect(nextShown(row, [], 61400).current?.text).toBe('Downloading rgb.tif');
    expect(nextShown(row, [], 61500).current).toBeUndefined();

    // Thirty assets loaded at once: each row in turn, all within seconds rather than 30 × 0.8 s.
    const burst = Array.from({ length: 30 }, (_, index) => ({ seq: index + 1, text: `Loading a${index}` }));
    let at = 0;
    let rushed = nextShown(firstShown([], 0), burst, 0);
    const seen = new Set([rushed.current?.text]);
    while (rushed.queue.length) {
      rushed = nextShown(rushed, burst, (at += 100));
      seen.add(rushed.current?.text);
    }
    expect([seen.size, at < 10000]).toEqual([30, true]);

    // A row opened mid-run starts at the latest status, replaying none before it.
    expect(firstShown(told, 0).current).toEqual({ text: 'Downloading rgb.tif', progress: 0.4 });
  });

  // Guards against a row saying the run starts while the user is still asked, a share that never moved showing as 0%,
  // and a wait shown over a status not yet read.
  test('says the run starts once allowed, the share done once some is done, and a wait over a status read', () => {
    const begun = { start: 0, begun: true };
    const loading = nextShown(firstShown([], 0), [{ seq: 1, text: 'Loading composite', progress: 0.004 }], 0);
    expect(rowStatus(loading, 0, { begun: false }).doing).toBeUndefined();
    expect(rowStatus(loading, 0, { start: 0, begun: false }).doing).toBe('Starting the script');
    expect(rowStatus(loading, 0, begun)).toEqual({ doing: 'Loading composite', percent: undefined });
    const ended = nextShown(loading, [{ seq: 2, text: null }], 100);
    expect(rowStatus(ended, 100, { ...begun, waitingSince: 0 }).doing).toBe('Loading composite');
    expect(rowStatus(ended, STATUS_MS, { ...begun, waitingSince: 0 }).doing).toBe('Waiting for Earth Engine');
    const exporting = nextShown(ended, [{ seq: 3, text: 'Exporting a', progress: 0.42 }], 900);
    expect(rowStatus(exporting, 900, { ...begun, waitingSince: 0 })).toEqual({ doing: 'Exporting a', percent: 42 });
  });

  // Guards against Python's error report reading as ordinary output, and the end of a run going unsaid.
  test("says how a run ended, with Python's error report in red", () => {
    const log = 'Region taipei.shp: EPSG:3826.\nTraceback (most recent call last):\n  File "<script>", line 6\n';
    const failed = geeRunView(
      call({
        status: 'completed',
        input: INPUT,
        output: `Task taipei-rgb-20261012: nothing saved yet.\n\n${log}\nThe script failed after 9 s.`,
        metadata: { started: 1000, statuses: [], log, outcome: 'failed' },
        time: { start: 900, end: 10000 },
      }),
      undefined,
      'zh-CN',
    );
    expect(failed).toMatchObject({ running: false, bad: true, start: 1000, end: 10000 });
    expect(failed.lines.map((line) => [line.text, line.tone])).toEqual([
      ['Region taipei.shp: EPSG:3826.', 'plain'],
      ['Traceback (most recent call last):', 'error'],
      ['  File "<script>", line 6', 'error'],
      ['The script failed after 9 s.', 'error'],
    ]);
  });

  // Guards against a row left running by its answer never ending, ending on another call's notice, or ending otherwise
  // than its notice says; the notices are as the kernel words them.
  test('a run in the background runs until the notice of its end, and ends as the notice says', () => {
    expect(geeRunView(backgrounded(), undefined, 'en')).toMatchObject({ running: true, bad: false, end: undefined });

    const done = notice(
      { state: 'completed', outcome: 'finished', started: 1000, ended: 8000, log: 'images: 73\n' },
      'Task taipei-rgb-20261012: 1 asset.\n\nimages: 73\n\nFinished in 7 s.',
    );
    expect(geeRunNotice([{ ...done, metadata: { ...done.metadata, callID: 'call_other' } }], 'call_gee')).toBeUndefined();
    expect(geeRunNotice([done], 'call_gee')).toBe(done);
    const finished = geeRunView(backgrounded(), done, 'en');
    expect(finished).toMatchObject({ running: false, bad: false, start: 1000, end: 8000 });
    expect(finished.lines.map((line) => line.text)).toEqual(['images: 73', 'Finished in 7 s.']);

    const failed = notice({ state: 'error', started: 1000, log: 'half\n' }, 'GeoEngine stopped.\nRestart GeoCode.');
    expect(geeRunView(backgrounded(), failed, 'en')).toMatchObject({
      running: false,
      bad: true,
      end: 9000,
      lines: [
        { text: 'half', tone: 'plain' },
        { text: 'GeoEngine stopped.', tone: 'error', icon: true },
        { text: 'Restart GeoCode.', tone: 'error', icon: false },
      ],
    });
  });

  // Guards against the kernel's progress for a run in the background being dropped, or reopening other calls.
  test("the conversation takes a background run's progress onto its answered call, and no other call's", () => {
    const progress = (metadata: Metadata) => ({
      type: 'message.tool.transition' as const,
      properties: { sessionID: 'ses_1', messageID: 'msg_a', partID: 'call_gee', transition: { kind: 'progress' as const, metadata } },
    });
    const draft = { ...INITIAL_STATE, part: { msg_a: [backgrounded()] } };
    expect(applyDirectoryEvent(draft, progress({ status: 'running', log: 'images: 73\n' }))).not.toBe(false);
    expect(draft.part.msg_a[0]).toMatchObject({ state: { status: 'completed', metadata: { log: 'images: 73\n' } } });
    // Progress the call gave before it was answered, not on the bus.
    expect(applyDirectoryEvent(draft, progress({ log: '' }))).toBe(false);

    const answered = { ...INITIAL_STATE, part: { msg_a: [backgrounded({ status: null })] } };
    expect(applyDirectoryEvent(answered, progress({ status: 'running' }))).toBe(false);
  });
});
