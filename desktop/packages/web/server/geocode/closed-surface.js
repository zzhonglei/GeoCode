/* --- GeoCode: a closed surface answers 404 itself, because the kernel proxy mounted after the routes forwards
 * any unanswered /api path; the whole prefix is taken so routes upstream adds later are refused too
 * (docs/DESKTOP.md §7.3). --- */

export const refuseSurfaceUnderElectron = (app, prefix) => {
  if (!process.versions.electron) return false;
  app.use(prefix, (_req, res) => {
    res.status(404).json({ error: 'Not available in GeoCode' });
  });
  return true;
};
