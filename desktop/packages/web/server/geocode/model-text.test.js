import { describe, expect, it } from 'vitest';

import * as actions from '../lib/openchamber-control/actions.js';
import { createWorkNamer } from '../lib/openchamber-sessions/work-naming.js';
import { buildKnowledgeEntries } from '../lib/session-knowledge/runtime.js';

const UPSTREAM = /openchamber|opencode/i;
// Workflows ship off, as upstream ships them, and keep upstream's names until they are turned on.
const OFF = ['OPENCHAMBER_WORKFLOW_ACTION_DEFINITIONS', 'OPENCHAMBER_WORKFLOW_ANSWER_ACTION_DEFINITIONS'];

const namer = (placeholder) => createWorkNamer({
  getSession: async (id) => ({ id, directory: '/repo/worktrees/roads' }),
  listWorktrees: async () => [{ path: '/repo' }, { path: '/repo/worktrees/roads' }],
  setWorktreeTaskTitle: async (_directory, { title }) => ({ applied: true, title }),
  readPlaceholderBranch: async () => placeholder,
  renameSession: async () => undefined,
  updateMetadata: async () => undefined,
  createError: (message) => new Error(message),
});

// Guards against what the server tells a model naming OpenChamber or OpenCode, or a tool by upstream's name.
describe('GeoCode: what the server tells a model', () => {
  it('names neither upstream in the context every session carries', () => {
    const entries = buildKnowledgeEntries({
      notes: '',
      plans: '',
      memory: { global: [], project: [], enabled: true, complete: true },
      linking: true,
      rendering: true,
      checkout: { directory: '/repo/worktrees/roads', branch: 'agile-chipmunk', placeholder: true },
    });
    expect(Object.values(entries).join('\n')).not.toMatch(UPSTREAM);
  });

  it("names neither upstream in the agent tools' actions", () => {
    const named = Object.entries(actions)
      .filter(([key]) => key.endsWith('_ACTION_DEFINITIONS') && !OFF.includes(key))
      .flatMap(([, definitions]) => definitions)
      .filter((definition) => UPSTREAM.test(JSON.stringify(definition)))
      .map((definition) => definition.action);
    expect(named).toEqual([]);
  });

  it('names neither upstream when it names a task', async () => {
    await expect(namer('agile-chipmunk').name({ sessionId: 'ses_1', title: 'Roads' })).rejects.toThrow(/GeoCode generated/);
    await expect(namer('agile-chipmunk').name({ sessionId: 'ses_1', title: 'Roads' })).rejects.not.toThrow(UPSTREAM);
    const kept = await namer(null).name({ sessionId: 'ses_1', title: 'Roads', branch: 'fix/roads' });
    expect(JSON.stringify(kept)).not.toMatch(UPSTREAM);
  });
});
