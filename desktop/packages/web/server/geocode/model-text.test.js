import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAgentToolRuntime } from '../lib/agent-tool/runtime.js';
import * as actions from '../lib/openchamber-control/actions.js';
import { createImageGenerationAction } from '../lib/openchamber-control/generate-image.js';
import { createWorkNamer } from '../lib/openchamber-sessions/work-naming.js';
import { createPrWatchRuntime, parsePullRequestUrl } from '../lib/pr-watch/runtime.js';
import { buildKnowledgeEntries } from '../lib/session-knowledge/runtime.js';
import { CHATS_SCOPE_PUBLIC_ID } from '../lib/scheduled-tasks/chats-scope.js';
import { trackedItemKey } from '../lib/tracked-items/items.js';

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

const PULL_URL = 'https://github.com/acme/app/pull/7';
const pull = { owner: 'acme', repo: 'app', number: 7, state: 'open', title: 'Fix it', headSha: 'a1', mergeableState: 'clean', checks: { state: 'pending' }, activity: 2 };
const dataDirs = [];
let move = () => {};

afterEach(() => {
  for (const directory of dataDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

// A pull request watch over a kernel that admits every wake, and a GitHub that answers `read`.
const prWatch = async (read) => {
  const admitted = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-pr-watch-'));
  dataDirs.push(dataDir);
  const runtime = createPrWatchRuntime({
    buildOpenCodeUrl: (fetchPath) => `http://kernel.test${fetchPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    broadcastUiEvent: () => {},
    dataDir,
    readCleanupOnMerge: async () => false,
    isSessionArchived: async () => false,
    fetchImpl: async (url, init = {}) => {
      const { pathname } = new URL(url);
      if (pathname === '/api/session/active') return Response.json({ data: {} });
      if (pathname === '/api/session') return Response.json({ data: [], cursor: {} });
      const body = JSON.parse(init.body);
      admitted.push(body);
      return Response.json({ data: { id: body.id } });
    },
    quietMs: 0,
    retryDelayMs: () => 5,
    subagentRecheckMs: 5,
  });
  runtime.start({ subscribeEvent: () => () => {}, subscribeStatus: () => () => {} });
  let listener = () => {};
  runtime.attach({
    trackedItems: { setServerInterest() {}, subscribe(next) { listener = next; return () => {}; } },
    readers: { sourceControl: async () => read },
  });
  if (read.status === 'ok') await runtime.watch({ sessionID: 'ses_agent', directory: '/repo', url: PULL_URL });
  move = (state) => listener([{ key: trackedItemKey(parsePullRequestUrl(PULL_URL)), state, requestedAt: Date.now() + 1 }]);
  return { runtime, admitted };
};
const stop = async (runtime) => {
  runtime.stop();
  await runtime.flush();
};

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
      responseStyleInstruction: 'Keep replies short.',
    });
    // The keys too: the kernel writes each entry's key into the prompt with its text.
    expect(Object.entries(entries).flat().join('\n')).not.toMatch(UPSTREAM);
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

  it('names Chats as GeoCode does where a session can go, and takes that name back', async () => {
    const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-model-text-'));
    try {
      const asked = [];
      const runtime = createAgentToolRuntime({
        crypto, fsPromises: fs.promises, path, instanceDir, getActivePort: () => 1,
        executeAction: async (action, input) => {
          asked.push(input);
          return action === 'projects.list' ? { projects: [{ id: CHATS_SCOPE_PUBLIC_ID, label: 'Chats' }] } : { created: input.projectId };
        },
      });
      const listed = await runtime.execute({ tool: 'geocode', input: { action: 'projects.list' } });
      expect(JSON.stringify(listed)).not.toMatch(UPSTREAM);
      expect(listed.data.projects[0].id).toBe('geocode:chats');
      await runtime.execute({ tool: 'geocode', input: { action: 'session.create', projectId: 'geocode:chats' } });
      expect(asked.at(-1).projectId).toBe(CHATS_SCOPE_PUBLIC_ID);
    } finally {
      fs.rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it('names neither upstream when the image tool cannot draw', async () => {
    const failing = (settings, tag) => createImageGenerationAction({
      getClient: async () => ({ experimental: { generate: { image: async () => { throw Object.assign(new Error(tag), { _tag: tag }); } } } }),
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

  it('names neither upstream when it wakes an agent waiting on a pull request', async () => {
    const { runtime, admitted } = await prWatch({ status: 'ok', pulls: [pull] });
    move({ ...pull, checks: { state: 'success' } });
    for (let tries = 0; admitted.length === 0 && tries < 400; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(admitted).toHaveLength(1);
    // The message and its metadata stay in the kernel's session.
    const [{ text, description, metadata }] = admitted;
    expect(text).toContain('Pull request #7');
    expect(JSON.stringify({ text, description, metadata })).not.toMatch(UPSTREAM);
    await stop(runtime);
  });

  it('names neither upstream when it cannot follow a pull request', async () => {
    const { runtime } = await prWatch({ status: 'disconnected' });
    const refused = await runtime.watch({ sessionID: 'ses_agent', directory: '/repo', url: PULL_URL }).then(() => null, (error) => error.message);
    expect(refused).toContain('GitHub account');
    expect(refused).not.toMatch(UPSTREAM);
    await stop(runtime);
  });

  // GitLab is closed: a model told it can wait on a merge request would be refused for want of an account it cannot add.
  it('names no git host but GitHub when an agent waits on a pull request', async () => {
    const watch = actions.OPENCHAMBER_CONTROL_ACTION_DEFINITIONS.find((definition) => definition.action === 'pr.watch');
    expect(watch.description).toContain('GitHub pull request');
    expect(watch.description).not.toMatch(/gitlab|merge request/i);
    const { runtime } = await prWatch({ status: 'disconnected' });
    const refused = await runtime.watch({ sessionID: 'ses_agent', directory: '/repo', url: 'https://gitlab.com/group/app/-/merge_requests/12' }).then(() => null, (error) => error.message);
    expect(refused).toBe('url must be the address of a GitHub pull request');
    await stop(runtime);
  });

  // Isolated spaces are closed: a model told it names a space's task looks for one it cannot have.
  it('names no isolated space where an agent names its task', () => {
    const name = actions.OPENCHAMBER_CONTROL_ACTION_DEFINITIONS.find((definition) => definition.action === 'work.name');
    expect(name.description).not.toMatch(/space/i);
  });

  it('names neither upstream when it names a task', async () => {
    await expect(namer('agile-chipmunk').name({ sessionId: 'ses_1', title: 'Roads' })).rejects.toThrow(/GeoCode generated/);
    await expect(namer('agile-chipmunk').name({ sessionId: 'ses_1', title: 'Roads' })).rejects.not.toThrow(UPSTREAM);
    const kept = await namer(null).name({ sessionId: 'ses_1', title: 'Roads', branch: 'fix/roads' });
    expect(JSON.stringify(kept)).not.toMatch(UPSTREAM);
  });
});
