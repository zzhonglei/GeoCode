/* --- GeoCode: project actions and worktree setup commands are not offered (docs/DESKTOP.md §7.3).
 * Both bind a shell command to the interface. Worktrees themselves stay, and so does the
 * "existing worktrees" list, the only place one can be removed. --- */

export const PROJECT_ACTIONS_OFFERED: boolean = false;

// The shell runs none on its side either, including commands saved before (lib/git/service.js).
export const WORKTREE_SETUP_COMMANDS_OFFERED: boolean = false;
