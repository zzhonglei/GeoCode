import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';

import { closedSurface } from './closed-surface.js';

// Guards against a closed endpoint staying reachable through a path variant
// that Express still routes to the upstream handler.
describe('GeoCode: closedSurface', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    const app = express();
    app.use(closedSurface);
    for (const route of ['/api/openchamber/update-check', '/api/push/subscribe', '/connect', '/api/client-auth/clients', '/api/push/visibility', '/api/plugin', '/api/plugin/check', '/api/magic-prompts/:id', '/api/config/snippets/expand', '/api/openchamber/spaces/switch', '/api/spaces/:id/session', '/api/config/skills/catalog/source', '/api/config/skills/:name', '/api/config/skills/:name/files/*filePath', '/api/projects/:projectId/config', '/api/projects/:projectId/config/shared', '/api/experimental/session/:sessionId/terminal']) {
      app.all(route, (_req, res) => res.status(200).send('upstream'));
    }
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const statusOf = async (path, method = 'GET') => (await fetch(`${baseUrl}${path}`, { method })).status;

  it('refuses closed endpoints in any case and with a trailing slash', async () => {
    for (const path of ['/api/openchamber/update-check', '/API/OpenChamber/Update-Check', '/api/push/subscribe/', '/CONNECT', '/API/Client-Auth/Clients', '/API/Plugin/Check', '/API/Magic-Prompts/git.commit.generate.visible', '/API/Config/Snippets/Expand', '/API/OpenChamber/Spaces/Switch', '/API/Spaces/space-1/session', '/API/Config/Skills/Catalog/Source/']) {
      expect(await statusOf(path)).toBe(404);
    }
  });

  it('leaves the endpoints the app still uses to upstream', async () => {
    expect(await statusOf('/api/push/visibility')).toBe(200);
    expect(await statusOf('/api/plugin')).toBe(200);
  });

  it('refuses the skill catalog read and the scan and install posts, not a skill of those names', async () => {
    for (const [path, method] of [['/api/config/skills/catalog', 'GET'], ['/API/Config/Skills/Catalog/', 'HEAD'], ['/api/config/skills/scan', 'POST'], ['/API/Config/Skills/Install/', 'POST']]) {
      expect(await statusOf(path, method)).toBe(404);
    }
    for (const [path, method] of [['/api/config/skills/scan', 'GET'], ['/API/Config/Skills/Install', 'PATCH'], ['/api/config/skills/scan', 'DELETE'], ['/api/config/skills/install/files/notes.md', 'PUT'], ['/api/config/skills/catalog', 'POST'], ['/api/config/skills/catalog', 'DELETE'], ['/api/config/skills/catalog/files/notes.md', 'GET'], ['/api/config/skills/geo', 'POST']]) {
      expect(await statusOf(path, method)).toBe(200);
    }
  });

  it('refuses writing the team-shared project setup, not the personal one', async () => {
    for (const path of ['/api/projects/path_L3JlcG8/config/shared', '/API/Projects/path_L3JlcG8/Config/Shared/']) {
      expect(await statusOf(path, 'PUT')).toBe(404);
    }
    expect(await statusOf('/api/projects/path_L3JlcG8/config', 'PUT')).toBe(200);
    expect(await statusOf('/api/projects/path_L3JlcG8/config/shared', 'GET')).toBe(200);
  });

  // The route is the kernel's: taken from its API description, so a move upstream fails here rather than reopening it.
  it('refuses creating a persistent terminal, not listing them', async () => {
    const api = JSON.parse(fs.readFileSync(new URL('../../../../../kernel/packages/protocol/openapi.json', import.meta.url), 'utf8'));
    const [route] = Object.entries(api.paths)
      .filter(([, operations]) => operations.post?.operationId === 'server.experimental.persistentPty.create')
      .map(([template]) => template.replace('{sessionID}', 'ses_1'));
    expect(await statusOf(route, 'POST')).toBe(404);
    expect(await statusOf(`${route.toUpperCase()}/`, 'POST')).toBe(404);
    expect(await statusOf(route, 'GET')).toBe(200);
  });
});
