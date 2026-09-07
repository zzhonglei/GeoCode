/* --- GeoCode: snippet management is not a desktop-shell surface (docs/DESKTOP.md §7.3).
 *
 * A snippet is a reusable block of prompt text that the shell substitutes for `#name` before the
 * message reaches the kernel. GeoCode does not offer it: the settings page is unavailable and
 * these six routes answer 404 before upstream's handlers see the request, so nothing in the app
 * can create one. `expandSnippets` itself stays — like every other module we keep but do not
 * expose — and with no way to create a snippet its registry is empty, which makes it a no-op.
 * They live inside `registerConfigEntityRoutes`, which also carries MCP, agent and command
 * routes, so the surface cannot be closed with an early return; Express order does it instead
 * (the same shape as remote-access-surface.js). --- */

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
