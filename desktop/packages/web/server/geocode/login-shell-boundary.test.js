/* --- GeoCode: the shell runtime's own login-shell merge stays off under Electron
 * (docs/ENVIRONMENT.md §5.2 invariant 3).
 *
 * The merge copies every name the login shell exports that is empty in process.env. Under
 * Electron, main.mjs has already merged that shell and then removed the other products'
 * prefixes, so those names are empty on purpose, and this merge would put them straight back.
 * A source-text check in packages/electron pins the shield's shape; this drives the real module
 * in a real process, with a stub shell that exports the two probe names, and reads what arrived.
 *
 * Two runs, not one. The plain run is the control: it proves the stub shell is honoured and the
 * merge does bring the names in, so a green electron run means the shield worked, not that the
 * harness went quiet. --- */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const driver = path.join(here, 'login-shell-boundary.driver.mjs');

const importShellRuntime = (mode) => {
  const stdout = execFileSync(process.execPath, [driver, mode], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  const marker = stdout.lastIndexOf('@@RESULT@@');
  expect(marker).toBeGreaterThan(-1);
  return JSON.parse(stdout.slice(marker + '@@RESULT@@'.length).trim());
};

describe('login-shell merge at import of server/index.js', () => {
  it('standalone: brings the login shell in, which is upstream behaviour and the control', () => {
    const reached = importShellRuntime('plain');
    expect(reached.OPENCODE_CONFIG).toBe('/probe/opencode.json');
    expect(reached.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://probe:4318');
  }, 60_000);

  it('under Electron: leaves the names main removed removed', () => {
    const reached = importShellRuntime('electron');
    expect(reached.OPENCODE_CONFIG).toBeNull();
    expect(reached.OTEL_EXPORTER_OTLP_ENDPOINT).toBeNull();
  }, 60_000);
});
