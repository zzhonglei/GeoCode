/* --- GeoCode: the slash commands GeoCode closes and the ones it ships
 * (docs/DESKTOP.md §7.3, docs/KERNEL.md §5.5). --- */

// Composer built-in entries GeoCode does not offer; a command the user configures under one of these names still runs.
export const CLOSED_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  'init',
  'review',
  'summary',
  'workspace-review',
  'handoff-review',
  'plan-feature',
  'catch-up',
  'debug',
  'weigh',
  'explore',
]);

// The keys of `command` in config/geocode.ts. The shell recognises built-in commands by name, so a command missing
// here is listed as the user's own, with a Delete button.
export const SHIPPED_SLASH_COMMANDS: ReadonlySet<string> = new Set(['set']);
