/* --- GeoCode: project actions and worktree setup commands are not offered, while worktrees and their list stay
 * (docs/DESKTOP.md §7.3). --- */

export const PROJECT_ACTIONS_OFFERED: boolean = false;

// Under Electron the shell runs none either, including commands saved earlier (web/server/lib/git/service.js).
export const WORKTREE_SETUP_COMMANDS_OFFERED: boolean = false;
