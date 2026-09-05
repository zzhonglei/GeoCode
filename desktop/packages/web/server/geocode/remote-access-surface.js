/* --- GeoCode: device pairing is not a desktop-shell surface (docs/DESKTOP.md §7.3).
 *
 * Pairing is how a phone or another desktop obtains a long-lived client token from this
 * server, over LAN, tunnel or relay. None of those transports exists in the desktop shell, so
 * under Electron the pairing routes answer 404 before upstream's handlers see the request.
 * The paired-client list routes stay: they are read-only, and with no pairing they are empty.
 * core-routes.js calls this ahead of the handlers, so Express order does the rest. --- */

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
