import { describe, expect, it } from 'bun:test';
import path from 'node:path';

import { applyShellDataRoot, resolveShellDataRoot } from './shell-data-root.mjs';

const USER_DATA = path.join('/tmp', 'Application Support', 'GeoCode');

describe('shell data root', () => {
  it('overwrites an inherited value instead of honouring it', () => {
    // A user running OpenChamber has this exported in the shell we inherit. Honouring it
    // would put GeoCode's settings and sessions inside their OpenChamber directory.
    const environment = { OPENCHAMBER_DATA_DIR: '/somewhere/openchamber' };
    applyShellDataRoot({ environment, userDataDirectory: USER_DATA });
    expect(environment.OPENCHAMBER_DATA_DIR).toBe(resolveShellDataRoot(USER_DATA));
  });

  it('points the managed process registry at its own variable', () => {
    // The registry's fallback is hardcoded rather than derived from the data root, so setting
    // only the root would leave it writing to the old location.
    const environment = {};
    applyShellDataRoot({ environment, userDataDirectory: USER_DATA });
    expect(environment.OPENCHAMBER_MANAGED_PROCESS_REGISTRY)
      .toBe(path.join(resolveShellDataRoot(USER_DATA), 'managed-opencode'));
  });

  it('keeps shell data out of the directory Chromium writes into', () => {
    expect(resolveShellDataRoot(USER_DATA)).toBe(path.join(USER_DATA, 'desktop'));
  });

  it('refuses to guess when userData is missing', () => {
    // Failing loudly beats defaulting: a silent fallback here would write to whatever the
    // upstream ternary picks, which is the OpenChamber directory this whole change avoids.
    for (const bad of [undefined, '', null, 42]) {
      expect(() => applyShellDataRoot({ environment: {}, userDataDirectory: bad })).toThrow();
    }
  });
});
