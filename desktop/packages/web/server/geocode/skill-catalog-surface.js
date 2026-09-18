/* --- GeoCode: the skills catalog is not a desktop-shell surface; skill-routes.js registers this refusal ahead
 * of upstream's catalog handlers (docs/DESKTOP.md §7.3). --- */

export const SKILL_CATALOG_ROUTES = Object.freeze([
  ['get', '/api/config/skills/catalog'],
  ['get', '/api/config/skills/catalog/source'],
  ['post', '/api/config/skills/scan'],
  ['post', '/api/config/skills/install'],
]);

export const refuseSkillCatalogRoutesUnderElectron = (app) => {
  if (!process.versions.electron) return false;
  for (const [method, routePath] of SKILL_CATALOG_ROUTES) {
    // By method, so a skill named `scan` or `install` still reaches the `:name` routes.
    app[method](routePath, (_req, res) => {
      res.status(404).json({ error: 'Not available in GeoCode' });
    });
  }
  return true;
};
