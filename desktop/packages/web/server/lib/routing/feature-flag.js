/**
 * Whether Jev model routing exists at all in this build.
 *
 * The feature ships dark, the same way agent memory does: with the flag unset
 * there is no Auto row in the model picker, no settings page, no routes and no
 * request rewriting. Read per call so only the process environment decides.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export const isRoutingFeatureAvailable = () => {
  // --- GeoCode: routing decides through a third party, which is handed the text of the prompt; GeoCode
  // does not offer that. This is the capability switch upstream's own comment above describes, so turning
  // it off here closes the settings page, the Auto row, the routes and the rewriting at once
  // (docs/DESKTOP.md §7.3; rung 1 of the ladder in docs/CONVENTIONS.md §5). ---
  if (process.versions.electron) return false;
  // --- /GeoCode ---
  return TRUTHY.has((process.env.OPENCHAMBER_ROUTING_ENABLE ?? '').trim().toLowerCase());
};
