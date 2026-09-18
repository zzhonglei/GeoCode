/* --- GeoCode: where the embedded Agent Kernel keeps its files, as the shell has to compute them
 * (docs/PATHS.md §5). --- */

import os from 'node:os';
import path from 'node:path';

// Hand-copies of `Brand.dirName` and `Brand.name` (core/src/brand.ts), which `web` cannot import;
// kernel-roots.test.js compares them.
const DIR_NAME = 'GeoCode';
const NAME = 'geocode';

/** Mirrors `Brand.projectMarker`, the file the kernel writes inside a repo's `.git`. */
export const KERNEL_PROJECT_MARKER = NAME;

/** Mirror `Brand.configJson`, `configJsonc` and `projectDir`, or the shell edits config the kernel never loads. */
export const KERNEL_CONFIG_JSON = `${NAME}.json`;
export const KERNEL_CONFIG_JSONC = `${NAME}.jsonc`;
export const KERNEL_PROJECT_DIR = `.${NAME}`;

/** The branch prefix when the caller names none; it lands in the user's own repository. */
export const WORKTREE_BRANCH_PREFIX = `${NAME}/`;

// XDG first, as the kernel's roots come from `xdg-basedir`; resolved per call so tests can redirect the environment.
const xdgRoot = (variable, ...fallbackSegments) =>
  process.env[variable] || path.join(os.homedir(), ...fallbackSegments);

export const kernelDataRoot = () => path.join(xdgRoot('XDG_DATA_HOME', '.local', 'share'), DIR_NAME);

export const kernelConfigRoot = () => path.join(xdgRoot('XDG_CONFIG_HOME', '.config'), DIR_NAME);

export const kernelCacheRoot = () => path.join(xdgRoot('XDG_CACHE_HOME', '.cache'), DIR_NAME);
