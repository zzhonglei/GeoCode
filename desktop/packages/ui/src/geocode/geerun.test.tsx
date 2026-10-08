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
import { getDefaultTheme } from '@/lib/theme/themes';
import type { PermissionRequest } from '@/types/permission';

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
