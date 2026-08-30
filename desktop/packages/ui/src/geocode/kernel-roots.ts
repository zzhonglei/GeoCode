/* --- GeoCode: the KERNEL's roots as the renderer must compute them (docs/PATHS.md §3.1).
 *
 * Distinct from `shell-data-root.ts` next door, and the distinction matters: that one is where
 * the SHELL keeps its own data, this one is where the AGENT keeps files inside the user's
 * repository. The renderer reads some of those files directly, so it has to name the same
 * directory the kernel writes.
 *
 * These are a hand-copy of `core/src/brand.ts`, which this package cannot import — the kernel
 * is a separate install root. Nothing conflicts and nothing fails when a hand-copy drifts, so
 * `kernel-roots.test.ts` reads brand.ts as text and compares, the same shape the shell server
 * uses for its own copy in `server/geocode/kernel-roots.js`. --- */

/** `Brand.projectDir`. */
export const KERNEL_PROJECT_DIR = '.geocode';

/**
 * `Brand.plansSegments`. An array on the kernel side because two call sites must agree — one
 * writes the plan file under the worktree, the other spreads the same array into the glob that
 * authorises the plan agent to edit it. The renderer is a third reader of that same location.
 */
export const KERNEL_PLANS_SEGMENTS = [KERNEL_PROJECT_DIR, 'plans'] as const;
