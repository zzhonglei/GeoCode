/* --- GeoCode: the three entrances into the repository file must stay closed, including one
 * upstream adds later (geocode/repository-sharing-surface.ts, docs/DESKTOP.md §7.3).
 *
 * Pinning the three files edited here would not see a fourth one arrive. So the first test walks
 * the renderer sources and holds a closure instead: a file that renders one of the two entrance
 * labels must also carry the guard. The labels reach the screen only through those translation
 * keys, and the dictionaries are excluded, which is what makes the set exact.
 *
 * The closure alone would pass on a file that imports the guard and never uses it, so the rest
 * pin where each guard sits. The chip is the odd one out: its label lives in the child component
 * and the guard in the parent that hands down the callback, so position says nothing there and
 * what is pinned instead is that no callback is handed down. --- */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPOSITORY_SHARING_OFFERED } from './repository-sharing-surface';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I18N = path.join(SRC, 'lib', 'i18n');

// The trailing quote keeps `shareTitle`, `shareAfterSave` and the toast keys out of the set.
const ENTRANCES = ["settings.projects.shared.actions.share'", "chat.draftStarters.share'"];
const GUARD = 'REPOSITORY_SHARING_OFFERED';

const read = (relative: string) => readFileSync(path.join(SRC, relative), 'utf8');

const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(full);
  if (!/\.tsx?$/.test(entry.name) || /\.(test|bench)\./.test(entry.name)) return [];
  // The dictionaries hold the key itself, not an entrance that renders it.
  if (full.startsWith(I18N)) return [];
  return [full];
});

const unguarded = () => sources(SRC)
  .filter((file) => {
    const text = readFileSync(file, 'utf8');
    return ENTRANCES.some((entrance) => text.includes(entrance)) && !text.includes(GUARD);
  })
  .map((file) => path.relative(SRC, file))
  .sort();

describe('repository sharing is not offered', () => {
  test('the constant is off', () => {
    expect(REPOSITORY_SHARING_OFFERED).toBe(false);
  });

  test('every file rendering an entrance carries the guard', () => {
    expect(unguarded()).toEqual([]);
  });

  test('the settings buttons sit behind the guard', () => {
    for (const file of [
      'components/sections/projects/ProjectActionsSection.tsx',
      'components/sections/openchamber/WorktreeSectionContent.tsx',
    ]) {
      const text = read(file);
      const guard = text.indexOf(`!${GUARD} ? null :`);
      const label = text.indexOf(ENTRANCES[0]);
      expect([file, guard]).not.toEqual([file, -1]);
      expect([file, guard < label]).toEqual([file, true]);
    }
  });

  test('every mount of the shared-file section sits behind the guard', () => {
    // That section is nothing but the shared file: where it is, whether it parsed, and the
    // plans folder. A mount pattern, not a substring, or `React.FC<...Props>` counts as one.
    const mount = /<SharedProjectConfigSection[\s/>]/g;
    const unguarded = sources(SRC)
      .map((file) => ({ file: path.relative(SRC, file), text: readFileSync(file, 'utf8') }))
      .filter(({ text }) => (text.match(mount) ?? []).length > 0)
      .filter(({ text }) => (text.match(mount) ?? []).length
        !== text.split(`!${GUARD} ? null : <SharedProjectConfigSection`).length - 1)
      .map(({ file }) => file);
    expect(unguarded).toEqual([]);
  });

  test('the draft starter chip is handed no callback, so its button never renders', () => {
    const chips = read('components/chat/DraftPresetChips.tsx');
    // The hand-down, guarded. `[^}]*` stops at the first brace, which is the one closing it.
    expect(/onToggleShared=\{[^}]*REPOSITORY_SHARING_OFFERED \? undefined :/.test(chips)).toBe(true);
    // And the child renders its button only when the callback arrives.
    expect(chips).toContain('{onToggleShared && !hideRemove ?');
  });
});
