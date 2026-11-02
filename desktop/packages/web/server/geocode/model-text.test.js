import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAgentToolRuntime } from '../lib/agent-tool/runtime.js';
import * as actions from '../lib/openchamber-control/actions.js';
import { createImageGenerationAction } from '../lib/openchamber-control/generate-image.js';
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

  it('names neither upstream in what the image tool says it is', async () => {
    const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-model-text-'));
    try {
      const runtime = createAgentToolRuntime({ crypto, fsPromises: fs.promises, path, instanceDir, getActivePort: () => 1 });
      const directory = await runtime.materializePlugin({ includeControl: false, includeWeb: false, includeMemory: false, includeImage: true });
      // The plugin's own code keeps upstream's variable names; what the model reads is the tool's description and parameters.
      const told = fs.readFileSync(path.join(directory, 'index.js'), 'utf8').split('\n').filter((line) => /^\s*(?:description: "|parameters: \{)/.test(line));
      expect(told.length).toBe(2);
      expect(told.join('\n')).not.toMatch(UPSTREAM);
    } finally {
      fs.rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it('names neither upstream when the image tool cannot draw', async () => {
    const failing = (settings, tag) => createImageGenerationAction({
      getClient: async () => ({ generate: { image: async () => { throw Object.assign(new Error(tag), { _tag: tag }); } } }),
      readSettings: async () => settings,
      fsPromises: fs.promises,
    })({ prompt: 'a river map' }, { directory: os.tmpdir() });
    const chosen = { agentImageToolEnabled: true, agentImageModel: 'openrouter/openai/gpt-image-2' };
    const errors = await Promise.all([
      failing({ agentImageToolEnabled: false }),
      failing({ agentImageToolEnabled: true }),
      failing(chosen, 'ModelNotFoundError'),
      failing(chosen, 'UnsupportedModelError'),
    ].map((call) => call.then(() => null, (error) => error.message)));
    expect(errors.every(Boolean)).toBe(true);
    expect(errors.filter((message) => UPSTREAM.test(message))).toEqual([]);
    expect(errors.filter((message) => message.includes('Settings > General > GeoCode Tools'))).toHaveLength(3);
  });

  it('names neither upstream when it names a task', async () => {
    await expect(namer('agile-chipmunk').name({ sessionId: 'ses_1', title: 'Roads' })).rejects.toThrow(/GeoCode generated/);
    await expect(namer('agile-chipmunk').name({ sessionId: 'ses_1', title: 'Roads' })).rejects.not.toThrow(UPSTREAM);
    const kept = await namer(null).name({ sessionId: 'ses_1', title: 'Roads', branch: 'fix/roads' });
    expect(JSON.stringify(kept)).not.toMatch(UPSTREAM);
  });
});
