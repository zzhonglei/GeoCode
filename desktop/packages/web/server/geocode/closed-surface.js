// Answered here because an unmatched /api path would fall through to the OpenCode proxy.
const CLOSED_PATHS = Object.freeze([
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
  '/api/routing',
  '/api/config/plugins',
  '/api/plugin/check',
  '/api/plugin/update',
  '/api/magic-prompts',
  '/api/config/snippets',
  '/api/openchamber/spaces',
  '/api/spaces',
  '/api/config/skills/catalog/source',
]);

// One method on the exact path only: other methods, and the paths below, address a skill of that name.
const CLOSED_ROUTES = Object.freeze([
  ['GET', '/api/config/skills/catalog'],
  ['POST', '/api/config/skills/scan'],
  ['POST', '/api/config/skills/install'],
]);

// Express matches routes case-insensitively, and runs GET routes for HEAD, so the comparison must too.
const isClosed = (req) => {
  const path = req.path.toLowerCase();
  if (CLOSED_PATHS.some((closed) => path === closed || path.startsWith(`${closed}/`))) return true;
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const route = path.replace(/\/+$/, '');
  return CLOSED_ROUTES.some(([closedMethod, closed]) => method === closedMethod && route === closed);
};

export const closedSurface = (req, res, next) => {
  if (!isClosed(req)) {
    next();
    return;
  }
  res.status(404).json({ error: 'Not available in this app' });
};
