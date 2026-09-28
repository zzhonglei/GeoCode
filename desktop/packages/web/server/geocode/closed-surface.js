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
]);

// Express matches routes case-insensitively, so the comparison must too.
const isClosedPath = (pathname) => {
  const path = pathname.toLowerCase();
  return CLOSED_PATHS.some((closed) => path === closed || path.startsWith(`${closed}/`));
};

export const closedSurface = (req, res, next) => {
  if (!process.versions.electron || !isClosedPath(req.path)) {
    next();
    return;
  }
  res.status(404).json({ error: 'Not available in this app' });
};
