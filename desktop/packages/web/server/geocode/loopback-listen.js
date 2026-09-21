/* --- GeoCode: supertest binds with `listen(0)`, which takes an ephemeral port on `::`, and then dials
 * `127.0.0.1`. The two address families hand out ports separately, so the port it picked can already
 * belong to another process on IPv4 and the request goes there instead: measured answers include 501,
 * 401 and a closed socket (docs/CONVENTIONS.md). This makes it dial whatever the server actually bound.
 * ⚠️ binding the loopback address instead does not work: `listen(port, host)` resolves the host, which
 * defers the bind, and supertest reads `address()` on the next line. Test-only, loaded by setupFiles. --- */

import { Server as HttpsServer } from 'node:https';
import Test from 'supertest/lib/test.js';

Test.prototype.serverAddress = function serverAddressInOneFamily(app, path) {
  if (!app.address()) this._server = app.listen(0);
  const { port, family, address } = app.address();
  // An unspecified bind covers its own loopback, and that is the address whose ports it was given.
  const host = family === 'IPv6'
    ? `[${address === '::' ? '::1' : address}]`
    : (address === '0.0.0.0' ? '127.0.0.1' : address);
  // The scheme test is upstream's: a supertest app is the server itself when it is an https one.
  return `${app instanceof HttpsServer ? 'https' : 'http'}://${host}:${port}${path}`;
};
