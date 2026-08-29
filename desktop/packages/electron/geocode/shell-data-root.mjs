/* --- GeoCode: where the shell runtime keeps its data (docs/PATHS.md §3.3).
 *
 * Upstream copied one ternary into a dozen files and every copy reads
 * `OPENCHAMBER_DATA_DIR`, so setting it once moves all of them; the few that hardcode the
 * path instead are patched to match, and the command that lists them is in DESKTOP.md §10.
 *
 * Two things about this function are deliberate:
 *
 * An inherited value is OVERWRITTEN, not respected. A user who runs OpenChamber has this
 * exported in the shell we inherit, and honouring it would put GeoCode's settings and
 * sessions inside their OpenChamber directory — the same reasoning that makes
 * kernel-environment.mjs strip inherited `OPENCODE_*`.
 *
 * It must run BEFORE anything resolves a settings path. `main.mjs` builds `sshManager` at
 * module top level and hands it a path string that is never recomputed, so injecting this
 * where the kernel connection is injected — just before the shell runtime is imported —
 * would be too late for main.mjs itself (PATHS.md §5). --- */

import path from 'node:path';

/** Subdirectory under userData, so shell data does not sit beside Chromium's own files. */
const SHELL_DIRECTORY = 'desktop';
const MANAGED_PROCESS_DIRECTORY = 'managed-opencode';

export const resolveShellDataRoot = (userDataDirectory) => path.join(userDataDirectory, SHELL_DIRECTORY);

export const applyShellDataRoot = ({ environment, userDataDirectory }) => {
  if (typeof userDataDirectory !== 'string' || userDataDirectory.length === 0) {
    throw new Error('Cannot place the shell data root without a userData directory');
  }

  const root = resolveShellDataRoot(userDataDirectory);
  environment.OPENCHAMBER_DATA_DIR = root;
  // Its own variable, because the registry's fallback is hardcoded rather than derived from
  // the data root — setting only the root above would leave it writing to the old location.
  environment.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = path.join(root, MANAGED_PROCESS_DIRECTORY);
  return root;
};
