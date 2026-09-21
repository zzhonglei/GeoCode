/* --- GeoCode: upstream's one control tool is injected as two, and a tool the renderer has no metadata for
 * falls back to plain text, so its JSON answer loses highlighting (docs/DESKTOP.md §7.2). --- */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectToolOutputLanguage, getToolMetadata } from '@/lib/toolHelpers';

// Read out of the module that injects them rather than listed here, so renaming a tool moves this with
// it. Imported as text because the renderer's tsc has no declarations for the shell's `.mjs`.
const INJECTOR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../electron/geocode/browser-tool.mjs',
);
const nameOf = (constant: string, source: string): string | null =>
  new RegExp(`export const ${constant} = '([^']+)'`).exec(source)?.[1] ?? null;

const source = readFileSync(INJECTOR, 'utf8');
const INJECTED = ['BROWSER_TOOL_NAME', 'GEOCODE_TOOL_NAME'].map((constant) => nameOf(constant, source));

describe('the tools GeoCode injects', () => {
  test('both names are still found in the module that injects them', () => {
    expect(INJECTED.every((name) => typeof name === 'string' && name.length > 0)).toBe(true);
  });

  test('each has its own metadata rather than the unknown-tool fallback', () => {
    // Compared against a name that is certainly absent: an assertion that an entry merely exists would
    // hold for the fallback too.
    const fallback = getToolMetadata('geocode-no-such-tool');
    const shapes = INJECTED.map((name) => [name, getToolMetadata(name!).outputLanguage === fallback.outputLanguage]);
    expect(shapes).toEqual(INJECTED.map((name) => [name, false]));
  });

  test('each renders its answer as JSON', () => {
    const languages = INJECTED.map((name) => [name, detectToolOutputLanguage(name!, '{"ok":true}')]);
    expect(languages).toEqual(INJECTED.map((name) => [name, 'json']));
  });
});
