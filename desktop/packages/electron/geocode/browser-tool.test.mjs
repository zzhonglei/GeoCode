/* --- GeoCode: the main process hands the kernel its browser tool (docs/DESKTOP.md §7.2).
 *
 * The plugin file, the token and the three overrides are pinned against a scratch data root with
 * a stub template; the generated source is then built with upstream's real template and imported,
 * so a change to the template that breaks the wrapper or leaks the old name fails here. The
 * main.mjs wiring is pinned by source: the tool is prepared before the kernel starts and the token
 * leaves main's own environment once the shell has it. --- */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BROWSER_PLUGIN_ENV,
  BROWSER_PLUGIN_RELATIVE_PATH,
  BROWSER_TOOL_NAME,
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
  actions: ['browser.open'],
  definitions: [{ action: 'browser.open', title: 'Open', description: 'Open' }],
  parameters: {},
});

const realTemplate = async () => {
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
  it('is one tool named browser, with the web actions only, asking before it acts', async () => {
    const source = createBrowserPluginSource(await realTemplate());
    const mod = await importSource(source);
    const plugin = await mod.GeoCodeBrowserPlugin();
    expect(Object.keys(plugin.tool)).toEqual([BROWSER_TOOL_NAME]);
    const tool = plugin.tool[BROWSER_TOOL_NAME];
    expect(tool.args.action.enum.every((action) => action.startsWith('browser.'))).toBe(true);
    expect(tool.args.action.enum.length).toBeGreaterThanOrEqual(10);

    const asked = [];
    const context = {
      ask: async (request) => { asked.push(request); },
      metadata: () => {},
      directory: '/work',
      abort: undefined,
    };
    // No endpoint in this process, so the upstream body answers with its own failure; what is
    // asserted is that the permission request came first and named the action.
    const result = await tool.execute({ action: 'browser.click', parameters: { selector: '#go' } }, context);
    expect(asked).toEqual([{ permission: BROWSER_TOOL_NAME, patterns: ['browser.click'], always: ['*'], metadata: { action: 'browser.click', url: undefined } }]);
    expect(JSON.parse(result.output).ok).toBe(false);
  });

  it('asks with the canonical action when the model drops the namespace, the way the shell resolves it', async () => {
    const source = createBrowserPluginSource(await realTemplate());
    const mod = await importSource(source);
    const tool = (await mod.GeoCodeBrowserPlugin()).tool[BROWSER_TOOL_NAME];
    const asked = [];
    const context = { ask: async (request) => { asked.push(request); }, metadata: () => {}, directory: '/work', abort: undefined };
    await tool.execute({ action: 'click', selector: '#go' }, context);
    expect(asked[0].patterns).toEqual(['browser.click']);
    asked.length = 0;
    await tool.execute({ action: ' browser.type ' }, context);
    expect(asked[0].patterns).toEqual(['browser.type']);
    asked.length = 0;
    await tool.execute({ action: 'nonsense' }, context);
    expect(asked[0].patterns).toEqual(['nonsense']);
  });

  it('carries no OpenChamber wording, and the three rebranded strings are the ones the template has', async () => {
    const template = await realTemplate();
    const raw = template.createToolEntry({ name: 'x', description: 'x', actions: template.actions, definitions: template.definitions, parameters: template.parameters });
    for (const upstream of Object.keys(UPSTREAM_STRINGS)) {
      expect(raw).toContain(upstream);
    }
    expect((raw.match(/OpenChamber/g) ?? []).length).toBe(Object.keys(UPSTREAM_STRINGS).length);
    expect(createBrowserPluginSource(template)).not.toContain('OpenChamber');
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

describe('the chat surface knows the tool by its GeoCode name', () => {
  it('keeps the upstream icon and hides the raw input, under the new name', () => {
    // Both are keyed by tool name in the renderer, which cannot import this module. Renaming the
    // tool without them leaves every browser call rendered as a generic wrench plus a dump of the
    // call arguments, while the curated card upstream wrote for it goes unused.
    const read = (file) => fs.readFileSync(path.resolve(electronRoot, '../ui/src/components/chat/message/parts', file), 'utf8');
    for (const file of ['toolPresentation.tsx', 'ToolPart.tsx']) {
      const source = read(file);
      expect([file, source.includes(`'${BROWSER_TOOL_NAME}'`)]).toEqual([file, true]);
    }
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
