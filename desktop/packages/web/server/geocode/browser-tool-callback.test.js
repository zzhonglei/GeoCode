/* --- GeoCode: the callback route accepts the token the main process minted and nothing but
 * browser actions (docs/DESKTOP.md §7.2).
 *
 * Driven over a real loopback socket, because `authorize` checks the peer address as well as the
 * bearer token. Under Electron the runtime adopts the token from its environment; a control
 * action carrying that token is still refused. The control run without the Electron mark keeps
 * upstream's behaviour: no token was ever issued, so the route answers 401. --- */
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

describe('browser tool callback under Electron', () => {
  it('accepts the adopted token for a browser action and hands it to the control service', async () => {
    process.versions.electron = '0.0.0-test';
    const { app, executed } = createApp({ OPENCHAMBER_AGENT_TOOL_TOKEN: TOKEN });
    const response = await post(app, TOKEN, { tool: 'browser', input: { action: 'browser.open', url: 'https://example.com' } });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(executed.map((call) => call.action)).toEqual(['browser.open']);
  });

  it('refuses a control action even with the token', async () => {
    process.versions.electron = '0.0.0-test';
    const { app, executed } = createApp({ OPENCHAMBER_AGENT_TOOL_TOKEN: TOKEN });
    const response = await post(app, TOKEN, { tool: 'openchamber', input: { action: 'session.create' } });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.message).toMatch(/GeoCode/);
    expect(executed).toEqual([]);
  });

  it('answers a name it cannot resolve with the browser actions alone', async () => {
    process.versions.electron = '0.0.0-test';
    const { app, executed } = createApp({ OPENCHAMBER_AGENT_TOOL_TOKEN: TOKEN });
    const response = await post(app, TOKEN, { tool: 'browser', input: { action: 'nonsense' } });
    expect(response.body.ok).toBe(false);
    expect(response.body.error.message).toMatch(/GeoCode/);
    // Upstream answers an unresolved name by listing every action it knows, which here would
    // advertise the control and memory surface the desktop closed.
    expect(response.body.error.message).not.toContain('OpenChamber');
    for (const closed of ['session.', 'schedule.', 'memory.', 'projects.', 'models.']) {
      expect([closed, response.body.error.message.includes(closed)]).toEqual([closed, false]);
    }
    expect(response.body.error.message).toContain('browser.click');
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
