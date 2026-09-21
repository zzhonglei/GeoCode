/* --- GeoCode: what `desktop_read_file` refuses beyond upstream's list (docs/PATHS.md §5). Matched relative to
 * $HOME, which is all the handler has, so a moved XDG_DATA_HOME or XDG_CONFIG_HOME escapes these strings; the
 * handler already refuses anything outside $HOME and the temp directory. --- */

import path from 'node:path';

import { DesktopIdentity } from './desktop-identity.mjs';
import { resolveShellDataRoot } from './shell-data-root.mjs';

const SHELL_CREDENTIALS = ['jwt-secret', 'ui-passkeys.json', 'github-auth.json', 'quota'];

const FOREIGN_ROOTS = ['.config/opencode', '.local/share/opencode', '.opencode', '.config/openchamber'];

const relativeToHome = (homeDirectory, absolute) =>
  path.relative(homeDirectory, absolute).split(path.sep).join('/');

/**
 * `/`-separated segments relative to `homeDirectory`, each matching itself and anything beneath it. The shell's
 * are derived from `resolveShellDataRoot` so that the guard moves with the root.
 */
export const geocodeDeniedSegments = (homeDirectory) => {
  const shellRoot = relativeToHome(homeDirectory, resolveShellDataRoot(homeDirectory));
  return [
    // The kernel's provider credentials, under the XDG data root rather than the config root (auth/index.ts).
    `.local/share/${DesktopIdentity.dirName}/auth.json`,
    ...SHELL_CREDENTIALS.map((name) => `${shellRoot}/${name}`),
    ...FOREIGN_ROOTS,
  ];
};

/**
 * Whether a `/`-separated path, already made relative to $HOME, falls under any denied segment. Folded,
 * like the basename check the handler applies right after: macOS and Windows resolve `.SSH/id_rsa` and
 * `.local/share/geocode/auth.json` to the same files these segments name, so comparing exactly refuses one
 * spelling and allows every other. The cost is refusing a genuinely different `.SSH` on a case-sensitive
 * filesystem, which is a refused read rather than a leak.
 */
export const deniesRelativePath = (relativePath, segments) => {
  const candidate = String(relativePath).toLowerCase();
  return segments.some((segment) => {
    const denied = String(segment).toLowerCase();
    return candidate === denied || candidate.startsWith(`${denied}/`);
  });
};
