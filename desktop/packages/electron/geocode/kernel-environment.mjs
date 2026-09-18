/* --- GeoCode: the environment boundary around the embedded kernel and the shell runtime (docs/ENVIRONMENT.md §5).
 * The kernel password is not placed in the child's environment; it travels over IPC (kernel-protocol.mjs). --- */

/** `OTEL_` steers where traces go, and carries no `OPENCODE_` prefix to be caught by. */
export const INHERITED_PREFIXES = ['OPENCODE_', 'OTEL_', 'OPENCHAMBER_'];

/** Set by our `electron:dev` launcher, and kept only while unpackaged so a shell export cannot turn a release build
 *  into the development form. */
export const LAUNCHER_ALLOWLIST = [
  'OPENCHAMBER_ELECTRON_DEV',
  'OPENCHAMBER_ELECTRON_USE_BUNDLED_UI',
  'OPENCHAMBER_HMR_UI_PORT',
  'OPENCHAMBER_HMR_API_PORT',
];

/** Inert unless the build carries the updater e2e define, so they can stay in every form. */
export const E2E_ALLOWLIST = ['OPENCHAMBER_E2E', 'OPENCHAMBER_UPDATER_E2E_URL'];

/** Reaches the kernel through `overrides` alone; an inherited one would point it at a plugin the shell did not
 *  prepare this run. Listed by name rather than by a `GEOCODE_` prefix, which is ours and stays inheritable. */
export const INJECTED_ONLY = ['GEOCODE_BROWSER_PLUGIN'];

/** Read by Node, Electron or the loader before our code runs, so only the process boundary can remove them
 *  (docs/ENVIRONMENT.md §5.3). */
export const CHILD_DENYLIST = {
  common: [
    'NODE_OPTIONS', 'NODE_PATH', 'NODE_ICU_DATA', 'OPENSSL_CONF',
    'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR',
    'NODE_V8_COVERAGE', 'NODE_REDIRECT_WARNINGS', 'ELECTRON_LOG_FILE', 'CHROME_LOG_FILE',
    'NODE_DEBUG', 'NODE_PENDING_DEPRECATION', 'DEBUG',
  ],
  darwin: ['DYLD_INSERT_LIBRARIES'],
  linux: ['LD_PRELOAD'],
};

export const stripInheritedForeignVariables = (environment, { keep = [] } = {}) => {
  const kept = new Set(keep);
  const removed = [];
  for (const key of Object.keys(environment)) {
    if (kept.has(key)) continue;
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

  for (const key of [...INJECTED_ONLY, ...CHILD_DENYLIST.common, ...(CHILD_DENYLIST[platform] ?? [])]) delete next[key];

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete next[key];
      continue;
    }
    next[key] = String(value);
  }

  return next;
};

/** The shell's own external-server path reads these at import, so they must be in place before main imports it. */
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
