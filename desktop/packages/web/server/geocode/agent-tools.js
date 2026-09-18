/* --- GeoCode: maps the desktop's `browser` and `geocode` tools onto upstream's action sets, so a caller
 * holding the token reaches only the calling tool's actions (docs/DESKTOP.md §7.2). --- */
import {
  OPENCHAMBER_AGENT_TOOL_ACTIONS,
  OPENCHAMBER_WEB_ACTIONS,
  resolveAgentToolAction,
} from '../lib/openchamber-control/actions.js';

const TOOLS = Object.freeze({
  browser: { upstream: 'openchamber_web', label: 'GeoCode browser', actions: OPENCHAMBER_WEB_ACTIONS },
  geocode: { upstream: 'openchamber', label: 'GeoCode', actions: OPENCHAMBER_AGENT_TOOL_ACTIONS },
});

export const routeGeoCodeToolCall = (tool, requested) => {
  const own = Object.hasOwn(TOOLS, tool ?? '') ? TOOLS[tool] : null;
  if (!own) {
    return { refusal: { action: requested, message: `Unsupported GeoCode tool: ${tool || 'missing'}` } };
  }
  // Upstream's set name, not ours, so a bare action name resolves within the calling tool.
  const resolution = resolveAgentToolAction(requested, own.upstream);
  if (resolution.error || !own.actions.includes(resolution.action)) {
    return {
      refusal: {
        action: resolution.action ?? requested,
        message: `Unsupported ${own.label} action: ${requested || 'missing'}. Use one of: ${own.actions.join(', ')}`,
      },
    };
  }
  return { upstreamTool: own.upstream };
};
