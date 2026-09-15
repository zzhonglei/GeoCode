/* --- GeoCode: the renderer reads the agent's files from the directory the agent writes them to.
 *
 * `PlanView` looked for `<project>/.opencode/plans/<id>.md` while the kernel wrote
 * `<worktree>/.geocode/plans/<id>.md`, so the panel found nothing and reported no plan — a
 * broken feature rather than a leak, and invisible to any test that did not open the panel.
 *
 * brand.ts is read as text rather than imported: the kernel is a separate install root and this
 * package cannot depend on it. That makes these constants a hand-copy, which is exactly the case
 * CONVENTIONS.md §5 says a tripwire is for — nothing conflicts and nothing fails when a copy
 * drifts from its original. --- */
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
    // Reading the shape, not just the name: if the kernel ever moves plans out from under the
    // project directory, this copy is wrong in a way the name check alone would not show.
    expect(brandSource).toContain('plansSegments: [projectDir, "plans"]');
    expect(KERNEL_PLANS_SEGMENTS).toEqual([KERNEL_PROJECT_DIR, 'plans']);
  });

  test('names GeoCode, and no longer names OpenCode', () => {
    expect(KERNEL_PROJECT_DIR).toBe('.geocode');
    expect(KERNEL_PLANS_SEGMENTS.join('/')).toBe('.geocode/plans');
    expect(KERNEL_DIR_NAME).toBe('GeoCode');
  });

  test('the renderer files that compose these paths use the constants', () => {
    // Asserted over the source because the constants above cannot see a caller that stops using
    // them. This is the same shape `server/shell-data-root.test.js` uses, and for the same
    // reason: a reintroduced literal conflicts with nothing and fails nothing.
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
