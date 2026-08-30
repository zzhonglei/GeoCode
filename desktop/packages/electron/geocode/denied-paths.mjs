/* --- GeoCode: the paths `desktop_read_file` must refuse, on top of upstream's list
 * (docs/PATHS.md §3.3).
 *
 * That handler's own comment states the threat: it is defence in depth behind the IPC origin
 * gate, so that "even our own UI (or a prompt-injected agent) can't read credential stores".
 * Upstream's list names `.config/openchamber/credentials`, a path OpenChamber never creates —
 * its actual credential files sit directly in the data root — so that entry has always guarded
 * nothing. Ours moved to GeoCode's roots in the identity work and the guard did not follow, so
 * the list below names the files that really hold secrets.
 *
 * Two roots, because the shell and the kernel keep credentials in different places: the shell's
 * are under its data root in `.config`, the kernel's `auth.json` — every provider API key the
 * user has authorised — is under the XDG DATA root, not the config one.
 *
 * ⚠️ Matched as paths relative to $HOME, which is all the handler has. A user who moves
 * `XDG_DATA_HOME` or `XDG_CONFIG_HOME` elsewhere puts those files outside these strings; the
 * handler already refuses anything outside $HOME and tmpdir, so the exposure is bounded, but
 * this list cannot see such a move. Upstream's entries have the same limit.
 *
 * The foreign roots are here too. GeoCode has no reason to read another product's directories
 * at all, so denying them costs nothing and closes the same class of request. --- */

import path from 'node:path';

import { DesktopIdentity } from './desktop-identity.mjs';
import { resolveShellDataRoot } from './shell-data-root.mjs';

/** What the shell keeps under its data root, by name. */
const SHELL_CREDENTIALS = ['jwt-secret', 'ui-passkeys.json', 'github-auth.json', 'quota'];

/** Other products' roots, which nothing here should ever be reading. */
const FOREIGN_ROOTS = ['.config/opencode', '.local/share/opencode', '.opencode', '.config/openchamber'];

const relativeToHome = (homeDirectory, absolute) =>
  path.relative(homeDirectory, absolute).split(path.sep).join('/');

/**
 * Segments relative to `homeDirectory`, `/`-separated. A segment matches itself and anything
 * beneath it, which is the rule the handler applies.
 *
 * The shell's paths are DERIVED from `resolveShellDataRoot` rather than spelled out, because a
 * root that moves while its guard stays put is the exact failure this file was added for.
 */
export const geocodeDeniedSegments = (homeDirectory) => {
  const shellRoot = relativeToHome(homeDirectory, resolveShellDataRoot(homeDirectory));
  return [
    // The kernel's provider credentials. `auth/index.ts` composes `Global.Path.data/auth.json`,
    // which is the XDG DATA root and not the config one — listing it beside the shell's `.config`
    // paths is the mistake to avoid. `.local/share` is spelled out because this list is matched
    // relative to $HOME and so cannot follow `XDG_DATA_HOME` anyway; the handler already refuses
    // everything outside $HOME, which bounds what that costs.
    `.local/share/${DesktopIdentity.dirName}/auth.json`,
    ...SHELL_CREDENTIALS.map((name) => `${shellRoot}/${name}`),
    ...FOREIGN_ROOTS,
  ];
};
