/* --- GeoCode: device pairing is not a desktop-shell surface; core-routes.js registers this refusal ahead of
 * upstream's pairing handlers (docs/DESKTOP.md §7.3). --- */

export const PAIRING_ROUTE_PATHS = Object.freeze([
  '/api/client-auth/pairing/sessions',
  '/api/client-auth/pairing/sessions/:id',
  '/api/client-auth/pairing/transports',
  '/api/client-auth/pairing/redeem',
  '/api/client-auth/connection/candidates',
]);

export const refusePairingRoutesUnderElectron = (app) => {
  if (!process.versions.electron) return false;
  app.all([...PAIRING_ROUTE_PATHS], (_req, res) => {
    res.status(404).json({ error: 'Not available in GeoCode' });
  });
  return true;
};
