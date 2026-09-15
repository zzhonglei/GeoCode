/* --- GeoCode: the agent tools the desktop hands its kernel (docs/DESKTOP.md §7.2).
 *
 * Upstream gives the agent its tools through a plugin it writes to disk and injects into an
 * OpenCode it spawns itself. GeoCode's kernel is started by the main process before the shell
 * exists, so the main process does the writing and the naming: it materializes the plugin file
 * under the shell data root, mints the token the shell will accept, and hands the kernel the
 * file, the callback address and the token as environment overrides. The kernel loads exactly
 * that file and nothing else (kernel plugin/geocode-trusted.ts); the shell adopts the token from
 * its environment (agent-tool/runtime.js).
 *
 * The plugin source is upstream's own tool entries, wrapped: `browser` carries the web actions
 * under GeoCode's description, `geocode` carries the control actions under upstream's description
 * with the brand replaced, and both ask the kernel's permission system before every action so a
 * rule in config/geocode.ts can gate them. The two environment names the entries read are
 * upstream's; they are injected ABI, not inherited configuration. --- */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const BROWSER_TOOL_NAME = 'browser';
export const GEOCODE_TOOL_NAME = 'geocode';
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
    browser: {
      parameters: runtime.WEB_PARAMETER_PROPERTIES,
      actions: actions.OPENCHAMBER_WEB_ACTIONS,
      definitions: actions.OPENCHAMBER_WEB_ACTION_DEFINITIONS,
    },
    geocode: {
      description: runtime.CONTROL_TOOL_DESCRIPTION,
      parameters: runtime.CONTROL_PARAMETER_PROPERTIES,
      actions: actions.OPENCHAMBER_AGENT_TOOL_ACTIONS,
      definitions: actions.OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS,
    },
  };
};

// The strings each upstream entry shows the model or the user. Pinned by test against upstream's
// output, so another one cannot arrive unnoticed.
export const UPSTREAM_STRINGS = Object.freeze({
  [BROWSER_TOOL_NAME]: Object.freeze({
    'OpenChamber action to perform': 'Browser action to perform',
    'OpenChamber managed tool connection is unavailable': 'GeoCode browser tool connection is unavailable',
    'OpenChamber returned an invalid response': 'GeoCode returned an invalid response',
  }),
  [GEOCODE_TOOL_NAME]: Object.freeze({
    'OpenChamber action to perform': 'GeoCode action to perform',
    'OpenChamber managed tool connection is unavailable': 'GeoCode tool connection is unavailable',
    'OpenChamber returned an invalid response': 'GeoCode returned an invalid response',
    'Control OpenChamber projects': 'Control GeoCode projects',
    'the user follows it in OpenChamber': 'the user follows it in GeoCode',
    // `build` is disabled here, so a session created without an agent does not get it.
    'OpenCode agent name; new sessions default to the build agent': 'Agent name; new sessions use the default agent',
  }),
});

const rebrand = (source, strings) =>
  Object.entries(strings).reduce((text, [from, to]) => text.split(from).join(to), source);

// Upstream's entries do the schema, the callback and the result shape; the wrapper adds the names,
// the descriptions and the permission request. `always: ["*"]` lets one approval cover the rest of
// the session, the way the GEE tool does it.
export const createBrowserPluginSource = ({ createToolEntry, browser, geocode }) => {
  const entries = [
    rebrand(
      createToolEntry({ name: BROWSER_TOOL_NAME, description: BROWSER_TOOL_DESCRIPTION, ...browser }),
      UPSTREAM_STRINGS[BROWSER_TOOL_NAME],
    ),
    rebrand(createToolEntry({ name: GEOCODE_TOOL_NAME, ...geocode }), UPSTREAM_STRINGS[GEOCODE_TOOL_NAME]),
  ];
  const actions = { [BROWSER_TOOL_NAME]: browser.actions, [GEOCODE_TOOL_NAME]: geocode.actions };
  return `const upstream = {
${entries.join('')}}

const ACTIONS = ${JSON.stringify(actions)}
// The shell resolves a bare name the model sent ("click") to the one action of the calling tool
// ending in it (server/geocode/agent-tools.js); the permission is asked for that same name, or the
// rule written for the action never matches and the wildcard answers instead.
const canonical = (tool, requested) => {
  if (ACTIONS[tool].includes(requested)) return requested
  const matches = ACTIONS[tool].filter((candidate) => candidate.slice(candidate.indexOf(".") + 1) === requested)
  return matches.length === 1 ? matches[0] : requested
}

const guarded = (tool, describe) => ({
  ...upstream[tool],
  async execute(input, context) {
    const requested = typeof input?.action === "string" ? input.action.trim() : ""
    const action = canonical(tool, requested || tool)
    await context.ask({
      permission: tool,
      patterns: [action],
      always: ["*"],
      metadata: { action, ...describe(input) },
    })
    return upstream[tool].execute({ ...input, action }, context)
  },
})

export const GeoCodeBrowserPlugin = async () => ({
  tool: {
    ${BROWSER_TOOL_NAME}: guarded(${JSON.stringify(BROWSER_TOOL_NAME)}, (input) => ({
      url: typeof input?.url === "string" ? input.url : (typeof input?.parameters?.url === "string" ? input.parameters.url : undefined),
    })),
    ${GEOCODE_TOOL_NAME}: guarded(${JSON.stringify(GEOCODE_TOOL_NAME)}, () => ({})),
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
