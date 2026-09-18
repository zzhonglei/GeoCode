/* --- GeoCode: app.relaunch() reuses argv and the working directory, and main.mjs moves to the home directory at
 * import, so a development launch's relative entry has to be made absolute. --- */

import path from 'node:path';

export const relaunchOptions = ({ packaged, argv, entryFile }) => {
  if (packaged) return undefined;
  const [, entry, ...rest] = Array.isArray(argv) ? argv : [];
  if (typeof entry !== 'string' || !entry || path.isAbsolute(entry) || entry.startsWith('-')) return undefined;
  return { args: [entryFile, ...rest] };
};
