/* --- GeoCode: the main process hands the kernel its agent tools (docs/DESKTOP.md §7.2).
 *
 * The plugin file, the token and the three overrides are pinned against a scratch data root with
 * a stub template; the generated source is then built with upstream's real template and imported,
 * so a change to the template that breaks the wrapper or leaks the old names fails here. The
 * main.mjs wiring is pinned by source: the tools are prepared before the kernel starts and the
 * token leaves main's own environment once the shell has it. --- */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BROWSER_PLUGIN_ENV,
  BROWSER_PLUGIN_RELATIVE_PATH,
  BROWSER_TOOL_NAME,
  GEOCODE_TOOL_NAME,
  UPSTREAM_STRINGS,
  createBrowserPluginSource,
  prepareBrowserTool,
} from './browser-tool.mjs';

const electronRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSource = fs.readFileSync(path.join(electronRoot, 'main.mjs'), 'utf8');
const trustedSource = fs.readFileSync(
  path.resolve(electronRoot, '../../../kernel/packages/opencode/src/plugin/geocode-trusted.ts'),
  'utf8',
);

const stubTemplate = async () => ({
  createToolEntry: ({ name }) => `    ${name}: { description: "stub", args: {}, async execute() { return "stub" } },\n`,
  browser: {
    actions: ['browser.open'],
    definitions: [{ action: 'browser.open', title: 'Open', description: 'Open' }],
    parameters: {},
  },
  geocode: {
    description: 'stub',
    actions: ['session.create'],
    definitions: [{ action: 'session.create', title: 'Create', description: 'Create' }],
    parameters: {},
  },
});

const realTemplate = async () => {
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

// bun resolves a data: URL as a package name, so the source goes through a scratch file.
const importSource = async (source) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-browser-plugin-'));
  const file = path.join(directory, 'plugin.mjs');
  fs.writeFileSync(file, source);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

const loadTools = async () => {
  const mod = await importSource(createBrowserPluginSource(await realTemplate()));
  return (await mod.GeoCodeBrowserPlugin()).tool;
};

const recordingContext = (asked) => ({
  ask: async (request) => { asked.push(request); },
  metadata: () => {},
  directory: '/work',
  abort: undefined,
});

describe('prepareBrowserTool', () => {
  it('writes the plugin under the data root and hands the kernel the file, the address and the token', async () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-browser-tool-'));
    try {
      const result = await prepareBrowserTool({
        dataDirectory,
        shellPort: 49901,
        randomBytes: () => Buffer.alloc(32, 7),
        loadTemplate: stubTemplate,
      });
      expect(result.pluginPath).toBe(path.join(dataDirectory, BROWSER_PLUGIN_RELATIVE_PATH));
      expect(fs.statSync(result.pluginPath).mode & 0o777).toBe(0o600);
      expect(result.overrides).toEqual({
        [BROWSER_PLUGIN_ENV]: pathToFileURL(result.pluginPath).href,
        OPENCHAMBER_AGENT_TOOL_URL: 'http://127.0.0.1:49901/api/openchamber/agent-tool',
        OPENCHAMBER_AGENT_TOOL_TOKEN: result.token,
      });
      expect(result.token).toBe(Buffer.alloc(32, 7).toString('base64url'));
    } finally {
      fs.rmSync(dataDirectory, { recursive: true, force: true });
    }
  });

  it('refuses to run without the data root or the port', async () => {
    await expect(prepareBrowserTool({ dataDirectory: '', shellPort: 1, loadTemplate: stubTemplate })).rejects.toThrow(/data root/);
    await expect(prepareBrowserTool({ dataDirectory: '/tmp/x', shellPort: 0, loadTemplate: stubTemplate })).rejects.toThrow(/port/);
  });
});

describe('the generated plugin', () => {
  it('is browser with the web actions and geocode with the control actions, each asking before it acts', async () => {
    const tools = await loadTools();
    expect(Object.keys(tools)).toEqual([BROWSER_TOOL_NAME, GEOCODE_TOOL_NAME]);
    const browserActions = tools[BROWSER_TOOL_NAME].args.action.enum;
    expect(browserActions.every((action) => action.startsWith('browser.'))).toBe(true);
    expect(browserActions.length).toBeGreaterThanOrEqual(10);
    const geocodeActions = tools[GEOCODE_TOOL_NAME].args.action.enum;
    for (const action of ['session.create', 'session.send', 'schedule.create', 'schedule.delete']) {
      expect([action, geocodeActions.includes(action)]).toEqual([action, true]);
    }
    expect(geocodeActions.filter((action) => /^(browser|memory)\./.test(action))).toEqual([]);

    const asked = [];
    const context = recordingContext(asked);
    // No endpoint in this process, so the upstream body answers with its own failure; what is
    // asserted is that the permission request came first and named the action.
    const browserResult = await tools[BROWSER_TOOL_NAME].execute({ action: 'browser.click', parameters: { selector: '#go' } }, context);
    const geocodeResult = await tools[GEOCODE_TOOL_NAME].execute({ action: 'schedule.create', parameters: { name: 'x' } }, context);
    expect(asked).toEqual([
      { permission: BROWSER_TOOL_NAME, patterns: ['browser.click'], always: ['*'], metadata: { action: 'browser.click', url: undefined } },
      { permission: GEOCODE_TOOL_NAME, patterns: ['schedule.create'], always: ['*'], metadata: { action: 'schedule.create' } },
    ]);
    expect(JSON.parse(browserResult.output).ok).toBe(false);
    expect(JSON.parse(geocodeResult.output).ok).toBe(false);
  });

  it('asks with the canonical action when the model drops the namespace, the way the shell resolves it', async () => {
    const tools = await loadTools();
    const asked = [];
    const context = recordingContext(asked);
    const patternFor = async (tool, action) => {
      asked.length = 0;
      await tools[tool].execute({ action }, context);
      return asked[0].patterns[0];
    };
    expect(await patternFor(BROWSER_TOOL_NAME, 'click')).toBe('browser.click');
    expect(await patternFor(BROWSER_TOOL_NAME, ' browser.type ')).toBe('browser.type');
    expect(await patternFor(BROWSER_TOOL_NAME, 'nonsense')).toBe('nonsense');
    // Memory has a delete as well; within geocode it can only be the schedule one.
    expect(await patternFor(GEOCODE_TOOL_NAME, 'delete')).toBe('schedule.delete');
    // Sessions and schedules both create, so the name stays as sent and the shell refuses it.
    expect(await patternFor(GEOCODE_TOOL_NAME, 'create')).toBe('create');
  });

  it('carries no OpenChamber or OpenCode wording, and the rebranded strings are the ones upstream has', async () => {
    const template = await realTemplate();
    const upstreamEntries = {
      [BROWSER_TOOL_NAME]: template.createToolEntry({ name: 'x', description: 'x', ...template.browser }),
      [GEOCODE_TOOL_NAME]: template.createToolEntry({ name: 'x', ...template.geocode }),
    };
    for (const [tool, raw] of Object.entries(upstreamEntries)) {
      const strings = Object.keys(UPSTREAM_STRINGS[tool]);
      for (const upstream of strings) {
        expect([tool, upstream, raw.includes(upstream)]).toEqual([tool, upstream, true]);
      }
      // Each replaced string holds one brand name, so one left unreplaced shows as a count that differs.
      expect([tool, (raw.match(/OpenChamber|OpenCode/g) ?? []).length]).toEqual([tool, strings.length]);
    }
    const source = createBrowserPluginSource(template);
    expect(source).not.toMatch(/OpenChamber|OpenCode/);
    // `build` is disabled in GeoCode, so nothing may tell the model a new session gets it.
    expect(source).not.toMatch(/build agent/);
  });
});

describe('the two sides agree on the file', () => {
  it('names the same relative path as the kernel expects under its config root', () => {
    // The kernel spells `desktop/agent-tool/geocode-browser-plugin.js` under the config root; the
    // shell data root is `<config root>/desktop`, so the shell's relative path is the tail of it.
    const segments = trustedSource.match(/GEOCODE_BROWSER_PLUGIN_SEGMENTS = \[([^\]]+)\]/)?.[1]
      ?.split(',').map((part) => part.trim().replace(/^"|"$/g, '')) ?? [];
    expect(segments[0]).toBe('desktop');
    expect(path.join(...segments.slice(1))).toBe(BROWSER_PLUGIN_RELATIVE_PATH);
    expect(trustedSource).toContain(`"${BROWSER_PLUGIN_ENV}"`);
  });
});

describe('the chat surface knows the tools by their GeoCode names', () => {
  it('keeps the upstream icons, hides the raw input and names the tool, under the new names', () => {
    // All keyed by tool name in the renderer, which cannot import this module. Renaming a tool
    // without them leaves its calls rendered as a generic wrench plus a dump of the call arguments,
    // while the curated card upstream wrote for it goes unused.
    const read = (file) => fs.readFileSync(path.resolve(electronRoot, '../ui/src', file), 'utf8');
    for (const file of ['components/chat/message/parts/toolPresentation.tsx', 'components/chat/message/parts/ToolPart.tsx']) {
      const source = read(file);
      for (const tool of [BROWSER_TOOL_NAME, GEOCODE_TOOL_NAME]) {
        expect([file, tool, source.includes(`'${tool}'`)]).toEqual([file, tool, true]);
      }
    }
    // A name the renderer does not list is shown capitalized, which would spell the product Geocode.
    expect(read('lib/toolHelpers.ts')).toMatch(new RegExp(`\\n\\s*${GEOCODE_TOOL_NAME}: \\{\\s*displayName: 'GeoCode',`));
  });
});

describe('main.mjs wiring', () => {
  it('prepares the tool before the kernel starts, hands over the overrides, and drops the token afterwards', () => {
    const prepare = mainSource.indexOf('browserTool = await prepareBrowserTool({ dataDirectory: process.env.OPENCHAMBER_DATA_DIR, shellPort: chosenPort });');
    const adopt = mainSource.indexOf('process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = browserTool.token;');
    const start = mainSource.indexOf('state.kernelHandle = await startEmbeddedKernel({');
    const overrides = mainSource.indexOf('overrides: browserTool?.overrides ?? {},', start);
    const shell = mainSource.indexOf("await import('@openchamber/web/server/index.js')", start);
    const drop = mainSource.indexOf('delete process.env.OPENCHAMBER_AGENT_TOOL_TOKEN;', shell);
    expect(prepare).toBeGreaterThan(-1);
    expect(adopt).toBeGreaterThan(prepare);
    expect(start).toBeGreaterThan(adopt);
    expect(overrides).toBeGreaterThan(start);
    expect(shell).toBeGreaterThan(overrides);
    expect(drop).toBeGreaterThan(shell);
  });
});
