/* --- GeoCode: the shell's data root as the renderer rebuilds it from the home directory, for the chats root that
 * chatDirectories.ts falls back to and counts as ours; electron/geocode/shell-data-root.mjs must build the same path
 * (docs/PATHS.md §3.3). --- */

/** `.config/GeoCode` alone is the KERNEL's config root; the `desktop` segment keeps the
 *  shell's own data out of it, including on a filesystem that folds `geocode` into `GeoCode`. */
export const SHELL_DATA_ROOT_SEGMENTS = ['.config', 'GeoCode', 'desktop'] as const;

export const CHATS_SEGMENTS = [...SHELL_DATA_ROOT_SEGMENTS, 'chats'] as const;
