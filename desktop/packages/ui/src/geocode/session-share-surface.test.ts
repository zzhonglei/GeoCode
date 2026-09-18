/* --- GeoCode: the session share entries must stay closed, including one upstream adds later
 * (geocode/session-share-surface.ts, docs/DESKTOP.md §7.3). --- */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SESSION_SHARING_OFFERED } from './session-share-surface';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I18N = path.join(SRC, 'lib', 'i18n');

// The trailing quote keeps any longer key that starts with this one out of the count.
const SHARE_ENTRY = "sessions.sidebar.session.menu.share'";
const GUARD = '!SESSION_SHARING_OFFERED ? null :';

const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(full);
  if (!/\.tsx?$/.test(entry.name) || /\.(test|bench)\./.test(entry.name)) return [];
  // The dictionaries hold the key itself, not an entry that renders it.
  if (full.startsWith(I18N)) return [];
  return [full];
});

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

const isBalanced = (text: string) => occurrences(text, SHARE_ENTRY) === occurrences(text, GUARD);

const unbalanced = () => sources(SRC)
  .filter((file) => !isBalanced(readFileSync(file, 'utf8')))
  .map((file) => path.relative(SRC, file));

const carriesEntry = () => sources(SRC)
  .filter((file) => occurrences(readFileSync(file, 'utf8'), SHARE_ENTRY) > 0)
  .map((file) => path.relative(SRC, file))
  .sort();

describe('session sharing is not offered', () => {
  test('the constant is off', () => {
    expect(SESSION_SHARING_OFFERED).toBe(false);
  });

  test('every share entry in the renderer sits behind the guard', () => {
    expect(unbalanced()).toEqual([]);
  });

  test('the entries are the two menus we know about', () => {
    expect(carriesEntry()).toEqual([
      'components/layout/Header.tsx',
      'components/session/sidebar/sessions/SessionNodeItem.tsx',
    ]);
  });

  test('the scan sees an unguarded entry when there is one', () => {
    expect(isBalanced(`<Item>{t('${SHARE_ENTRY.slice(0, -1)}')}</Item>`)).toBe(false);
    expect(isBalanced(`{${GUARD} <Item>{t('${SHARE_ENTRY.slice(0, -1)}')}</Item>}`)).toBe(true);
  });
});
