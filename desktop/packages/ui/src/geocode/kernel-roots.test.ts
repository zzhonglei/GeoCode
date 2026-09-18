/* --- GeoCode: the renderer's hand-copy of core/src/brand.ts, which this package cannot import, must not drift from
 * it, or the renderer looks for the agent's files where the kernel does not write them (docs/PATHS.md §5). --- */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';

import { KERNEL_DIR_NAME, KERNEL_PLANS_SEGMENTS, KERNEL_PROJECT_DIR } from './kernel-roots';

const BRAND_SOURCE = new URL('../../../../../kernel/packages/core/src/brand.ts', import.meta.url).pathname;
const brandSource = fs.readFileSync(BRAND_SOURCE, 'utf8');

/** Renderer files that name the kernel's directories. */
const PATCHED = [
  '../components/views/PlanView.tsx',
  '../lib/openCodeStatus.ts',
];

/** Renderer files that name the kernel's config file, as text inside a sentence. */
const CONFIG_FILE_NAMED = [
  '../components/sections/mcp/McpPage.tsx',
  '../components/sections/mcp/McpSidebar.tsx',
];

const readRenderer = (file: string) => fs.readFileSync(new URL(file, import.meta.url).pathname, 'utf8');

describe('kernel roots', () => {
  test('the project directory is the one brand.ts derives', () => {
    const name = brandSource.match(/const name = "([^"]+)"/)?.[1];
    expect(name).toBeTruthy();
    expect(KERNEL_PROJECT_DIR).toBe(`.${name}`);
  });

  test('the directory under each XDG root is the one brand.ts names', () => {
    const dirName = brandSource.match(/const dirName = "([^"]+)"/)?.[1];
    expect(dirName).toBeTruthy();
    expect(KERNEL_DIR_NAME).toBe(dirName);
  });

  test('plans still hang off the project directory on the kernel side', () => {
    expect(brandSource).toContain('plansSegments: [projectDir, "plans"]');
    expect(KERNEL_PLANS_SEGMENTS).toEqual([KERNEL_PROJECT_DIR, 'plans']);
  });

  test('names GeoCode, and no longer names OpenCode', () => {
    expect(KERNEL_PROJECT_DIR).toBe('.geocode');
    expect(KERNEL_PLANS_SEGMENTS.join('/')).toBe('.geocode/plans');
    expect(KERNEL_DIR_NAME).toBe('GeoCode');
  });

  test('the renderer files that compose these paths use the constants', () => {
    // A caller that goes back to a literal would conflict with nothing and fail nothing else.
    for (const file of PATCHED) {
      const source = readRenderer(file);
      expect([file, source.includes('geocode/kernel-roots')]).toEqual([file, true]);
      // As a path, not as a property access such as `config.opencode`.
      for (const upstream of [/(?<![\w)\]])\.opencode\b/, /share\/opencode\b/, /\bopencode\/log\b/]) {
        expect([file, String(upstream), upstream.test(source)]).toEqual([file, String(upstream), false]);
      }
    }
  });

  test('the MCP delete dialogs name the config file brand.ts derives', () => {
    const name = brandSource.match(/const name = "([^"]+)"/)?.[1];
    expect(brandSource).toContain('configJson: `${name}.json`');
    for (const file of CONFIG_FILE_NAMED) {
      const source = readRenderer(file);
      expect([file, source.includes(`<code className="text-foreground">${name}.json</code>`)]).toEqual([file, true]);
      expect([file, source.includes('opencode.json')]).toEqual([file, false]);
    }
  });
});
