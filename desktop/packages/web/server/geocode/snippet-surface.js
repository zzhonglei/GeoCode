/* --- GeoCode: snippet management is not a desktop-shell surface; config-entity-routes.js registers this
 * refusal ahead of upstream's six snippet handlers (docs/DESKTOP.md §7.3). --- */

export const SNIPPET_ROUTE_PATHS = Object.freeze([
  '/api/config/snippets',
  '/api/config/snippets/expand',
  '/api/config/snippets/:name',
]);

export const refuseSnippetRoutesUnderElectron = (app) => {
  if (!process.versions.electron) return false;
  app.all([...SNIPPET_ROUTE_PATHS], (_req, res) => {
    res.status(404).json({ error: 'Not available in GeoCode' });
  });
  return true;
};
