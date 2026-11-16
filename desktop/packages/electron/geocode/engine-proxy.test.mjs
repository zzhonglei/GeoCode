import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withEngineProxy } from './engine-proxy.mjs';

// Guards against GeoEngine's downloads leaving the proxy behind, or taking a tile server on this computer through it.
test('GeoCode: GeoEngine downloads through the proxy, and from this computer directly', () => {
  const plain = withEngineProxy({ HTTPS_PROXY: 'http://proxy:7890' });
  assert.equal(plain.NODE_USE_ENV_PROXY, '1');
  assert.equal(plain.HTTPS_PROXY, 'http://proxy:7890');
  assert.equal(plain.NO_PROXY, 'localhost,127.0.0.1,::1');

  const own = withEngineProxy({ no_proxy: 'intranet.example, localhost' });
  assert.equal(own.no_proxy, 'intranet.example,localhost,127.0.0.1,::1');
  assert.ok(!('NO_PROXY' in own), 'the spelling the user wrote');
});
