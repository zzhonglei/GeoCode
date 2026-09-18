/* --- GeoCode: keeps the shell on loopback (docs/DESKTOP.md §6.1). A settings file from an earlier build, or written
 * by hand, can still carry the remote access settings; main.mjs strips them before upstream picks the bind host. --- */

export const REMOTE_ACCESS_SETTING_KEYS = Object.freeze(['desktopLanAccessEnabled', 'desktopUiPassword']);

// Mutates in place: the caller holds the object under a const binding that upstream code reads.
export const stripRemoteAccessSettings = (settings) => {
  if (!settings || typeof settings !== 'object') return settings;
  for (const key of REMOTE_ACCESS_SETTING_KEYS) {
    delete settings[key];
  }
  return settings;
};

// Only an earlier build writes these: under Electron the relay service is inert (web/server/geocode/inert-relay.js).
export const RELAY_SETTING_KEYS = Object.freeze(['privateRelay', 'relaySigningKey', 'relayEncryptionKey']);

export const hasRelaySettings = (settings) =>
  Boolean(settings) && typeof settings === 'object' && RELAY_SETTING_KEYS.some((key) => key in settings);

export const dropRelaySettings = (settings) => {
  if (!settings || typeof settings !== 'object') return settings;
  for (const key of RELAY_SETTING_KEYS) {
    delete settings[key];
  }
  return settings;
};
