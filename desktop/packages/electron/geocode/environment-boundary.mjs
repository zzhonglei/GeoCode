/* --- GeoCode: strips at module load, because main.mjs imports this first: before its other imports evaluate and
 * before `isDev` reads the environment (docs/ENVIRONMENT.md §5.2). --- */

import electron from 'electron';

import { E2E_ALLOWLIST, LAUNCHER_ALLOWLIST, stripInheritedForeignVariables } from './kernel-environment.mjs';

// Outside Electron the default export is the binary's path string, which counts as packaged: the strict form.
const packaged = typeof electron === 'object' && typeof electron.app?.isPackaged === 'boolean'
  ? electron.app.isPackaged
  : true;

export const inheritedKeep = packaged ? [...E2E_ALLOWLIST] : [...LAUNCHER_ALLOWLIST, ...E2E_ALLOWLIST];

stripInheritedForeignVariables(process.env, { keep: inheritedKeep });
