/* --- GeoCode: where the embedded Agent Kernel keeps its files, as the shell has to compute
 * them (docs/PATHS.md §3.1).
 *
 * Four upstream call sites reach into `~/.local/share/opencode` and `~/.config/opencode` —
 * for `auth.json`, the antigravity accounts, the worktree root, and the project-id marker
 * inside a repo's `.git`. On a machine that also runs OpenCode those are a *different
 * product's* files: the app reads the user's real credentials, and `writeAuthFile` leaves a
 * `.openchamber.backup` copy of them behind. Pointing all four here makes them the kernel's
 * own files instead.
 *
 * XDG is honoured even though two of those call sites resolved the home directory directly.
 * The kernel takes its roots from `xdg-basedir` (`core/src/global.ts`), so a hardcoded home
 * splits the pair the moment `XDG_DATA_HOME` is set — the shell reading one `auth.json`
 * while the kernel writes another, and nothing fails. The dev sandbox sets exactly that
 * variable, so the split is reachable today, not hypothetical.
 *
 * The roots resolve on call rather than at import so a test can redirect the environment.
 * Consumers that capture the result in a module-level constant keep upstream's timing.
 *
 * The two base strings mirror `core/src/brand.ts`. This is a copy, not an import: `web` is a
 * dependency of `electron` and not the reverse (CONVENTIONS.md §3), and the kernel is a
 * separate install root. A copy across files is the case CONVENTIONS.md §5 keeps a tripwire
 * for — the two drift with no conflict and no failure — so `kernel-roots.test.js` reads
 * brand.ts and fails when they disagree. --- */

import os from 'node:os';
import path from 'node:path';

/** Mirrors `Brand.dirName`: the cased namespace under each XDG root. */
const DIR_NAME = 'GeoCode';
/** Mirrors `Brand.name`: the lowercase base for file and network identifiers. */
const NAME = 'geocode';

/** Mirrors `Brand.projectMarker`, the file the kernel writes inside a repo's `.git`. */
export const KERNEL_PROJECT_MARKER = NAME;

/**
 * Mirrors `Brand.configJson` / `Brand.configJsonc` / `Brand.projectDir`. The kernel loads its
 * global config from `config.json` (unbranded, kept from upstream) plus these two, and finds
 * project config by walking up for a directory named `KERNEL_PROJECT_DIR` — so the shell has
 * to name all three the same way or it reads and writes a config the kernel never loads.
 */
export const KERNEL_CONFIG_JSON = `${NAME}.json`;
export const KERNEL_CONFIG_JSONC = `${NAME}.jsonc`;
export const KERNEL_PROJECT_DIR = `.${NAME}`;

const xdgRoot = (variable, ...fallbackSegments) =>
  process.env[variable] || path.join(os.homedir(), ...fallbackSegments);

export const kernelDataRoot = () => path.join(xdgRoot('XDG_DATA_HOME', '.local', 'share'), DIR_NAME);

export const kernelConfigRoot = () => path.join(xdgRoot('XDG_CONFIG_HOME', '.config'), DIR_NAME);

export const kernelCacheRoot = () => path.join(xdgRoot('XDG_CACHE_HOME', '.cache'), DIR_NAME);
