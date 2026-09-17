/* --- GeoCode: text the renderer shows the user, or attaches for the model, names GeoCode where upstream named
 * OpenChamber or OpenCode (docs/PATHS.md §3.4). Each message is found by the words around the name, so a reworded
 * one turns this red instead of slipping past it. --- */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID, themes } from '../lib/theme/themes';
import { AGENT_MENTION_LINKS_OFFERED } from './agent-mention-surface';

// The file, a pattern capturing the product name inside the message, and how many times the message appears.
type Message = [file: string, pattern: RegExp, count: number];

const READ_BY_THE_MODEL: Message[] = [
  ['sync/document-attachments.ts', /\[Document text truncated by (\w+)\]/g, 1],
  ['sync/attachment-files.ts', /\[OMITTED BY (\w+)\]/g, 1],
];

const SEEN_BY_THE_USER: Message[] = [
  ['components/chat/CommandAutocomplete.tsx', /isOpenChamberBadge \? \(\s*<span className=\{NEUTRAL_BADGE_CLASS\}>\s*(?:\{\/\*[^*]*\*\/\}\s*)?(\w+)/g, 1],
  ['components/layout/Header.tsx', /activeProjectLabel \?\? '(\w+)'/g, 1],
  ['components/mini-chat/MiniChatLayout.tsx', /directoryLabel \|\| '(\w+)'/g, 1],
  ['components/chat/ChatMessage.tsx', /(\w+) failed to send (?:a )?message/g, 2],
  ['components/chat/ChatMessage.tsx', /before (\w+) could send the next message/g, 1],
  ['stores/useAgentsStore.ts', /Waiting for (\w+)…/g, 1],
  ['stores/useAgentsStore.ts', /"(\w+) refresh failed/g, 1],
  ['stores/useAgentsStore.ts', /Reloading (\w+) configuration/g, 1],
  // Rethrown to the settings footer and provider save, which toast the message as it is.
  ['stores/useAgentsStore.ts', /"(\w+) health check reported not ready"/g, 1],
  ['stores/useAgentsStore.ts', /"(\w+) did not become ready in time"/g, 1],
  ['stores/useSkillsStore.ts', /Waiting for (\w+)…/g, 1],
  ['stores/useSkillsStore.ts', /"(\w+) refresh failed/g, 1],
  ['lib/configUpdate.ts', /Updating (\w+) configuration/g, 1],
  ['components/sections/mcp/McpSidebar.tsx', /deleted, but (\w+) reload failed/g, 1],
  ['components/sections/mcp/McpOAuthCallbackPage.tsx', /[Rr]eturn to (\w+)/g, 3],
  ['components/sections/mcp/McpOAuthCallbackPage.tsx', /code into (\w+) manually/g, 2],
  ['lib/worktreeSessionCreator.ts', /not registered in (\w+)/g, 1],
  ['sync/session-ui-store.ts', /not registered in (\w+)/g, 1],
  ['lib/opencode/client.ts', /(\w+) request timed out/g, 1],
  ['lib/opencode/client.ts', /'Failed to update (\w+) working directory'/g, 1],
  ['sync/bootstrap.ts', /"(\w+) process is not running"/g, 1],
  ['hooks/useMenuActions.ts', /Failed to collect (\w+) status/g, 1],
  // Also the label of the API key a user creates by running it.
  ['components/sections/usage/QuotaCredentials.tsx', /generate-api-key --label=(\w+) --exp/g, 1],
  ['components/chat/SkillAutocomplete.tsx', /const sourceLabel = source === 'opencode' \? '(\w+)' : source;/g, 1],
];

const IN_THE_DIAGNOSTICS_REPORT: Message[] = [
  ['lib/openCodeStatus.ts', /`(\w+) version:/g, 1],
  ['lib/openCodeStatus.ts', /`(\w+) SDK base:/g, 1],
  ['lib/openCodeStatus.ts', /`(\w+) runtime (?:port|running):/g, 2],
  ['lib/openCodeStatus.ts', /`Secure (\w+) connection:/g, 1],
  ['lib/openCodeStatus.ts', /`(\w+) auth source:/g, 1],
  ['lib/openCodeStatus.ts', /'(\w+) process:'/g, 1],
  ['lib/openCodeStatus.ts', /Recent (\w+) session errors:/g, 1],
  ['lib/openCodeStatus.ts', /'(\w+) CLI resolution:'/g, 1],
  ['lib/openCodeStatus.ts', /'(\w+) API probes:/g, 2],
  ['lib/openCodeStatus.ts', /`- (\w+): \$\{opencodeHome/g, 1],
  ['lib/openCodeStatus.ts', /`- (\w+) desktop: /g, 1],
  ['lib/openCodeStatus.ts', /`- (\w+): \$\{resolved\}/g, 1],
  ['lib/openCodeStatus.ts', /'- (\w+): \(n\/a\)'/g, 1],
];

const expectGeoCode = (messages: Message[]) => {
  for (const [file, pattern, count] of messages) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const names = [...source.matchAll(pattern)].map((match) => match[1].toLowerCase());
    expect([file, String(pattern), names]).toEqual([file, String(pattern), Array(count).fill('geocode')]);
  }
};

describe('the product name in renderer text', () => {
  test('notes attached for the model', () => expectGeoCode(READ_BY_THE_MODEL));
  test('messages the user sees', () => expectGeoCode(SEEN_BY_THE_USER));
  test('the diagnostics report', () => expectGeoCode(IN_THE_DIAGNOSTICS_REPORT));
});

describe('a server message the renderer would show as it is', () => {
  test('deleting an MCP server shows the apply note, not "Restart OpenCode to apply."', () => {
    // Create and update already take this branch; applying refreshes the kernel and restarts nothing.
    for (const file of ['components/sections/mcp/McpPage.tsx', 'components/sections/mcp/McpSidebar.tsx']) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      const handler = source.slice(source.indexOf('const handleDelete = async'));
      const deferred = handler.search(/\} else if \(result\.restartDeferred\) \{\s*toast\.success\(t\('settings\.view\.pendingRestart\.saved'\)\);/);
      const verbatim = handler.indexOf('toast.success(result.message');
      expect([file, deferred > -1 && deferred < verbatim]).toEqual([file, true]);
    }
  });
});

const readSource = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('renderer affordances that named or led to upstream', () => {
  test('the default themes are called Default', () => {
    const defaults = themes.filter((theme) => [DEFAULT_LIGHT_THEME_ID, DEFAULT_DARK_THEME_ID].includes(theme.metadata.id as never));
    expect(defaults.map((theme) => theme.metadata.name)).toEqual(['Default', 'Default']);
  });

  test('the skill source badge shows the label, not the wire value', () => {
    const source = readSource('components/chat/SkillAutocomplete.tsx');
    expect(source).toContain('{sourceLabel}');
    expect(/^\s*\{source\}\s*$/m.test(source)).toBe(false);
  });

  test('an agent mention is plain text, not a link to upstream docs', () => {
    // Every call that builds the link, in any renderer file, sits right behind the early return.
    expect(AGENT_MENTION_LINKS_OFFERED).toBe(false);
    const root = new URL('..', import.meta.url).pathname;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(full);
      }
    };
    walk(root);
    const calls = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(/buildAgentMentionUrl\(/g)].map((match) => {
        const at = match.index ?? 0;
        const guard = source.lastIndexOf('if (!AGENT_MENTION_LINKS_OFFERED)', at);
        const returns = /^if \(!AGENT_MENTION_LINKS_OFFERED\)\s*(\{\s*)?return\b/.test(source.slice(guard));
        return [path.relative(root, file), guard > -1 && at - guard < 1000 && returns];
      });
    });
    expect(calls.sort()).toEqual([
      ['components/chat/markdown/markdownCore.ts', true],
      ['components/chat/message/parts/UserTextPart.tsx', true],
    ]);
  });

  test('the walkthrough guide button stays hidden', () => {
    const source = readSource('components/views/walkthrough/WalkthroughView.tsx');
    expect(/^const WALKTHROUGH_GUIDE_SHOWN = false;/m.test(source)).toBe(true);
    const opens = [...source.matchAll(/openExternalUrl\(WALKTHROUGH_GUIDE_URL\)/g)].map((match) => match.index ?? 0);
    expect(opens.length).toBeGreaterThan(0);
    for (const at of opens) {
      const guard = source.lastIndexOf('{WALKTHROUGH_GUIDE_SHOWN && (', at);
      expect(guard).toBeGreaterThan(-1);
      expect(source.slice(guard, at)).not.toContain('{/* --- /GeoCode --- */}');
      expect(/^\s*\)\}\s*$/m.test(source.slice(guard, at))).toBe(false);
    }
  });
});
