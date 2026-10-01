import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AppStartupOverlay } from '@/components/ui/AppStartupOverlay';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { I18nProvider } from '@/lib/i18n';

// The loading mark is written out in three files that nothing links, so a change to one has to reach the others.
const packages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (file: string) => readFileSync(path.join(packages, file), 'utf8');

const literal = (text: string, name: string) => new RegExp(`const ${name} = \`([\\s\\S]*?)\``).exec(text)?.[1] ?? '';
const marks = (text: string) => text.match(/<svg\b[^>]*data-geocode-mark[^>]*>[\s\S]*?<\/svg>/g) ?? [];
const body = (mark: string) => mark.replace(/^<svg\b[^>]*>/, '').replace(/<\/svg>$/, '');
const clock = (text: string) =>
  ((text.match(/<script>[\s\S]*?<\/script>/g) ?? []).find((block) => block.includes('data-geocode-mark')) ?? '').replace(/\s+/g, ' ').trim();
const withoutTemplates = (text: string) => text.replace(/<template>[\s\S]*?<\/template>/g, '');
const orbitColours = (text: string) => [...new Set(text.match(/#(?:5A6874|A8B5C1)/gi) ?? [])].map((c) => c.toUpperCase()).sort();
const size = (html: string) => /<svg\b[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/.exec(html)?.slice(1, 3);

const CUBE = 'L8.432 26';

const render = (element: React.ReactElement) => renderToStaticMarkup(<I18nProvider>{element}</I18nProvider>);

describe('GeoCode: the loading mark', () => {
  const module = read('electron/geocode/loading-mark.mjs');
  const page = read('web/index.html');
  const component = read('ui/src/geocode/BrandMark.tsx');

  test('is one artwork in the first window, the page and the component', () => {
    const fromModule = marks(literal(module, 'LOADING_MARK'));
    const fromPage = marks(page);
    expect([fromModule.length, fromPage.length]).toEqual([1, 1]);
    const [pageMark = ''] = fromPage;
    expect(fromModule).toEqual([pageMark]);
    expect(body(pageMark).length).toBeGreaterThan(0);
    expect(literal(component, 'MOVING_BODY')).toBe(body(pageMark));
  });

  test('is set to the wall clock the same way in all three', () => {
    const fromModule = clock(literal(module, 'LOADING_MARK_CLOCK'));
    expect(fromModule).toContain('setCurrentTime((Date.now() / 1000) % period)');
    expect(fromModule).toContain("addEventListener('load'");
    expect(clock(page)).toBe(fromModule);
    expect(component).toContain('setCurrentTime((Date.now() / 1000) % period)');
  });

  test('replaces the cube in both splashes', () => {
    const cube = (text: string) => [text.includes(CUBE), withoutTemplates(text).includes(CUBE)];
    const firstWindow = withoutTemplates(read('electron/early-startup.mjs'));
    expect(cube(read('electron/early-startup.mjs'))).toEqual([true, false]);
    expect(['${LOADING_MARK}', '${LOADING_MARK_STYLE}', '${LOADING_MARK_CLOCK}'].map((part) => firstWindow.includes(part))).toEqual([true, true, true]);
    expect(cube(page)).toEqual([true, false]);
  });

  test('takes the same pair of orbit colours in all three', () => {
    expect(orbitColours(module)).toEqual(['#5A6874', '#A8B5C1']);
    expect(orbitColours(page)).toEqual(orbitColours(module));
    expect(orbitColours(component)).toEqual(orbitColours(module));
  });

  // A startup overlay of another size would make the mark jump when the interface takes over from the page.
  test('keeps its size when the interface takes over', () => {
    const [pageMark = ''] = marks(page);
    expect(size(render(<AppStartupOverlay ready={false} />))).toEqual(size(pageMark));
    expect(size(pageMark)?.length).toBe(2);
  });
});

describe('GeoCode: the logo component', () => {
  test('draws the mark, still by default', () => {
    const html = render(<OpenChamberLogo />);
    expect(html).toContain('var(--geocode-orbit');
    expect(html).not.toContain('animateMotion');
    expect(html).not.toContain('8.432');
  });

  test('draws the moving mark on startup screens', () => {
    expect(render(<OpenChamberLogo variant="splash" />)).toContain('animateMotion');
    expect(render(<OpenChamberLogo isAnimated />)).toContain('animateMotion');
  });
});
