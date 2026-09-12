// Writes one entry per kernel-facing settings page through the same server functions the routes
// call, and reports what it wrote to the file named in argv. Run with XDG_* on a scratch root.
import fs from 'node:fs';
import path from 'node:path';

const lib = (name) => new URL(`../../desktop/packages/web/server/lib/opencode/${name}`, import.meta.url).href;

const { createAgent } = await import(lib('agents.js'));
const { createCommand } = await import(lib('commands.js'));
const { createSkill } = await import(lib('skills.js'));
const { createMcpConfig } = await import(lib('mcp.js'));
const { writePluginDirFile } = await import(lib('plugins.js'));
const { upsertProviderConfig } = await import(lib('providers.js'));
const { kernelConfigRoot } = await import(
  new URL('../../desktop/packages/web/server/geocode/kernel-roots.js', import.meta.url).href
);

const configRoot = kernelConfigRoot();
const wrote = { configRoot };

wrote.agent = createAgent('roundtrip-agent', {
  description: 'round trip probe',
  prompt: 'You are a probe.',
}, null, 'user');

wrote.command = createCommand('roundtrip-command', {
  description: 'round trip probe',
  template: 'probe',
}, null, 'user');

wrote.skill = createSkill('roundtrip-skill', {
  description: 'round trip probe',
  content: 'probe body',
}, null, 'user');

// A local plugin file, not an npm spec: the kernel scans `{plugin,plugins}` for these, while
// installing a package is a path we keep shielded.
writePluginDirFile({
  fileName: 'roundtrip-plugin.ts',
  scope: 'user',
  content: 'export const RoundtripPlugin = async () => ({})\n',
}, null);
wrote.plugin = 'roundtrip-plugin.ts';

wrote.mcp = createMcpConfig('roundtrip-mcp', {
  type: 'local',
  command: ['echo', 'probe'],
  enabled: true,
}, null, 'user');

wrote.provider = upsertProviderConfig('roundtrip-provider', {
  name: 'Round Trip',
  options: { baseURL: 'https://example.invalid/v1' },
  models: { 'probe-model': { name: 'Probe Model' } },
  env: ['ROUNDTRIP_API_KEY'],
}, null, 'user');

// The behavior page has no exported helper. Rather than copy how the route spells the path, this
// joins onto the same constant the route joins onto, so the two cannot drift apart.
const { OPENCODE_CONFIG_DIR } = await import(lib('shared.js'));

const agentsMd = path.join(OPENCODE_CONFIG_DIR, 'AGENTS.md');
fs.mkdirSync(path.dirname(agentsMd), { recursive: true });
fs.writeFileSync(agentsMd, 'ROUNDTRIP-INSTRUCTION\n', 'utf8');
wrote.agentsMd = agentsMd;

// The server modules log progress to stdout, so the report goes to a file the driver names.
fs.writeFileSync(process.argv[2], JSON.stringify(wrote, null, 2));
