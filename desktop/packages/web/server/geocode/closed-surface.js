/* --- GeoCode: a surface the desktop shell closes answers 404 itself (docs/DESKTOP.md §7.3).
 *
 * Leaving its routes unregistered does not close it: the generic proxy mounted after every route
 * forwards any /api path nobody answered to the kernel, whose catch-all sends a path it does not
 * know on to https://app.opencode.ai. The whole prefix is taken, so a route upstream adds to the
 * group later is refused as well. --- */

export const refuseSurfaceUnderElectron = (app, prefix) => {
  if (!process.versions.electron) return false;
  app.use(prefix, (_req, res) => {
    res.status(404).json({ error: 'Not available in GeoCode' });
  });
  return true;
};
