/* --- GeoCode: the callback route accepts the token the main process minted, for the two tools the
 * desktop injects and each one's own actions (docs/DESKTOP.md §7.2).
 *
 * Driven over a real loopback socket, because `authorize` checks the peer address as well as the
 * bearer token. Under Electron the runtime adopts the token from its environment; a call carrying
 * that token still reaches only the calling tool's actions. The control run without the Electron
 * mark keeps upstream's behaviour: no token was ever issued, so the route answers 401. --- */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import { createAgentToolRuntime } from '../lib/agent-tool/runtime.js';

const originalElectron = process.versions.electron;
const TOKEN = 'test-token-from-main';

afterEach(() => {
  if (originalElectron === undefined) delete process.versions.electron;
  else process.versions.electron = originalElectron;
});

const createApp = (env) => {
  const executed = [];
  const runtime = createAgentToolRuntime({
    crypto,
    fsPromises,
    path,
    dataDir: '/tmp/geocode-browser-tool-callback-test',
    env,
    getActivePort: () => 0,
    executeAction: async (action, input) => { executed.push({ action, input }); return { done: true }; },
  });
  const app = express();
  runtime.registerRoutes(app, express);
  return { app, executed };
};

const post = (app, token, body) => request(app)
  .post('/api/openchamber/agent-tool')
  .set('authorization', `Bearer ${token}`)
  .send(body);

describe('agent tool callback under Electron', () => {
  it('hands a browser action from browser and a control action from geocode to the control service', async () => {
    process.versions.electron = '0.0.0-test';
    const { app, executed } = createApp({ OPENCHAMBER_AGENT_TOOL_TOKEN: TOKEN });
    const browser = await post(app, TOKEN, { tool: 'browser', input: { action: 'browser.open', url: 'https://example.com' } });
    const geocode = await post(app, TOKEN, { tool: 'geocode', input: { action: 'schedule.create', name: 'weekly roads' } });
    expect([browser.status, browser.body.ok, geocode.status, geocode.body.ok]).toEqual([200, true, 200, true]);
    expect(executed.map((call) => call.action)).toEqual(['browser.open', 'schedule.create']);
  });

  it('resolves a bare name within the calling tool', async () => {
    process.versions.electron = '0.0.0-test';
    const { app, executed } = createApp({ OPENCHAMBER_AGENT_TOOL_TOKEN: TOKEN });
    // Memory has a delete as well, so across every action the name means nothing.
    const response = await post(app, TOKEN, { tool: 'geocode', input: { action: 'delete', taskId: 't1' } });
    expect(response.body.ok).toBe(true);
    expect(executed.map((call) => call.action)).toEqual(['schedule.delete']);
  });

  it('keeps each tool to its own actions, even with the token', async () => {
    process.versions.electron = '0.0.0-test';
    const { app, executed } = createApp({ OPENCHAMBER_AGENT_TOOL_TOKEN: TOKEN });
    const calls = [
      { tool: 'browser', action: 'session.create' },
      { tool: 'geocode', action: 'browser.open' },
      { tool: 'geocode', action: 'memory.read' },
      // Upstream keeps this one from agents too: schedule.list already carries the scheduler status.
      { tool: 'geocode', action: 'schedule.status' },
      { tool: 'openchamber', action: 'session.create' },
      { tool: undefined, action: 'browser.open' },
    ];
    for (const { tool, action } of calls) {
      const response = await post(app, TOKEN, { tool, input: { action } });
      const message = response.body.error?.message ?? '';
      expect([tool, action, response.status, response.body.ok, /GeoCode/.test(message)]).toEqual([tool, action, 200, false, true]);
    }
    expect(executed).toEqual([]);
  });

  it('answers a name it cannot resolve with the actions of the calling tool alone', async () => {
    process.versions.electron = '0.0.0-test';
    const { app, executed } = createApp({ OPENCHAMBER_AGENT_TOOL_TOKEN: TOKEN });
    // Upstream answers an unresolved name by listing every action it knows, which here would
    // advertise the memory surface the desktop leaves closed, and the other tool's actions.
    const cases = [
      { tool: 'browser', listed: 'browser.click', absent: ['session.', 'schedule.', 'memory.', 'projects.', 'models.'] },
      { tool: 'geocode', listed: 'session.create', absent: ['browser.', 'memory.'] },
    ];
    for (const { tool, listed, absent } of cases) {
      const response = await post(app, TOKEN, { tool, input: { action: 'nonsense' } });
      const message = response.body.error.message;
      expect([tool, response.body.ok, message.includes(listed), message.includes('OpenChamber')]).toEqual([tool, false, true, false]);
      for (const closed of absent) {
        expect([tool, closed, message.includes(closed)]).toEqual([tool, closed, false]);
      }
    }
    expect(executed).toEqual([]);
  });

  it('refuses a wrong token', async () => {
    process.versions.electron = '0.0.0-test';
    const { app } = createApp({ OPENCHAMBER_AGENT_TOOL_TOKEN: TOKEN });
    await post(app, 'someone-else', { tool: 'browser', input: { action: 'browser.open' } }).expect(401);
  });

  it('control: outside Electron the environment token is not adopted', async () => {
    delete process.versions.electron;
    const { app } = createApp({ OPENCHAMBER_AGENT_TOOL_TOKEN: TOKEN });
    await post(app, TOKEN, { tool: 'browser', input: { action: 'browser.open' } }).expect(401);
  });
});
