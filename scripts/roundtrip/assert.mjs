// Reads the kernel probe's JSON on stdin and fails when an entry the shell wrote is one the
// kernel would not see. Prints one line per page so a failure names the page, not a diff.
import fs from 'node:fs';
import path from 'node:path';

const report = JSON.parse(await new Response(process.stdin).text());
const shellRoot = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).configRoot;
const layers = report.layers.filter((layer) => layer.exists);
const has = (field, value) => layers.some((layer) => (layer[field] ?? []).includes(value));

const checks = [
  ['agents', report.agents.includes('roundtrip-agent')],
  ['commands', report.commands.includes('roundtrip-command')],
  ['skills', report.skills.includes('roundtrip-skill')],
  ['plugins', report.plugins.some((entry) => entry.endsWith('/roundtrip-plugin.ts'))],
  ['mcp', has('mcp', 'roundtrip-mcp')],
  ['providers', has('provider', 'roundtrip-provider')],
  ['behavior (AGENTS.md)', report.agentsMd],
  ['config layers accepted by the kernel schema', layers.every((layer) => layer.schemaError === null)],
  ['kernel resolved the scratch root, so XDG is honoured', path.resolve(report.configRoot) === path.resolve(process.argv[2])],
  ['the root the shell wrote to is the one the kernel reads', path.resolve(report.configRoot) === path.resolve(shellRoot)],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
}
console.log(`  wrote into: ${layers.map((layer) => layer.name).join(', ') || '(no config layer)'}`);
process.exit(failed ? 1 : 0);
