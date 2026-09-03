/* --- GeoCode: runs in a child process for login-shell-boundary.test.js. It stands in for
 * Electron main: puts a stub login shell in place, writes what main writes before importing the
 * shell runtime, imports it, and reports which probe names reached process.env. The `electron`
 * argument marks the process the way a real Electron build is marked; `plain` is standalone
 * serve, where the merge must still happen. --- */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mode = process.argv[2];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-login-shell-'));
const stubShell = path.join(scratch, 'stub-shell');
fs.writeFileSync(
  stubShell,
  '#!/bin/sh\nprintf "OPENCODE_CONFIG=/probe/opencode.json\\000OTEL_EXPORTER_OTLP_ENDPOINT=http://probe:4318\\000PATH=/probe/bin\\000"\n',
  { mode: 0o755 },
);

for (const key of ['OPENCODE_CONFIG', 'OTEL_EXPORTER_OTLP_ENDPOINT']) delete process.env[key];
process.env.SHELL = stubShell;
process.env.HOME = scratch;
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config');
process.env.XDG_DATA_HOME = path.join(scratch, 'data');
process.env.OPENCHAMBER_DATA_DIR = path.join(scratch, 'shell');
process.env.OPENCHAMBER_RUNTIME = 'desktop';
process.env.OPENCHAMBER_SKIP_OPENCODE_START = 'true';
process.env.OPENCODE_HOST = 'http://127.0.0.1:1';
if (mode === 'electron') process.versions.electron = '0.0.0-boundary-test';

await import('../index.js');

const reached = {
  OPENCODE_CONFIG: process.env.OPENCODE_CONFIG ?? null,
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null,
};
process.stdout.write(`\n@@RESULT@@${JSON.stringify(reached)}\n`);
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(0);
