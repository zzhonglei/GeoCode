/* --- GeoCode: the skills catalog is not a desktop-shell surface (docs/DESKTOP.md §7.3).
 *
 * Upstream's catalog installs skills from git repositories it curates. GeoCode will offer its
 * own library instead, so the settings page is unavailable and these four routes answer 404
 * before upstream's handlers see the request. Skills themselves stay: creating, editing and
 * deleting them go through the other routes in `skill-routes.js`, which are untouched.
 * Registered at the top of `registerSkillRoutes` rather than by an early return, because the
 * same function also carries those other routes, and because `/api/config/skills/:name` would
 * otherwise match `catalog` (the same shape as snippet-surface.js). Refused by method, as upstream
 * registers them, so a skill named `scan` or `install` still reaches the `:name` routes. --- */

export const SKILL_CATALOG_ROUTES = Object.freeze([
  ['get', '/api/config/skills/catalog'],
  ['get', '/api/config/skills/catalog/source'],
  ['post', '/api/config/skills/scan'],
  ['post', '/api/config/skills/install'],
]);

export const refuseSkillCatalogRoutesUnderElectron = (app) => {
  if (!process.versions.electron) return false;
  for (const [method, routePath] of SKILL_CATALOG_ROUTES) {
    app[method](routePath, (_req, res) => {
      res.status(404).json({ error: 'Not available in GeoCode' });
    });
  }
  return true;
};
