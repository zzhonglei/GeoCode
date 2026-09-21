/* --- GeoCode: proves the setup file is loaded and that a request goes to the server under test rather
 * than to whoever else holds that port number in the other address family (docs/CONVENTIONS.md). --- */
import { describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import request from 'supertest';

describe('the supertest address family', () => {
  it('reaches its own server even when a stranger holds the same port on IPv4', async () => {
    const app = express();
    app.get('/probe', (_req, res) => res.json({ mine: true }));

    // supertest binds `::` and takes a port there; a foreign IPv4-only listener may already hold the
    // same number. Without the setup file the request would land on the foreign one.
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const foreign = http.createServer((_req, res) => { res.statusCode = 501; res.end('foreign'); });
    const taken = await new Promise((resolve) => {
      foreign.once('error', () => resolve(false));
      foreign.listen(port, '127.0.0.1', () => resolve(true));
    });

    try {
      const response = await request(server).get('/probe').expect(200);
      expect([taken, response.body]).toEqual([taken, { mine: true }]);
    } finally {
      if (taken) await new Promise((resolve) => foreign.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
