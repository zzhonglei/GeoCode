/* --- GeoCode: the origin the packaged renderer speaks from, which both server origin sets must trust
 * (docs/PATHS.md §3.4). --- */

/** Hand-copy of `${DesktopIdentity.uiProtocol}://app`, which `web` cannot import; desktop-identity.test.mjs pins it. */
export const PACKAGED_UI_ORIGIN = 'geocode-ui://app';
