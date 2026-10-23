import express from 'express';

import { streamGeoEngine } from './geo-tools.js';

export const GEO_STATUS_EVENT = 'geocode:geo-status';

const STATUS_BY_CODE = new Map([['invalid-params', 400], ['config-unreadable', 409], ['unavailable', 503]]);

// Without geoEngine, as when the server runs outside the desktop app, there are no statuses and no requests.
export const registerGeoEngine = (app, { geoEngine, broadcast }) => {
  // One count for the snapshot and the changes, so the interface can tell which is newer.
  let revision = 0;
  geoEngine?.onStatus((domain, value) => {
    revision += 1;
    broadcast({ type: GEO_STATUS_EVENT, properties: { revision, domain, value } });
  });

  // `engine` tells a window whether to wait for statuses at all: a shell server run outside Electron has no GeoEngine.
  app.get('/api/geocode/geo-status', (_req, res) => {
    res.json({ revision, statuses: geoEngine?.statuses() ?? {}, engine: Boolean(geoEngine) });
  });

  const answer = async (res, method, params) => {
    const response = await (geoEngine?.request(method, params) ?? Promise.reject(new Error('GeoEngine is not part of this server.')))
      .catch((error) => ({ ok: false, error: { code: 'unavailable', message: error.message } }));
    if (response.ok) {
      res.json(response.result ?? {});
      return;
    }
    res.status(STATUS_BY_CODE.get(response.error.code) ?? 500).json({ error: response.error.message, code: response.error.code });
  };

  // Named requests only, never a passthrough: the interface reaches no method it has no page for.
  app.get('/api/geocode/qgis/installs', (_req, res) => answer(res, 'qgis.discover'));
  app.put('/api/geocode/qgis', express.json({ limit: '64kb' }), (req, res) => answer(res, 'qgis.configure', { path: req.body?.path }));
  app.post('/api/geocode/qgis/recheck', (_req, res) => answer(res, 'qgis.recheck'));

  app.put('/api/geocode/gee', express.json({ limit: '64kb' }), (req, res) => answer(res, 'gee.configure', { project: req.body?.project }));
  app.post('/api/geocode/gee/recheck', (_req, res) => answer(res, 'gee.recheck'));
  app.get('/api/geocode/gee/quota', (_req, res) => answer(res, 'gee.quota'));
  // Waits for the user in the browser, reporting the address to open first; leaving the page's request cancels it.
  app.post('/api/geocode/gee/sign-in', (_req, res) => streamGeoEngine(res, geoEngine, 'gee.signIn', {}));
};
