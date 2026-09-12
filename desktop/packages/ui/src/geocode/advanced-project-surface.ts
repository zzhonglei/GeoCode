/* --- GeoCode: the project settings panel offers a narrower surface than upstream's
 * (docs/DESKTOP.md §7.3).
 *
 * Project actions bind a shell command to a sidebar button — upstream's own repository uses one
 * to run `bun run dev:web:hmr`. It is a developer's convenience, and GeoCode's users are
 * geographers whose coding needs are light; a button that runs an arbitrary command is surface
 * they did not ask for and cannot audit at a glance.
 *
 * What this does NOT close: worktrees themselves. They are how two chats edit one project
 * without colliding, they are created from the composer rather than from settings, and the
 * "existing worktrees" list stays because it is the only place a worktree can be seen and
 * removed. Only the setup-command block above that list goes, through upstream's own
 * `sections="list-only"` — it configures what runs when a worktree is created (`bun install`
 * and the like), which is the same developer surface as the actions. --- */

export const PROJECT_ACTIONS_OFFERED: boolean = false;
