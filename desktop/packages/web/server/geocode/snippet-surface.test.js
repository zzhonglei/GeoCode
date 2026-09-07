/* --- GeoCode: the six snippet routes answer 404 under Electron (docs/DESKTOP.md §7.3).
 *
 * Driven over a real Express app with the refusal registered ahead of stand-in handlers that
 * record a hit, which is what upstream's own registrations are: if the refusal ever stops
 * winning the match, the stand-in records and the test fails. The control run without the
 * Electron mark must reach every handler, or the guard proves nothing. --- */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';

import { SNIPPET_ROUTE_PATHS, refuseSnippetRoutesUnderElectron } from './snippet-surface.js';

const originalElectron = process.versions.electron;

afterEach(() => {
  if (originalElectron === undefined) delete process.versions.electron;
  else process.versions.electron = originalElectron;
});

const createApp = () => {
  const reached = [];
  const app = express();
  refuseSnippetRoutesUnderElectron(app);
  for (const routePath of SNIPPET_ROUTE_PATHS) {
    app.all(routePath, (_req, res) => { reached.push(routePath); res.json({ ok: true }); });
  }
  return { app, reached };
};

describe('snippet surface', () => {
  it('answers 404 under Electron and never reaches a handler', async () => {
    process.versions.electron = '0.0.0-test';
    const { app, reached } = createApp();
    await request(app).get('/api/config/snippets').expect(404);
    await request(app).post('/api/config/snippets/expand').expect(404);
    await request(app).get('/api/config/snippets/crs').expect(404);
    await request(app).post('/api/config/snippets/crs').expect(404);
    await request(app).patch('/api/config/snippets/crs').expect(404);
    await request(app).delete('/api/config/snippets/crs').expect(404);
    expect(reached).toEqual([]);
  });

  it('control: outside Electron every route reaches its handler', async () => {
    delete process.versions.electron;
    const { app, reached } = createApp();
    await request(app).get('/api/config/snippets').expect(200);
    await request(app).delete('/api/config/snippets/crs').expect(200);
    expect(reached.length).toBe(2);
  });
});
