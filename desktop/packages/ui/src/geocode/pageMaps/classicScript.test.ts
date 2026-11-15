import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { asClassicScript } from './classicScript';

// Guards a MapLibre upgrade the map pages' kit no longer reads: its build must still end in one export list and hold
// nothing that ends a script, or every map page would be drawn without MapLibre.
test('GeoCode: the app’s MapLibre becomes a classic script that sets maplibregl', () => {
  const source = readFileSync(createRequire(import.meta.url).resolve('maplibre-gl/dist/maplibre-gl.mjs'), 'utf8');
  const script = asClassicScript(source);
  // Compiled, not run: a script that no longer parses throws here.
  new Function(script);
  const exported = /self\.maplibregl=\{([^}]*)\}/.exec(script)?.[1] ?? '';
  for (const name of ['Map', 'setWorkerUrl']) expect(exported).toContain(`"${name}":`);
  expect(script.toLowerCase()).not.toContain('</script');
});
