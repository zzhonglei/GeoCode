/* --- GeoCode: the shell registers no magic-prompt routes under Electron (docs/DESKTOP.md §7.3).
 *
 * These are the prompts behind the product's own one-click actions — commit messages, session
 * summaries, goal drafting, fusion — not something a user writes. GeoCode owns them. Asserted by
 * giving the registrar a recording stand-in for the Express app: what matters is registration,
 * not behaviour, so a route upstream adds later is covered too. The control run without the
 * Electron mark must mount the whole surface, or the guard proves nothing. --- */
import { afterEach, describe, expect, it } from 'vitest';
import { registerMagicPromptRoutes } from '../lib/magic-prompts/routes.js';

const originalElectron = process.versions.electron;

afterEach(() => {
  if (originalElectron === undefined) delete process.versions.electron;
  else process.versions.electron = originalElectron;
});

const mountedPaths = () => {
  const paths = [];
  const record = (path) => { paths.push(path); };
  registerMagicPromptRoutes(
    { get: record, post: record, put: record, patch: record, delete: record, all: record, use: record },
    { fsPromises: {}, path: { join: (...parts) => parts.join('/') }, openchamberDataDir: '/tmp/geocode-magic-prompts-test' },
  );
  return paths;
};

describe('magic prompt surface', () => {
  it('mounts nothing under Electron', () => {
    process.versions.electron = '0.0.0-test';
    expect(mountedPaths()).toEqual([]);
  });

  it('control: outside Electron the whole surface is mounted', () => {
    delete process.versions.electron;
    const paths = mountedPaths();
    expect(paths.length).toBeGreaterThanOrEqual(4);
    expect(paths.every((path) => path.startsWith('/api/magic-prompts'))).toBe(true);
  });
});
