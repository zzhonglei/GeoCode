/* --- GeoCode: the origin the packaged renderer speaks from, as the server has to trust it.
 *
 * The desktop shell serves its bundled UI over its own scheme (`DesktopIdentity.uiProtocol`
 * in packages/electron/geocode/desktop-identity.mjs), so every request from that window
 * carries `Origin: geocode-ui://app`. Upstream's server trusts its own `openchamber-ui://app`
 * by literal in two places, and a renderer on any other scheme gets no CORS headers: every
 * fetch fails and the UI reports the server as unreachable. Measured on 2026-09-04.
 *
 * This is a copy, not an import: `web` is a dependency of `electron` and not the reverse
 * (CONVENTIONS.md §3). `desktop-identity.test.mjs` reads this file and fails when the two
 * drift. --- */

/** Mirrors `${DesktopIdentity.uiProtocol}://app`. */
export const PACKAGED_UI_ORIGIN = 'geocode-ui://app';
