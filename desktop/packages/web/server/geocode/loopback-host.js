// A DNS-rebinding page reaches the server under its own host name; the desktop app addresses it only as these.
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i;

// Reads the raw header: with trust proxy on, req.hostname would follow X-Forwarded-Host.
export const loopbackHostOnly = (req, res, next) => {
  if (!process.versions.electron || LOOPBACK_HOST.test(req.headers.host ?? '')) {
    next();
    return;
  }
  res.status(403).json({ error: 'Host not allowed' });
};
