/* --- GeoCode: the kernel's directory names, hand-copied from core/src/brand.ts and pinned by kernel-roots.test.ts;
 * the shell's own data root is shell-data-root.ts, not these (docs/PATHS.md §5). --- */

/** `Brand.projectDir`. */
export const KERNEL_PROJECT_DIR = '.geocode';

/** `Brand.dirName`: the kernel's directory under each XDG root, its log directory among them. */
export const KERNEL_DIR_NAME = 'GeoCode';

/** `Brand.plansSegments`. */
export const KERNEL_PLANS_SEGMENTS = [KERNEL_PROJECT_DIR, 'plans'] as const;
