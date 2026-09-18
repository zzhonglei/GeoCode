/* --- GeoCode: where the shell runtime keeps its data (docs/PATHS.md §3.3, §5). Rooted at HOME with `.config` spelled
 * out, not at userData or XDG_CONFIG_HOME, because the renderer rebuilds the same path from HOME
 * (ui/src/geocode/shell-data-root.ts). --- */

import path from 'node:path';

/** Cased, matching `desktop-identity.mjs` and the kernel's `Brand.dirName`. */
const DIR_NAME = 'GeoCode';
/** `.config/GeoCode` itself is the kernel's config root, and a case-insensitive filesystem folds `geocode` into it. */
const SHELL_DIRECTORY = 'desktop';
const MANAGED_PROCESS_DIRECTORY = 'managed-opencode';

export const resolveShellDataRoot = (homeDirectory) =>
  path.join(homeDirectory, '.config', DIR_NAME, SHELL_DIRECTORY);

export const applyShellDataRoot = ({ environment, homeDirectory }) => {
  if (typeof homeDirectory !== 'string' || homeDirectory.length === 0) {
    throw new Error('Cannot place the shell data root without a home directory');
  }

  const root = resolveShellDataRoot(homeDirectory);
  environment.OPENCHAMBER_DATA_DIR = root;
  // The registry's fallback does not read OPENCHAMBER_DATA_DIR.
  environment.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = path.join(root, MANAGED_PROCESS_DIRECTORY);
  return root;
};
