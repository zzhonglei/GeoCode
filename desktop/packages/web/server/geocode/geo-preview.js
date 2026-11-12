// What a failure answers with; any other code of GeoEngine's or of a dataset's reader answers 500, with the code.
const STATUS_BY_CODE = new Map([
  ['invalid-params', 400],
  ['missing', 404],
  ['changed', 409],
  ['not-ready', 503],
  ['unavailable', 503],
]);

/**
 * What a window's preview of a geographic dataset asks for: the dataset's description, the tiles of its map, the
 * feature or the pixel under a click, the pages of its table and what its bands measure, each read by GeoEngine as it
 * is asked for. A request the window
 * leaves is cancelled there, so a map that has moved on reads nothing for where it was. Without geoEngine, as when
 * the server runs outside the desktop app, every request is refused.
 */
export const registerGeoPreview = (app, { geoEngine }) => {
  const ask = async (req, res, method, params) => {
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', cancel);
    // GeoEngine checks the values; here they only become what the address could not say they are.
    const asked = { path: req.query.path, ...params };
    if (req.query.layer !== undefined) asked.layer = req.query.layer;
    const response = await (geoEngine?.request(method, asked, { signal: controller.signal }) ?? Promise.reject(new Error('GeoEngine is not part of this server.')))
      .catch((error) => ({ ok: false, error: { code: 'unavailable', message: error.message } }));
    res.off('close', cancel);
    if (controller.signal.aborted) return undefined;
    if (response.ok) return response.result;
    res.status(STATUS_BY_CODE.get(response.error.code) ?? 500).json({ error: response.error.message, code: response.error.code });
    return undefined;
  };

  // An empty value would read as zero.
  const number = (value) => (value === '' ? NaN : Number(value));
  // What is not JSON stays the text it is, for GeoEngine to refuse.
  const parsed = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  // Named requests only, as the environment's are: the window reaches no other method of GeoEngine through these.
  app.get('/api/geocode/preview/describe', async (req, res) => {
    const result = await ask(req, res, 'preview.describe', {});
    if (result) res.json(result);
  });

  app.get('/api/geocode/preview/tile', async (req, res) => {
    const { stamp, z, x, y, fid, look } = req.query;
    const tile = { stamp, z: number(z), x: number(x), y: number(y) };
    // The one feature the tile is of, where it is the mark of the feature that is picked.
    if (fid !== undefined) tile.fid = number(fid);
    // How the interface wants a raster drawn, where it says.
    if (look !== undefined) tile.look = parsed(look);
    const result = await ask(req, res, 'preview.tile', tile);
    if (!result) return;
    // Nothing of the dataset lies in this tile.
    if (!result.bytes) return res.status(204).end();
    // As bytes: the interface knows from the description whether they are a picture or vectors.
    res.type('application/octet-stream').send(Buffer.from(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength));
  });

  app.get('/api/geocode/preview/identify', async (req, res) => {
    const { stamp, x, y, tolerance, forms, fid } = req.query;
    // The feature of a number, or the one under a click.
    const asked = fid !== undefined ? { stamp, fid: number(fid) } : { stamp, x: number(x), y: number(y), tolerance: number(tolerance) };
    // Those of the layer's points, lines and polygons that are shown, when not all are.
    if (fid === undefined && forms !== undefined) asked.forms = String(forms).split(',');
    const result = await ask(req, res, 'preview.identify', asked);
    if (result) res.json(result);
  });

  app.get('/api/geocode/preview/pixel', async (req, res) => {
    const result = await ask(req, res, 'preview.pixel', { stamp: req.query.stamp, x: number(req.query.x), y: number(req.query.y) });
    if (result) res.json(result);
  });

  app.get('/api/geocode/preview/statistics', async (req, res) => {
    const result = await ask(req, res, 'preview.statistics', { stamp: req.query.stamp });
    if (result) res.json(result);
  });

  app.get('/api/geocode/preview/rows', async (req, res) => {
    const result = await ask(req, res, 'preview.rows', { stamp: req.query.stamp, row: number(req.query.row) });
    if (result) res.json(result);
  });
};
