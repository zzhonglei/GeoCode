import { expect, test } from 'bun:test';
import fs from 'node:fs';

import { GEO_TOOLS } from './geoTools';

// Guards against a geo tool the kernel adds or renames, which the conversation would show as an unknown tool.
test('GeoCode: the interface knows every geo tool the kernel has', () => {
  const kernel = new URL('../../../../../kernel/packages/core/src/geocode/', import.meta.url);
  const tools = fs.readdirSync(kernel)
    .filter((file) => file.endsWith('.ts'))
    .flatMap((file) => [...fs.readFileSync(new URL(file, kernel), 'utf8').matchAll(/^export const \w*[nN]ame = "(\w+)"$/gm)].map((match) => match[1]));
  expect([...GEO_TOOLS].sort()).toEqual(tools.sort());
});
