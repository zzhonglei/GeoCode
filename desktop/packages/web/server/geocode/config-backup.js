/* --- GeoCode: the suffix the shell leaves beside a file it is about to overwrite
 * (docs/PATHS.md §3.2).
 *
 * Two call sites make such a copy — `writeConfig` for the config layers and `writeAuthFile` for
 * the credentials — and the config layers include the project one, so upstream's name lands in
 * the user's own repository beside `geocode.json`. Nothing reads the copy back; it exists for a
 * person to restore by hand, which is the reason its name has to be ours rather than another
 * product's. Defined once because the two call sites are otherwise two hand-copies of the same
 * string, and the tests assert against it so they cannot go on checking a name nobody writes. --- */

export const CONFIG_BACKUP_SUFFIX = '.geocode.backup';
