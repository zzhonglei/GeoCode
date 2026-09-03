/* --- GeoCode: the environment boundary around the embedded kernel and the shell runtime beside
 * it (docs/ENVIRONMENT.md). Neither takes configuration from the environment it inherited:
 * names under another product's prefix are removed, everything else is the user's and passes.
 *
 * The password is deliberately NOT placed in this environment. It travels over the utility
 * process IPC instead (kernel-protocol.mjs), so it never appears in the child's environment
 * block where any process listing would show it. --- */

/** Prefixes the kernel reads configuration under. `OTEL_` is here because a rule written for
 *  `OPENCODE_` alone cannot see the telemetry pair, which steers where traces go. */
export const INHERITED_PREFIXES = ['OPENCODE_', 'OTEL_'];

/** Runtime switches read by Node, Electron or the loader before any code of ours runs, so the
 *  process boundary is the only place to handle them. Each either runs code of its own in the
 *  child, keeps the child from starting, or writes files (docs/ENVIRONMENT.md §5.3, measured). */
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

/** Mutates `process.env`. Runs once at module load, before shell modules resolve names at import,
 *  and again inside main's login-shell merge, which refills whatever was undefined. `keep` is for
 *  the caller's own launcher knobs, which share a prefix with what this removes. */
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

  for (const key of [...CHILD_DENYLIST.common, ...(CHILD_DENYLIST[platform] ?? [])]) delete next[key];

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
