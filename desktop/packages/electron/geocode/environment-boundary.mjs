/* --- GeoCode: the first import of main.mjs, so this evaluates before anything else in it:
 * before the shell runtime modules its static imports pull in, and before `isDev` reads the
 * environment (docs/ENVIRONMENT.md §5.2). Module load is the only point early enough, and an
 * import is the only statement that runs there. --- */

import electron from 'electron';

import { E2E_ALLOWLIST, LAUNCHER_ALLOWLIST, stripInheritedForeignVariables } from './kernel-environment.mjs';

// Outside Electron the module resolves to a path string; treating that as packaged keeps the
// strict form the default everywhere but a real development launch.
const packaged = typeof electron === 'object' && typeof electron.app?.isPackaged === 'boolean'
  ? electron.app.isPackaged
  : true;

/** The branded names the strip leaves alone in this process, for every later strip to reuse. */
export const inheritedKeep = packaged ? [...E2E_ALLOWLIST] : [...LAUNCHER_ALLOWLIST, ...E2E_ALLOWLIST];

stripInheritedForeignVariables(process.env, { keep: inheritedKeep });
