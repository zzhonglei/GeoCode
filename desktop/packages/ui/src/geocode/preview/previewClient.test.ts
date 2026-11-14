import { describe, expect, test } from 'bun:test';

import { tileAddress } from './previewClient';

// Guards a value taken for no data on its way to the server: -3.4e+38, the least of a band of 32-bit numbers and a
// common fill, has a `+` that an address reads as a space, and the value would be dropped while the panel says it is
// taken.
describe('GeoCode: a value taken for no data reaches the reader as the number it is', () => {
  test('written with its power of ten, it is read back from the address unchanged', () => {
    const least = -3.4028234663852886e38;
    const address = tileAddress({ path: '/a.tif' }, 's', { blank: least });
    expect(Number(new URL(address.replace(/^[^:]+:\/\//, 'http://x/')).searchParams.get('blank'))).toBe(least);
  });
});
