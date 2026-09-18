/* --- GeoCode: Linear stays closed at every renderer entry, including one a merge adds later
 * (geocode/linear-surface.ts, docs/DESKTOP.md §7.3). --- */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LINEAR_OFFERED } from './linear-surface';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I18N = path.join(SRC, 'lib', 'i18n');

const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(full);
  if (!/\.tsx?$/.test(entry.name) || /\.(test|bench)\./.test(entry.name)) return [];
  // The dictionaries hold the keys themselves, not an entry that renders one.
  if (full.startsWith(I18N)) return [];
  return [full];
});

// What puts Linear in front of someone: the two composer entries and the two names of the side panel.
const ENTRY_KEYS = [
  'linkLinearIssue',
  'startFromLinearIssue',
  'contextPanel.mode.linear',
  'contextRail.surface.linear',
];

const carriesEntry = (text: string) => ENTRY_KEYS.some((key) => text.includes(key));

const filesWithEntries = () => sources(SRC)
  .filter((file) => carriesEntry(readFileSync(file, 'utf8')))
  .map((file) => path.relative(SRC, file))
  .sort();

// One row per place that decides whether an entry appears. The rail dialog is listed on its own because it
// renders the whole registry on purpose, so the runtime filter above it never reaches Linear.
const CLOSURES: ReadonlyArray<readonly [string, string]> = [
  ['components/sections/integrations/IntegrationsPage.tsx', '{LINEAR_OFFERED && hasLinear ? <LinearSettings /> : null}'],
  ['components/chat/ChatInput.tsx', 'const showLinearPicker = LINEAR_OFFERED &&'],
  ['components/session/NewWorktreeDialog.tsx', 'const isLinearConnected = LINEAR_OFFERED &&'],
  ['lib/surfaces/registry.ts', "if (surface.id === 'linear' && !LINEAR_OFFERED) {"],
  ['components/layout/ContextRailSurfacesDialog.tsx', "LINEAR_OFFERED || surface.id !== 'linear'"],
  ['components/chat/work-status/WorkStatusContextSection.tsx', '&& LINEAR_OFFERED'],
];

describe('Linear is not offered', () => {
  test('the constant is off', () => {
    expect(LINEAR_OFFERED).toBe(false);
  });

  test('every place that decides an entry still holds the guard', () => {
    const missing = CLOSURES
      .filter(([file, snippet]) => !readFileSync(path.join(SRC, file), 'utf8').includes(snippet))
      .map(([file]) => file);
    expect(missing).toEqual([]);
  });

  test('the renderer is handed no Linear runtime API, so nothing asks the shell on startup', () => {
    const api = readFileSync(path.join(SRC, '..', '..', 'web', 'src', 'api', 'index.ts'), 'utf8');
    expect(/^\s*linear:/m.test(api)).toBe(false);
  });

  test('the entries are the ones we know about', () => {
    expect(filesWithEntries()).toEqual([
      'components/chat/ChatInput.tsx',
      'components/chat/composer/ui/ComposerAttachmentControls.tsx',
      'components/layout/ContextPanel.tsx',
      'components/session/NewWorktreeDialog.tsx',
      'lib/surfaces/registry.ts',
    ]);
  });

  test('the scan sees an entry a merge adds', () => {
    expect(carriesEntry("aria-label={t('chat.chatInput.actions.linkLinearIssue')}")).toBe(true);
    expect(carriesEntry('<Button onClick={openGitHubIssue}>')).toBe(false);
  });
});
