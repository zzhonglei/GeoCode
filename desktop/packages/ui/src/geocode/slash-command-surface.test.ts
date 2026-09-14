/* --- GeoCode: the closed composer entries stay closed, the kept ones still run, and the commands GeoCode ships
 * count as built-in (geocode/slash-command-surface.ts, docs/DESKTOP.md §7.3). --- */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLOSED_SLASH_COMMANDS, SHIPPED_SLASH_COMMANDS } from './slash-command-surface';
import { planLocalSlashCommand } from '../components/chat/composer/submit/slashCommands';

// Comments are stripped first, or a guard commented out would still be found.
const code = (relative: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

const CLOSED_FILTER = '.filter((cmd) => !CLOSED_SLASH_COMMANDS.has(cmd.name))';

describe('slash command surface', () => {
  test('the closed entries are the ones decided', () => {
    expect([...CLOSED_SLASH_COMMANDS].sort()).toEqual([
      'catch-up',
      'debug',
      'explore',
      'handoff-review',
      'init',
      'plan-feature',
      'review',
      'summary',
      'weigh',
      'workspace-review',
    ]);
  });

  test('the composer runs none of the closed commands and still runs the kept ones', () => {
    for (const name of CLOSED_SLASH_COMMANDS) {
      expect(planLocalSlashCommand(`/${name} topic`, 'normal', false, true)).toBeNull();
    }
    for (const name of ['undo', 'redo', 'timeline', 'compact', 'btw', 'craft-goal', 'schedule-task']) {
      expect(planLocalSlashCommand(`/${name}`, 'normal', false, true)).not.toBeNull();
    }
  });

  test('the slash menu drops the closed entries before merging, so a user command of the same name stays', () => {
    const menu = code('components/chat/CommandAutocomplete.tsx');
    expect(menu).toContain(`mergeCommandAutocompleteItems(builtInCommands${CLOSED_FILTER}, customCommands, skillCommands)`);
    expect(menu).toContain(`setCommands(filtered${CLOSED_FILTER})`);
  });

  test('the commands GeoCode ships count as built-in in the commands page and in the slash menu', () => {
    expect([...SHIPPED_SLASH_COMMANDS]).toEqual(['set']);
    expect(code('stores/useCommandsStore.ts')).toContain("new Set(['init', 'review', ...SHIPPED_SLASH_COMMANDS])");
    expect(code('components/chat/CommandAutocomplete.tsx')).toContain(
      "isBuiltIn: cmd.name === 'init' || cmd.name === 'review' || SHIPPED_SLASH_COMMANDS.has(cmd.name)",
    );
  });
});
