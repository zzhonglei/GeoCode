/* --- GeoCode: the environment boundary around the embedded kernel and the shell runtime beside
 * it (docs/DESKTOP.md §8.2). Neither takes configuration from the environment it inherited.
 *
 * The password is deliberately NOT placed in this environment. It travels over the utility
 * process IPC instead (kernel-protocol.mjs), so it never appears in the child's environment
 * block where any process listing would show it. --- */

/** Prefixes the kernel reads configuration under. `OTEL_` is here because a rule written for
 *  `OPENCODE_` alone cannot see the telemetry pair, which steers where traces go. */
export const INHERITED_PREFIXES = ['OPENCODE_', 'OTEL_'];

/** Mutates `process.env`, which shell modules read and several resolve once at import, so this
 *  must run before the shell runtime loads and before main writes the kernel connection into it. */
export const stripInheritedForeignVariables = (environment) => {
  const removed = [];
  for (const key of Object.keys(environment)) {
    if (!INHERITED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    delete environment[key];
    removed.push(key);
  }
  return removed;
};

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
    if (INHERITED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    next[key] = String(value);
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
