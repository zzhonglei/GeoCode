/* --- GeoCode: the product version (docs/DESKTOP.md §4.6).
 *
 * Upstream's release script rewrites five package.json `version` fields at once; those stay
 * upstream's and now only say which OpenChamber the shell is based on. GeoCode's own version
 * lives here and in the web package's hand-copy (server/geocode/app-version.js, the renderer
 * and the shell cannot import this package), kept equal by app-version.test.mjs and bumped
 * together by scripts/bump-geocode-version.mjs. --- */

export const GEOCODE_VERSION = '1.0.0';
