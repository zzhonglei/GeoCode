/* --- GeoCode: where the shell runtime keeps its data (docs/PATHS.md §3.3).
 *
 * Upstream copied one ternary into a dozen files and every copy reads
 * `OPENCHAMBER_DATA_DIR`, so setting it once moves all of them; the few that hardcode the
 * path instead are patched to match, and the command that lists them is in DESKTOP.md §10.
 *
 * Three things about this function are deliberate:
 *
 * An inherited value is OVERWRITTEN, not respected. A user who runs OpenChamber has this
 * exported in the shell we inherit, and honouring it would put GeoCode's settings and
 * sessions inside their OpenChamber directory — the same reasoning that makes
 * kernel-environment.mjs strip inherited `OPENCODE_*`.
 *
 * It must run BEFORE anything resolves a settings path. `main.mjs` builds `sshManager` at
 * module top level and hands it a path string that is never recomputed, so injecting this
 * where the kernel connection is injected — just before the shell runtime is imported —
 * would be too late for main.mjs itself (PATHS.md §5).
 *
 * The root hangs off HOME, not off Electron's userData, and `.config` is spelled out rather
 * than read from `XDG_CONFIG_HOME`. Both are forced by the renderer: it composes the chats
 * and per-project config paths itself, it cannot read an environment variable, and there is
 * no route that would tell it a root. A root the renderer cannot compute is a root the two
 * halves disagree about — which is what happened when this returned a userData path while
 * `chatDirectories.ts` kept building one from HOME, and the chats the client created were
 * not the chats the server looked for (PATHS.md §5). Upstream rooted this at HOME for the
 * same reason. --- */

import path from 'node:path';

/** Cased namespace, matching `desktop-identity.mjs` and the kernel's `Brand.dirName`. */
const DIR_NAME = 'GeoCode';
/**
 * Subdirectory under the namespace. `.config/GeoCode` alone is the KERNEL's config root, and
 * a case-insensitive filesystem folds `geocode` into it, so the shell's settings and chats
 * would land among the agent's configuration.
 */
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
  // Its own variable, because the registry's fallback is hardcoded rather than derived from
  // the data root — setting only the root above would leave it writing to the old location.
  environment.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = path.join(root, MANAGED_PROCESS_DIRECTORY);
  return root;
};
