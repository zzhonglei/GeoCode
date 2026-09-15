/* --- GeoCode: the two tools the desktop hands its kernel, as the callback route serves them (docs/DESKTOP.md §7.2).
 *
 * The main process writes `browser` and `geocode` into the one plugin file the kernel loads
 * (electron/geocode/browser-tool.mjs). Each stands for one of upstream's action sets, so a caller
 * holding the token reaches the calling tool's own actions and nothing else: not the other tool's,
 * not memory. Resolving against upstream's name for that set keeps a bare action name inside it. --- */
import {
  OPENCHAMBER_AGENT_TOOL_ACTIONS,
  OPENCHAMBER_WEB_ACTIONS,
  resolveAgentToolAction,
} from '../lib/openchamber-control/actions.js';

const TOOLS = Object.freeze({
  browser: { upstream: 'openchamber_web', label: 'GeoCode browser', actions: OPENCHAMBER_WEB_ACTIONS },
  geocode: { upstream: 'openchamber', label: 'GeoCode', actions: OPENCHAMBER_AGENT_TOOL_ACTIONS },
});

// Upstream's tool name to resolve the call against, or the refusal to answer with. A refusal lists
// only the calling tool's actions, so it never advertises what the desktop leaves closed.
export const routeGeoCodeToolCall = (tool, requested) => {
  const own = Object.hasOwn(TOOLS, tool ?? '') ? TOOLS[tool] : null;
  if (!own) {
    return { refusal: { action: requested, message: `Unsupported GeoCode tool: ${tool || 'missing'}` } };
  }
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
