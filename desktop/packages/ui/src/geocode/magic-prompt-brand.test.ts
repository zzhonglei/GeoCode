/* --- GeoCode: the prompts behind one-click actions name GeoCode, and the tools they name are ones the agent has
 * (docs/DESKTOP.md §7.3). --- */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDefaultMagicPromptTemplate, type MagicPromptId } from '../lib/magicPrompts';
import { MAGIC_PROMPT_COMMANDS } from '../components/chat/composer/submit/slashCommands';
import { CLOSED_SLASH_COMMANDS } from './slash-command-surface';

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../lib/magicPrompts.ts'), 'utf8');
const ids = [...source.matchAll(/^\s*id: '([^']+)',$/gm)].map((match) => match[1] as MagicPromptId);

// The kernel's question tool, and the control tool the desktop injects under this name
// (electron/geocode/browser-tool.mjs GEOCODE_TOOL_NAME).
const AGENT_TOOLS = ['question', 'geocode'];

// A closed command never sends its prompts, so what they say reaches no model.
const unsent = new Set<string>(
  MAGIC_PROMPT_COMMANDS
    .filter((command) => CLOSED_SLASH_COMMANDS.has(command.name))
    .flatMap((command) => [command.visiblePrompt, command.instructionsPrompt]),
);

describe('magic prompt brand', () => {
  test('reads the prompts, the ones that carried the old names among them', () => {
    for (const id of ['session.reviewHandoff.instructions', 'session.craftGoal.instructions', 'session.scheduleTask.instructions']) {
      expect([id, ids.includes(id as MagicPromptId)]).toEqual([id, true]);
    }
  });

  test('no prompt names OpenChamber', () => {
    for (const id of ids) {
      expect([id, getDefaultMagicPromptTemplate(id).includes('OpenChamber')]).toEqual([id, false]);
    }
  });

  test('a prompt that can still be sent names only tools the agent has', () => {
    for (const id of ids.filter((candidate) => !unsent.has(candidate))) {
      for (const [, tool] of getDefaultMagicPromptTemplate(id).matchAll(/`([a-z_]+)` tool/g)) {
        expect([id, tool, AGENT_TOOLS.includes(tool)]).toEqual([id, tool, true]);
      }
    }
    // Both end by offering to create what they defined, which only this tool can do.
    for (const id of ['session.craftGoal.instructions', 'session.scheduleTask.instructions'] as const) {
      expect([id, getDefaultMagicPromptTemplate(id).includes('`geocode` tool')]).toEqual([id, true]);
    }
  });

  test('the note that stands in for a missing plan file names GeoCode', () => {
    // A plan saved as project knowledge has no file, so the plan view sends its contents behind a note of its own
    // that tells the agent where the plan lives; it is written in the component, not among the prompts above.
    const planView = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../components/views/PlanView.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const note = planView.match(/'[^'\n]*project knowledge[^'\n]*'/)?.[0] ?? '';
    expect(note).toContain('GeoCode');
    expect(note).not.toContain('OpenChamber');
  });
});
