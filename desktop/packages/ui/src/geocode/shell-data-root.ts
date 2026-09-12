/* --- GeoCode: the shell's data root as the RENDERER must compute it (docs/PATHS.md §3.3).
 *
 * The renderer composes one storage path itself — the chats root — and it cannot read an
 * environment variable, so it cannot be told the root the way every server-side reader is. It rebuilds it from the home directory instead, which is
 * why `shell-data-root.mjs` roots the server's copy at HOME as well and spells `.config` out
 * rather than honouring `XDG_CONFIG_HOME`: whatever the renderer cannot compute, the two
 * halves will eventually disagree about.
 *
 * They did disagree. An earlier pass moved the server to an injected root while these paths
 * kept naming OpenChamber's, so GeoCode created its chats and per-project files inside the
 * other product's directory, and `managedProjectRoots` on the server — which decides which
 * project a chat session's memory belongs to — pointed somewhere those chats never appeared
 * (PATHS.md §5).
 *
 * The segments are one array and everything else derives from it. --- */

/** `.config/GeoCode` alone is the KERNEL's config root; the `desktop` segment keeps the
 *  shell's own data out of it, including on a filesystem that folds `geocode` into `GeoCode`. */
export const SHELL_DATA_ROOT_SEGMENTS = ['.config', 'GeoCode', 'desktop'] as const;

export const CHATS_SEGMENTS = [...SHELL_DATA_ROOT_SEGMENTS, 'chats'] as const;
