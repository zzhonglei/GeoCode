/* --- GeoCode: text the shell runtime hands the renderer, and that the renderer then shows as it is,
 * names GeoCode where upstream named OpenChamber or OpenCode (docs/PATHS.md §3.4). Most appear only
 * when something has gone wrong, which is also when a user reads them most closely. Each message is
 * found by the words around the name, so a reworded one turns this red instead of slipping past. --- */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The file, a pattern whose groups capture the product name, and how many times the message appears.
const MESSAGES = [
  ['server/lib/opencode/lifecycle.js', /External (\w+) server on port \$\{probePort\} is not responding/g, 1],
  ['server/lib/opencode/lifecycle.js', /'(\w+) port is not available'/g, 2],
  ['server/lib/opencode/lifecycle.js', /`(\w+) health endpoint responded with status/g, 1],
  ['server/lib/opencode/lifecycle.js', /'(\w+) health endpoint returned unhealthy response'/g, 1],
  ['server/lib/opencode/lifecycle.js', /'Timed out waiting for (\w+) to become ready'/g, 1],
  ['server/lib/opencode/proxy.js', /\? '(\w+) upstream timed out' : '(\w+) service unavailable'/g, 1],
  ['server/lib/opencode/proxy.js', /json\(\{ error: '(\w+) service unavailable' \}\)/g, 2],
  ['server/lib/opencode/proxy.js', /error: '(\w+) is restarting'/g, 1],
  ['server/lib/opencode/proxy.js', /'(\w+) session list timed out'/g, 1],
  ['server/lib/opencode/shared.js', /`(\w+) configuration at \$\{filePath\} contains invalid JSONC/g, 1],
  ['server/lib/opencode/shared.js', /'Failed to (?:read|write) (\w+) configuration'/g, 2],
  ['server/lib/opencode/auth.js', /'Failed to (?:read|write) (\w+) auth configuration'/g, 2],
  ['server/lib/opencode/session-runtime.js', /interrupted when (\w+) restarted\./g, 1],
  ['server/lib/git/service.js', /'Failed to derive (\w+) project ID'/g, 1],
  ['server/lib/git/service.js', /'(\w+) enables Git `core\.longpaths`/g, 1],
  ['server/lib/small-model/call.js', /`(\w+) login for "\$\{providerID\}" has no usable credential`/g, 1],
  // Written into the user's repository as the stash subject.
  ['server/lib/git/service.js', /: `(\w+) stash \$\{new Date\(\)\.toISOString\(\)\}`/g, 1],
  // Shown by process listings.
  ['server/lib/dictation/local/worker-process.js', /process\.title = '(\w+) Dictation'/g, 1],
  ['mini-chat.html', /<title>(\w+) Mini Chat<\/title>/g, 1],
  ['src/api/notifications.ts', /payload\?\.title \?\? '(\w+)'/g, 2],
];

describe('the product name in text the shell hands the renderer', () => {
  it('is GeoCode', () => {
    for (const [file, pattern, count] of MESSAGES) {
      const source = fs.readFileSync(path.join(webRoot, file), 'utf8');
      const names = [...source.matchAll(pattern)].flatMap((match) => match.slice(1));
      const perMatch = pattern.source.split('(\\w+)').length - 1;
      expect([file, String(pattern), names]).toEqual([file, String(pattern), Array(count * perMatch).fill('GeoCode')]);
    }
  });
});
