import express from 'express';

export const GEO_TOOL_PATH = '/api/geocode/geo-tool';

// The GeoEngine methods the kernel's geo tools call; nothing else reaches GeoEngine this way.
const TOOL_METHODS = new Set(['qgis.doc', 'qgis.read', 'qgis.locate', 'qgis.prepare', 'qgis.run', 'gee.check', 'gee.run']);

/**
 * Answers with a GeoEngine request that takes a while: lines of JSON, its progress and then its result. A request closed
 * early cancels it.
 */
export const streamGeoEngine = async (res, geoEngine, method, params) => {
  const controller = new AbortController();
  const cancel = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once('close', cancel);
  res.status(200).type('application/x-ndjson');
  // Each line as it comes, should a compression ever buffer the answer.
  const write = (line) => {
    res.write(`${JSON.stringify(line)}\n`);
    res.flush?.();
  };
  const options = { signal: controller.signal, onProgress: (data) => write({ type: 'progress', data }) };
  const response = await (geoEngine?.request(method, params, options) ?? Promise.reject(new Error('GeoEngine is not part of this server.')))
    .catch((error) => ({ ok: false, error: { code: 'unavailable', message: error.message } }));
  res.off('close', cancel);
  write(response.ok ? { type: 'result', ok: true, result: response.result } : { type: 'result', ok: false, error: response.error });
  res.end();
};

/**
 * GeoAgent's geo tools reach GeoEngine here. Like the agent tools' callback, it is registered before the API auth gate
 * and takes the kernel's callback token, which the kernel holds and a window does not. The kernel has decided the
 * permission before it calls, so this only checks who is calling. The answer streams, as streamGeoEngine's does.
 */
export const registerGeoTools = (app, { geoEngine, authorize }) => {
  app.post(GEO_TOOL_PATH, express.json({ limit: '1mb' }), async (req, res) => {
    if (!authorize(req)) return res.status(401).json({ error: 'Unauthorized' });
    const method = req.body?.method;
    if (!TOOL_METHODS.has(method)) return res.status(400).json({ error: `GeoEngine offers no geo tool method ${method}` });
    await streamGeoEngine(res, geoEngine, method, req.body?.params);
  });
};
