import crypto from 'node:crypto';

// Only password mode makes upstream authenticate every socket; nobody types or uses this password.
export const localServerPassword = crypto.randomBytes(32).toString('base64url');

let clientToken = '';

export const localClientToken = () => clientToken;

// Created without expiresAt under a fixed dedupeKey, so it lasts until the next launch replaces it.
export const mintLocalClientToken = async (serverHandle) => {
  const created = await serverHandle.remoteClientAuthRuntime.createClient({
    label: 'GeoCode',
    clientKind: 'desktop-local',
    dedupeKey: 'geocode-desktop',
  });
  clientToken = created.token;
};
