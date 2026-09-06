/* --- GeoCode: the browser tool the desktop hands its kernel (docs/DESKTOP.md §7.2).
 *
 * Upstream gives the agent a browser through a plugin it writes to disk and injects into an
 * OpenCode it spawns itself. GeoCode's kernel is started by the main process before the shell
 * exists, so the main process does the writing and the naming: it materializes the plugin file
 * under the shell data root, mints the token the shell will accept, and hands the kernel the
 * file, the callback address and the token as environment overrides. The kernel loads exactly
 * that file and nothing else (kernel plugin/geocode-trusted.ts); the shell adopts the token from
 * its environment (agent-tool/runtime.js).
 *
 * The plugin source is upstream's own tool entry, wrapped: the tool is called `browser`, carries
 * GeoCode's description, exposes the web actions only, and asks the kernel's permission system
 * before every action so click and type can be gated (config/geocode.ts). The two environment
 * names the entry reads are upstream's; they are injected ABI, not inherited configuration. --- */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const BROWSER_TOOL_NAME = 'browser';
export const BROWSER_PLUGIN_ENV = 'GEOCODE_BROWSER_PLUGIN';
// A hand-copy of the kernel's expectation (plugin/geocode-trusted.ts), relative to the shell data root.
export const BROWSER_PLUGIN_RELATIVE_PATH = path.join('agent-tool', 'geocode-browser-plugin.js');

export const BROWSER_TOOL_DESCRIPTION = [
  "Look at and interact with a web page in GeoCode's browser panel: open a page, read it, click, type, scroll, and save a screenshot.",
  'Use one action per call. Open a page, snapshot it to read its text and its interactive elements, then click, type or scroll using the selectors the snapshot returned; snapshots also report any errors the page logged.',
  'Pass a selector to browser.snapshot to read one part of a long page. browser.inspect returns computed styles when the question is how something renders. Set viewport to lay a page out at mobile, tablet or desktop size.',
  "The page runs with the user's real logins, so treat what you see as their live session.",
].join(' ');

const loadUpstreamTemplate = async () => {
  const [runtime, actions] = await Promise.all([
    import('@openchamber/web/server/lib/agent-tool/runtime.js'),
    import('@openchamber/web/server/lib/openchamber-control/actions.js'),
  ]);
  return {
    createToolEntry: runtime.createToolEntry,
    parameters: runtime.WEB_PARAMETER_PROPERTIES,
    actions: actions.OPENCHAMBER_WEB_ACTIONS,
    definitions: actions.OPENCHAMBER_WEB_ACTION_DEFINITIONS,
  };
};

// The three strings upstream's template shows the model or the user. Pinned by test against the
// template's output, so a fourth one cannot arrive unnoticed.
export const UPSTREAM_STRINGS = Object.freeze({
  'OpenChamber action to perform': 'Browser action to perform',
  'OpenChamber managed tool connection is unavailable': 'GeoCode browser tool connection is unavailable',
  'OpenChamber returned an invalid response': 'GeoCode returned an invalid response',
});

const rebrand = (source) =>
  Object.entries(UPSTREAM_STRINGS).reduce((text, [from, to]) => text.split(from).join(to), source);

// Upstream's entry does the schema, the callback and the result shape; the wrapper adds the name,
// the description and the permission request. `always: ["*"]` lets one approval of a click cover
// the rest of the session, the way the GEE tool does it.
export const createBrowserPluginSource = ({ createToolEntry, actions, definitions, parameters }) => {
  const entry = rebrand(createToolEntry({
    name: BROWSER_TOOL_NAME,
    description: BROWSER_TOOL_DESCRIPTION,
    actions,
    definitions,
    parameters,
  }));
  return `const upstream = {
${entry}}

const ACTIONS = ${JSON.stringify(actions)}
// The shell resolves a bare name the model sent ("click") to the one action ending in it
// (openchamber-control/actions.js); the permission is asked for that same name, or the rule
// written for the action never matches and the wildcard answers instead.
const canonical = (requested) => {
  if (ACTIONS.includes(requested)) return requested
  const matches = ACTIONS.filter((candidate) => candidate.slice(candidate.indexOf(".") + 1) === requested)
  return matches.length === 1 ? matches[0] : requested
}

export const GeoCodeBrowserPlugin = async () => ({
  tool: {
    ${BROWSER_TOOL_NAME}: {
      ...upstream.${BROWSER_TOOL_NAME},
      async execute(input, context) {
        const requested = typeof input?.action === "string" ? input.action.trim() : ""
        const action = canonical(requested || ${JSON.stringify(BROWSER_TOOL_NAME)})
        await context.ask({
          permission: ${JSON.stringify(BROWSER_TOOL_NAME)},
          patterns: [action],
          always: ["*"],
          metadata: { action, url: typeof input?.url === "string" ? input.url : (typeof input?.parameters?.url === "string" ? input.parameters.url : undefined) },
        })
        return upstream.${BROWSER_TOOL_NAME}.execute({ ...input, action }, context)
      },
    },
  },
})
`;
};

export const prepareBrowserTool = async ({
  dataDirectory,
  shellPort,
  fileSystem = fs,
  randomBytes = crypto.randomBytes,
  loadTemplate = loadUpstreamTemplate,
}) => {
  if (typeof dataDirectory !== 'string' || !dataDirectory) {
    throw new Error('The browser tool needs the shell data root');
  }
  if (!Number.isInteger(shellPort) || shellPort <= 0) {
    throw new Error('The browser tool needs the shell port before the kernel starts');
  }
  const pluginPath = path.join(dataDirectory, BROWSER_PLUGIN_RELATIVE_PATH);
  fileSystem.mkdirSync(path.dirname(pluginPath), { recursive: true });
  fileSystem.writeFileSync(pluginPath, createBrowserPluginSource(await loadTemplate()), { mode: 0o600 });
  const token = randomBytes(32).toString('base64url');
  return {
    pluginPath,
    token,
    overrides: {
      [BROWSER_PLUGIN_ENV]: pathToFileURL(pluginPath).href,
      OPENCHAMBER_AGENT_TOOL_URL: `http://127.0.0.1:${shellPort}/api/openchamber/agent-tool`,
      OPENCHAMBER_AGENT_TOOL_TOKEN: token,
    },
  };
};
