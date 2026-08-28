/* --- GeoCode: the environment boundary around the embedded Agent Kernel (docs/DESKTOP.md §8.2).
 *
 * The public namespace is `GEOCODE_*`; the kernel keeps its `OPENCODE_*` wire fingerprint
 * internally. Translation happens in exactly one place — here — because Electron main is
 * the only path that starts a kernel, so there is no second entry point that could forget
 * to translate.
 *
 * Stripping the inherited `OPENCODE_*` comes first and is the part that matters for
 * isolation: a user who runs their own opencode has those variables exported in the shell
 * this app inherits, and without the strip their settings would silently steer our kernel.
 *
 * The password is deliberately NOT placed in this environment. It travels over the utility
 * process IPC instead (kernel-protocol.mjs), so it never appears in the child's environment
 * block where any process listing would show it. --- */

const GEOCODE_PREFIX = 'GEOCODE_';
const OPENCODE_PREFIX = 'OPENCODE_';

export const buildKernelBaseUrl = ({ hostname, port }) => {
  // env-config.js parses OPENCODE_HOST with `new URL`, which rejects a bare IPv6 literal.
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return `http://${host}:${port}`;
};

export const createKernelProcessEnvironment = ({
  environment = process.env,
  platform = process.platform,
  overrides = {},
} = {}) => {
  const next = {};

  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (key.startsWith(OPENCODE_PREFIX)) continue;
    next[key] = String(value);
  }

  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || !key.startsWith(GEOCODE_PREFIX)) continue;
    next[`${OPENCODE_PREFIX}${key.slice(GEOCODE_PREFIX.length)}`] = String(value);
  }

  // Both inherited from the upstream desktop's own sidecar environment: DEBUG makes the
  // kernel's dependencies write to stdout we parse, and LD_PRELOAD leaks the Electron
  // launcher's injections into a plain Node child.
  delete next.DEBUG;
  if (platform === 'linux') delete next.LD_PRELOAD;

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete next[key];
      continue;
    }
    next[key] = String(value);
  }

  return next;
};

/**
 * Hands the shell runtime the connection main already owns. These three variables are the
 * upstream's own external-server path (`lifecycle.js` skip-start branch, `env-config.js`,
 * `hmr-state-runtime.js`), so nothing in the shell is patched to accept them — the values
 * are simply in place before it is imported.
 */
export const applyKernelConnectionToShellEnvironment = ({ environment, connection }) => {
  if (!connection || !connection.baseUrl) {
    throw new Error('Cannot point the shell runtime at a kernel without a base URL');
  }

  environment.OPENCHAMBER_SKIP_OPENCODE_START = 'true';
  environment.OPENCODE_HOST = connection.baseUrl;

  if (typeof connection.password === 'string' && connection.password.length > 0) {
    environment.OPENCODE_SERVER_PASSWORD = connection.password;
  } else {
    delete environment.OPENCODE_SERVER_PASSWORD;
  }

  return environment;
};
