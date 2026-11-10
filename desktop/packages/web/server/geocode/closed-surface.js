// Answered here because an unmatched /api path would fall through to the OpenCode proxy.
export const CLOSED_PATHS = Object.freeze([
  '/api/client-auth',
  '/api/auth/reset',
  '/api/system/dev-shutdown',
  '/api/openchamber/relay',
  '/api/openchamber/tunnel',
  '/api/openchamber/update-check',
  '/api/openchamber/update-install',
  '/api/opencode/upgrade',
  '/api/opencode/upgrade-status',
  '/api/opencode/install-v2',
  '/api/push/subscribe',
  '/api/push/apns-token',
  '/api/push/vapid-public-key',
  '/api/passkeys',
  '/auth/passkey',
  '/connect',
  '/manifest.webmanifest',
  '/api/linear',
  '/linear/oauth',
  '/api/guests',
  '/api/guest-files',
  '/api/routing',
  '/api/config/plugins',
  '/api/plugin/check',
  '/api/plugin/update',
  '/api/magic-prompts',
  '/api/config/snippets',
  '/api/openchamber/spaces',
  '/api/spaces',
  '/api/config/skills/catalog/source',
  '/api/pair',
  '/api/openchamber/workflows',
  '/api/openchamber/secret',
  '/api/openchamber/space-task-title',
  '/api/experimental/persistent-pty/handoff',
]);

// One method on the exact path only: other methods, and the paths below, address a skill of that name.
export const CLOSED_ROUTES = Object.freeze([
  ['GET', '/api/config/skills/catalog'],
  ['POST', '/api/config/skills/scan'],
  ['POST', '/api/config/skills/install'],
]);

// One method on paths that carry an id; the project's and the terminal's other routes stay open.
export const CLOSED_PATTERNS = Object.freeze([
  ['PUT', /^\/api\/projects\/[^/]+\/config\/shared$/],
  ['POST', /^\/api\/pty\/[^/]+\/connect-token$/],
  ['POST', /^\/api\/experimental\/persistent-pty\/[^/]+\/connect-token$/],
  // The kernel's persistent terminals, which the app does not use. Creating one is what starts the kernel's terminal
  // daemon, whose sockets go under /tmp/opencode-pty-<uid>; the kernel's plugins can only read a terminal.
  ['POST', /^\/api\/experimental\/session\/[^/]+\/terminal$/],
]);

const decoded = (path) => {
  try {
    return decodeURI(path);
  } catch {
    return path; // the kernel cannot route it either
  }
};

// Express matches routes case-insensitively, and runs GET routes for HEAD, so the comparison must too. A path Express
// does not serve goes on to the kernel, whose router cuts it at `;`, decodes it and folds repeated slashes, so a variant
// such as `/api/pair;x` or `/api//pair` would reach a closed kernel route unless compared as the kernel reads it.
const isClosed = (req) => {
  const path = decoded(req.path.split(';', 1)[0]).replace(/\/{2,}/g, '/').toLowerCase();
  if (CLOSED_PATHS.some((closed) => path === closed || path.startsWith(`${closed}/`))) return true;
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const route = path.replace(/\/+$/, '');
  return CLOSED_ROUTES.some(([closedMethod, closed]) => method === closedMethod && route === closed)
    || CLOSED_PATTERNS.some(([closedMethod, pattern]) => method === closedMethod && pattern.test(route));
};

export const closedSurface = (req, res, next) => {
  if (!isClosed(req)) {
    next();
    return;
  }
  res.status(404).json({ error: 'Not available in this app' });
};
