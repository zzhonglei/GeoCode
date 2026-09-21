/* --- GeoCode: the agent tools main writes into a plugin file for its kernel, which starts before the shell exists
 * (docs/DESKTOP.md §7.2). --- */

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

// Exported so the tripwire builds from this wiring rather than a copy of it that can drift from it.
export const loadUpstreamTemplate = async () => {
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
    const { parameters, ...flattened } = input ?? {}
    const normalized = { action, parameters: { ...flattened, ...(parameters ?? {}) } }
    await context.ask({
      permission: tool,
      patterns: [action],
      always: ["*"],
      metadata: { action, ...describe(normalized.parameters) },
    })
    return upstream[tool].execute(normalized, context)
  },
})

export const GeoCodeBrowserPlugin = async () => ({
  tool: {
    ${BROWSER_TOOL_NAME}: guarded(${JSON.stringify(BROWSER_TOOL_NAME)}, (input) => ({
      url: typeof input?.url === "string" ? input.url : undefined,
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
      // Upstream's names, read by its generated entries inside the kernel.
      OPENCHAMBER_AGENT_TOOL_URL: `http://127.0.0.1:${shellPort}/api/openchamber/agent-tool`,
      OPENCHAMBER_AGENT_TOOL_TOKEN: token,
    },
  };
};
