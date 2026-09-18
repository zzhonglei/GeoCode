/* --- GeoCode: the four skills catalog routes answer 404 under Electron (docs/DESKTOP.md §7.3). --- */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

import { SKILL_CATALOG_ROUTES, refuseSkillCatalogRoutesUnderElectron } from './skill-catalog-surface.js';

const originalElectron = process.versions.electron;
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

afterEach(() => {
  if (originalElectron === undefined) delete process.versions.electron;
  else process.versions.electron = originalElectron;
});

const createApp = () => {
  const reached = [];
  const app = express();
  refuseSkillCatalogRoutesUnderElectron(app);
  for (const [method, routePath] of SKILL_CATALOG_ROUTES) {
    app[method](routePath, (_req, res) => { reached.push(routePath); res.json({ ok: true }); });
  }
  for (const method of ['get', 'patch', 'delete']) {
    app[method]('/api/config/skills/:name', (req, res) => { reached.push(`${req.method} :name`); res.json({ ok: true }); });
  }
  return { app, reached };
};

describe('skill catalog surface', () => {
  it('answers 404 under Electron and never reaches a handler', async () => {
    process.versions.electron = '0.0.0-test';
    const { app, reached } = createApp();
    for (const [method, routePath] of SKILL_CATALOG_ROUTES) {
      // The body tells the refusal apart from Express answering 404 for a route nobody registered.
      const response = await request(app)[method](routePath).expect(404);
      expect([routePath, response.body]).toEqual([routePath, { error: 'Not available in GeoCode' }]);
    }
    expect(reached).toEqual([]);
  });

  it('control: outside Electron every route reaches its handler', async () => {
    delete process.versions.electron;
    const { app, reached } = createApp();
    for (const [method, routePath] of SKILL_CATALOG_ROUTES) {
      await request(app)[method](routePath).expect(200);
    }
    expect(reached).toEqual(SKILL_CATALOG_ROUTES.map(([, routePath]) => routePath));
  });

  it('leaves the skills themselves alone, including ones named like a catalog route', async () => {
    process.versions.electron = '0.0.0-test';
    const { app, reached } = createApp();
    await request(app).get('/api/config/skills/crs').expect(200);
    await request(app).get('/api/config/skills/scan').expect(200);
    await request(app).patch('/api/config/skills/install').expect(200);
    await request(app).delete('/api/config/skills/catalog').expect(200);
    expect(reached).toEqual(['GET :name', 'GET :name', 'PATCH :name', 'DELETE :name']);
  });

  it('skill-routes.js mounts the refusal ahead of the catalog handlers', () => {
    // The app above registers the refusal itself, so deleting the real call would leave it green.
    const source = fs.readFileSync(path.join(serverRoot, 'lib/opencode/skill-routes.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const refusal = source.indexOf('refuseSkillCatalogRoutesUnderElectron(app);');
    expect(refusal).toBeGreaterThan(-1);
    // Every fixed route under the skills prefix is a catalog route, so a new one fails here until it is judged.
    const fixedRoutes = [...source.matchAll(/app\.(get|post|put|patch|delete)\('(\/api\/config\/skills\/[^:'][^']*)'/g)]
      .map(([, method, routePath]) => [method, routePath]);
    expect(fixedRoutes).toEqual(SKILL_CATALOG_ROUTES.map(([method, routePath]) => [method, routePath]));
    for (const [method, routePath] of SKILL_CATALOG_ROUTES) {
      const handler = source.indexOf(`app.${method}('${routePath}'`);
      expect([method, routePath, handler > refusal]).toEqual([method, routePath, true]);
    }
  });
});
