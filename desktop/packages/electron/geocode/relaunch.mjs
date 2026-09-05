/* --- GeoCode: what app.relaunch() needs to come back in a development launch.
 *
 * app.relaunch() reuses the original command line and the current working directory. main.mjs
 * changes its working directory to the home directory at import, and the development launcher
 * starts Electron with a relative entry (`./main.mjs`), so the relaunched instance looks for
 * `~/main.mjs`, finds nothing, and Electron shows its own "unable to find app" dialog instead
 * of the app. A packaged build carries no entry argument and is not affected. Both relaunch
 * sites in main.mjs pass these options; in a packaged build they are empty. --- */

import path from 'node:path';

export const relaunchOptions = ({ packaged, argv, entryFile }) => {
  if (packaged) return undefined;
  const [, entry, ...rest] = Array.isArray(argv) ? argv : [];
  if (typeof entry !== 'string' || !entry || path.isAbsolute(entry) || entry.startsWith('-')) return undefined;
  return { args: [entryFile, ...rest] };
};
