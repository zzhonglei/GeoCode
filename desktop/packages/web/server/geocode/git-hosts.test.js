import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';

import { createSessionLinker } from '../lib/openchamber-sessions/session-link.js';
import { createSourceControlProviders } from '../lib/source-control/provider-registry.js';
import { createTrackerRegistry } from '../lib/trackers/registry.js';
import { registerTrackerRoutes } from '../lib/trackers/routes.js';

// Every surface reads its git hosts and trackers from these two registries: the settings cards and search items, the
// default hosts, link matching, the routes and the session links. The interface falls back to a built-in GitHub,
// GitLab and Linear list when the server answers 404, so the lists are served, and served short.

// Guards against a git host other than GitHub reaching the interface or loading its code.
describe('GeoCode: git hosts', () => {
  const providers = createSourceControlProviders();

  it('are GitHub alone, on github.com by default', () => {
    expect(providers.list().map((descriptor) => descriptor.id)).toEqual(['github']);
    expect(providers.list().flatMap((descriptor) => descriptor.instance.defaultInstances)).toEqual(['github.com']);
  });

  it('load no other host by its id', async () => {
    for (const id of ['gitlab', 'gitea', 'forgejo', 'gerrit']) {
      expect(await providers.implementation(id)).toBeNull();
    }
  });
});

// Guards against Linear, or a tracker upstream adds, reaching the interface, the session links or the session events.
describe('GeoCode: trackers', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    const app = express();
    registerTrackerRoutes(app, { registry: createTrackerRegistry() });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('are none, listed rather than refused', async () => {
    const response = await fetch(`${baseUrl}/api/tracker/providers`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ providers: [] });
  });

  it("refuse signing in to Linear by the trackers' routes", async () => {
    const response = await fetch(`${baseUrl}/api/tracker/linear/auth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(404);
  });

  it('leave a link to a Linear issue an ordinary link', async () => {
    const linker = createSessionLinker({
      trackers: createTrackerRegistry(),
      updateMetadata: async () => ({ changed: true }),
      createError: (message) => new Error(message),
    });
    const { linked } = await linker.link({
      sessionId: 'ses_1',
      link: { url: 'https://linear.app/team/issue/ABC-12/roads', title: 'Roads', kind: 'issue' },
    });
    expect(linked.kind).toBe('external');
  });
});
