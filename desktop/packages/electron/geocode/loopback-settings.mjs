/* --- GeoCode: the shell listens on loopback only (docs/DESKTOP.md §6.1).
 *
 * Upstream reads two settings when it spawns the local server, `desktopLanAccessEnabled` and
 * `desktopUiPassword`, and binds every interface when both are set. GeoCode offers neither
 * setting, but a settings file written by an earlier build, or by hand, can still carry them.
 * main.mjs strips them from the parsed settings before the bind host is chosen, so the
 * upstream lines that follow see the "off" state: loopback bind, no UI password, and the local
 * window never lands behind a login page. --- */

export const REMOTE_ACCESS_SETTING_KEYS = Object.freeze(['desktopLanAccessEnabled', 'desktopUiPassword']);

// Mutates in place: the caller holds the object under a const binding that upstream code reads.
export const stripRemoteAccessSettings = (settings) => {
  if (!settings || typeof settings !== 'object') return settings;
  for (const key of REMOTE_ACCESS_SETTING_KEYS) {
    delete settings[key];
  }
  return settings;
};
